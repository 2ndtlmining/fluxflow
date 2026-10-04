/**
 * Turning a fetched block into database rows.
 *
 * Pure functions, no I/O: given a normalised block and the current label set, produce the
 * facts to store. Keeping this separate from the writer is what makes the interesting rules
 * — which transfers count, who the counterparty is, how change outputs are handled — testable
 * without a database.
 */

import type { AddressKind, NormalisedBlock, NormalisedTx } from './datasource/types.js';
import { checkConservation, toValueDeltas } from './datasource/types.js';
import { SATS_PER_FLUX } from './datasource/types.js';

const SECONDS_PER_DAY = 86_400;

/**
 * A label lookup. Matches `LabelLookup` in `$lib/server/labels`.
 *
 * `time` is the block time: a label can be valid only for a window (a node operator who
 * stopped running nodes), so a flow is classified by what the address was *then* (#18).
 */
export interface Resolver {
  kindOf(address: string, time?: number): AddressKind;
  nameOf(address: string, time?: number): string | null;
}

export interface DeltaRow {
  readonly txid: string;
  readonly address: string;
  readonly height: number;
  readonly time: number;
  readonly satIn: number;
  readonly satOut: number;
}

export interface FlowRow {
  readonly txid: string;
  readonly vout: number;
  readonly height: number;
  readonly time: number;
  readonly fromAddress: string;
  readonly fromKind: AddressKind;
  readonly toAddress: string;
  readonly toKind: AddressKind;
  readonly exchange: string | null;
  readonly flowType: 'buying' | 'selling' | 'p2p';
  readonly sat: number;
}

export interface NodeRewardRow {
  readonly address: string;
  readonly height: number;
  readonly day: number;
  readonly rewardCount: number;
  readonly sat: number;
}

export interface DerivedBlock {
  readonly height: number;
  readonly hash: string;
  readonly prevHash: string | null;
  readonly time: number;
  readonly txCount: number;
  readonly source: string;
  readonly deltas: DeltaRow[];
  readonly flows: FlowRow[];
  readonly nodeRewards: NodeRewardRow[];
  /** Non-fatal problems worth logging: conservation violations, incomplete transfers. */
  readonly warnings: string[];
  /**
   * True when a transfer could not be detailed. Such a block must not be committed: its
   * block row would mark the height done with a buy or sell missing for good (#14), so the
   * pipeline records the height as missing and retries it instead.
   */
  readonly incomplete: boolean;
}

/**
 * Derive every row for one block.
 *
 * `source` is recorded on the block row so it is always possible to say which node a piece
 * of data came from — which is what makes a mixed-source backfill auditable (#12).
 */
export function deriveBlock(
  block: NormalisedBlock,
  source: string,
  resolve: Resolver
): DerivedBlock {
  const deltas: DeltaRow[] = [];
  const flows: FlowRow[] = [];
  const rewardTotals = new Map<string, { day: number; count: number; sat: number }>();
  const warnings: string[] = [];
  let incomplete = false;

  for (const tx of block.transactions) {
    if (!tx.complete) {
      // The indexer declined to detail this transfer. Recording nothing here and flagging
      // the block means the pipeline retries it rather than writing a half block.
      warnings.push(`tx ${tx.txid || '(unknown)'}: incomplete, skipped`);
      incomplete = true;
      continue;
    }

    const violation = checkConservation(tx);
    if (violation) warnings.push(violation);

    for (const delta of toValueDeltas(tx)) {
      deltas.push({
        txid: tx.txid,
        address: delta.address,
        height: block.height,
        time: block.time,
        satIn: delta.satIn,
        satOut: delta.satOut
      });
    }

    if (tx.kind === 'coinbase') {
      collectCoinbase(tx, block, rewardTotals);
      continue;
    }

    if (tx.kind !== 'transfer') continue;

    for (const flow of deriveFlows(tx, block.height, block.time, resolve)) {
      flows.push(flow);
    }
  }

  return {
    height: block.height,
    hash: block.hash,
    prevHash: block.prevHash,
    time: block.time,
    txCount: block.txCount,
    source,
    deltas,
    flows,
    nodeRewards: [...rewardTotals].map(([address, totals]) => ({
      address,
      height: block.height,
      day: totals.day,
      rewardCount: totals.count,
      sat: totals.sat
    })),
    warnings,
    incomplete
  };
}

