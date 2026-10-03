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

/** A label lookup. Matches `LabelLookup` in `$lib/server/labels`. */
export interface Resolver {
  kindOf(address: string): AddressKind;
  nameOf(address: string): string | null;
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
  const deltas = toValueDeltas(tx);

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

  for (const recipient of recipients) {
    const from = pickFunder(funders, recipient, resolve);
    if (!from) continue;

    rows.push({
      txid: tx.txid,
      vout: vout++,
      height,
      time,
      fromAddress: from.address,
      fromKind: resolve.kindOf(from.address),
      toAddress: recipient.address,
      toKind: resolve.kindOf(recipient.address),
      exchange: exchangeName(from, recipient, resolve),
      flowType: classifyFlow(resolve.kindOf(from.address), resolve.kindOf(recipient.address)),
      sat: recipient.sat
    });
  }

  return rows;
}

/**
 * Choose the funder for a recipient.
 *
 * Prefer a funder we can *name*. An exchange consolidating its own deposits together with a
 * stranger's coins should be attributed to the exchange, not to the stranger — and "the
 * address we happen to list first" is not an attribution rule.
 */
function pickFunder(
  funders: { address: string; sat: number }[],
  recipient: { address: string; sat: number },
  resolve: Resolver
): { address: string; sat: number } | null {
  if (funders.length === 0) return null;

  const named = funders.filter((funder) => resolve.kindOf(funder.address) !== 'unknown');
  const pool = named.length > 0 ? named : funders;

  // Smallest sufficient funder: the most specific explanation for this output.
  const sufficient = pool.filter((funder) => funder.sat >= recipient.sat);

  return [...(sufficient.length > 0 ? sufficient : pool)].sort((a, b) => a.sat - b.sat)[0] ?? null;
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
  resolve: Resolver
): string | null {
  const exchangeOf = (address: string): string | null =>
    resolve.kindOf(address) === 'exchange' ? resolve.nameOf(address) : null;

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