/**
 * Turn one transfer into zero or more flow rows.
 *
 * Amounts are **net**: an address's outgoing value is `sat_in - sat_out` and its incoming
 * value is `sat_out - sat_in`. That matters whenever one address appears on both sides of
 * the same transaction — a wallet paying itself *and* someone else nets to exactly the
 * external amount and needs no special case, while a pure self-transfer nets to zero and
 * correctly produces no flow at all.
 *
 * v1 emitted one flow event per output using a single "primary input" address, so a
 * transaction consolidating three wallets' coins recorded the whole amount as coming from
 * whichever address happened to be first. Here the deltas are matched explicitly.
 */
export function deriveFlows(
  tx: NormalisedTx,
  height: number,
  time: number,
  resolve: Resolver
): FlowRow[] {
  return flowsFromDeltas(tx.txid, height, time, toValueDeltas(tx), resolve);
}

/**
 * Flows from one transaction's per-address deltas.
 *
 * Shared by ingestion and by re-derivation after a label change (`intel/relabel.ts`), which
 * rebuilds the deltas from `tx_deltas`. The deltas are sorted by address first, so both
 * paths produce identical rows — including how a rounding satoshi is shared and which `vout`
 * each row gets — whatever order they arrived in.
 *
 * Each recipient yields one row per funder, carrying that funder's share of the output
 * ({@link splitByFunder}).
 *
 * A transfer between two Foundation wallets produces no flow at all: moving money between
 * its own wallets is neither buying nor selling, and counted as p2p it dwarfed every real
 * p2p figure (#31).
 */
export function flowsFromDeltas(
  txid: string,
  height: number,
  time: number,
  values: readonly { address: string; satIn: number; satOut: number }[],
  resolve: Resolver
): FlowRow[] {
  const deltas = [...values].sort((a, b) =>
    a.address < b.address ? -1 : a.address > b.address ? 1 : 0
  );
  const kindOf = (address: string) => resolve.kindOf(address, time);

  // Net out: addresses that funded the transaction more than they got back.
  const funders = deltas
    .filter((delta) => delta.satIn - delta.satOut > 0)
    .map((delta) => ({ address: delta.address, sat: delta.satIn - delta.satOut }));

  // Net in: addresses that received more than they put in.
  const recipients = deltas
    .filter((delta) => delta.satOut - delta.satIn > 0)
    .map((delta) => ({ address: delta.address, sat: delta.satOut - delta.satIn }));

  if (recipients.length === 0 || funders.length === 0) return [];

  const rows: FlowRow[] = [];
  let vout = 0;

  const payers = capFunders(funders, recipients.length);
  const toKinds = recipients.map((recipient) => kindOf(recipient.address));
  const fromKinds = payers.map((funder) => kindOf(funder.address));

  recipients.forEach((recipient, r) => {
    const toKind = toKinds[r]!;
    const shares = splitByFunder(recipient.sat, payers);

    payers.forEach((from, f) => {
      const sat = shares[f]!;
      const fromKind = fromKinds[f]!;
      if (sat <= 0 || (fromKind === 'foundation' && toKind === 'foundation')) return;

      rows.push({
        txid,
        vout: vout++,
        height,
        time,
        fromAddress: from.address,
        fromKind,
        toAddress: recipient.address,
        toKind,
        exchange: exchangeName(from, recipient, resolve, time),
        flowType: classifyFlow(fromKind, toKind),
        sat
      });
    });
  });

  return rows;
}

/** Above this many funder × recipient pairs, the smallest funders are folded away. */
export const MAX_FLOWS_PER_TX = 5_000;

/**
 * Keep at most enough funders that one transaction yields {@link MAX_FLOWS_PER_TX} rows.
 *
 * Real transactions stay far below it (the largest seen is a 500-input consolidation into
 * one output). Beyond it the largest funders are kept, in their original order, and the
 * dropped funders' share is spread over them in proportion: a bounded, documented
 * approximation instead of an unbounded number of rows.
 */
function capFunders<T extends { sat: number }>(funders: readonly T[], recipients: number): T[] {
  const keep = Math.max(1, Math.floor(MAX_FLOWS_PER_TX / recipients));
  if (funders.length <= keep) return [...funders];

  const kept = new Set([...funders].sort((a, b) => b.sat - a.sat).slice(0, keep));
  return funders.filter((funder) => kept.has(funder));
}

/**
 * Split one recipient's amount across the transaction's funders by their share of the input.
 *
 * Every input pays into every output in the same proportion, so a funder that put in 40% of
 * the value is credited with 40% of each output — and the fee falls on everyone alike.
 * Choosing one funder per output instead credited a GateIO sweep of ten deposit addresses
 * (53,488 FLUX) entirely to the address that put in 2.85 FLUX.
 *
 * Exact in integers: BigInt products (sat × sat overflows a double) and largest-remainder
 * rounding, ties to the earlier funder, so the shares always sum to `sat` exactly.
 */
export function splitByFunder(sat: number, funders: readonly { sat: number }[]): number[] {
  if (funders.length === 1) return [sat];

  const total = funders.reduce((sum, funder) => sum + BigInt(funder.sat), 0n);
  if (total <= 0n) return funders.map(() => 0);

  const amount = BigInt(sat);
  const shares = funders.map((funder) => (amount * BigInt(funder.sat)) / total);
  const remainders = funders.map((funder, index) => ({
    index,
    rest: (amount * BigInt(funder.sat)) % total
  }));

  let left = Number(amount - shares.reduce((sum, share) => sum + share, 0n));
  remainders.sort((a, b) => (b.rest > a.rest ? 1 : b.rest < a.rest ? -1 : a.index - b.index));
  for (const { index } of remainders) {
    if (left <= 0) break;
    shares[index]! += 1n;
    left--;
  }

  return shares.map(Number);
}

/**
 * The exchange name for a flow: the source when buying, the destination when selling.
 *
 * Only an *exchange* label counts. A named node operator or Foundation wallet is not an
 * exchange, and putting its name in this column credited a sale to Kucoin as a sale to
 * "Girder Works" — and dropped it from Kucoin's totals.
 */
function exchangeName(
  from: { address: string },
  to: { address: string },
  resolve: Resolver,
  time: number
): string | null {
  const exchangeOf = (address: string): string | null =>
    resolve.kindOf(address, time) === 'exchange' ? resolve.nameOf(address, time) : null;

  return exchangeOf(from.address) ?? exchangeOf(to.address);
}

export function classifyFlow(fromKind: AddressKind, toKind: AddressKind): FlowRow['flowType'] {
  if (fromKind === 'exchange' && toKind !== 'exchange') return 'buying';
  if (toKind === 'exchange' && fromKind !== 'exchange') return 'selling';
  return 'p2p';
}

/**
 * Record who received a mining reward.
 *
 * A reward proves the address was mining at that moment, which answers "was a node
 * operator" with a date instead of a guess (#18, #19) — and it comes for free from blocks
 * we already fetch, so no historical API calls are needed.
 *
 * Keyed by `(address, height)` rather than by day so that re-syncing a block overwrites its
 * row instead of adding to it. An additive daily total would double-count on every repair.
 */
function collectCoinbase(
  tx: NormalisedTx,
  block: NormalisedBlock,
  totals: Map<string, { day: number; count: number; sat: number }>
): void {
  const day = Math.floor(block.time / SECONDS_PER_DAY) * SECONDS_PER_DAY;

  for (const output of tx.outputs) {
    if (!output.address || output.nulldata) continue;

    const existing = totals.get(output.address);
    if (existing) {
      existing.count++;
      existing.sat += output.sat;
    } else {
      totals.set(output.address, { day, count: 1, sat: output.sat });
    }
  }
}

/** Reassemble a derived block into something a writer can store. */
export function countDerived(derived: DerivedBlock): {
  deltas: number;
  flows: number;
  rewards: number;
} {
  return {
    deltas: derived.deltas.length,
    flows: derived.flows.length,
    rewards: derived.nodeRewards.length
  };
}

/** Total FLUX moved by a derived block, for logging. */
export function derivedVolume(derived: DerivedBlock): number {
  return derived.flows.reduce((sum, flow) => sum + flow.sat, 0) / SATS_PER_FLUX;
}
