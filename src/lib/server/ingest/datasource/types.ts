/**
 * The normalised chain shapes every data source must produce.
 *
 * v1 had no such boundary: `Blocksyncservice.processBlock()` branched on which source was
 * active and read whichever field happened to be present — `scriptPubKey.addresses` from
 * the indexer versus `addresses` from Blockbook, and `value` in satoshis from one and
 * possibly FLUX from the other (#15). A batch could contain blocks from both sources, and
 * an off-by-1e8 error would have been completely silent.
 *
 * Everything below is in satoshis. There is exactly one unit in this codebase.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Values
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which unit a source reports amounts in.
 *
 * This is declared per adapter from the API's own documentation, never inferred from the
 * magnitude of the numbers — a value that looks "too small" is not evidence of anything,
 * and a 1 FLUX transfer is legitimately `1`.
 */
export type ValueUnit = 'sat' | 'flux';

export const SATS_PER_FLUX = 100_000_000;

/**
 * Convert a source-reported amount to satoshis.
 *
 * @throws {RangeError} for values that cannot be a real amount, so a malformed response
 * fails loudly instead of writing a plausible-looking wrong number.
 */
export function toSat(value: number | string | undefined | null, unit: ValueUnit): number {
  if (value === undefined || value === null) return 0;

  const numeric = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(numeric)) {
    throw new RangeError(`non-numeric amount: ${JSON.stringify(value)}`);
  }

  if (numeric < 0) {
    throw new RangeError(`negative amount: ${numeric}`);
  }

  const sat = unit === 'sat' ? numeric : numeric * SATS_PER_FLUX;

  if (!Number.isSafeInteger(Math.round(sat))) {
    throw new RangeError(`amount out of safe integer range: ${numeric} ${unit}`);
  }

  return Math.round(sat);
}

/** Render satoshis as a FLUX string with 8 decimals, for display only. */
export function formatFlux(sat: number): string {
  return (sat / SATS_PER_FLUX).toFixed(8);
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalised shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface NormalisedInput {
  /** `null` when the input's previous output script cannot be resolved to an address. */
  readonly address: string | null;
  readonly sat: number;
  /** Index into the owning transaction's outputs, when the source provides it. */
  readonly vout: number | null;
}

export interface NormalisedOutput {
  /** Output index within the transaction. */
  readonly n: number;
  readonly address: string | null;
  readonly sat: number;
  /**
   * `OP_RETURN` and other provably unspendable outputs. These are not counterparty
   * transfers and must not become flow events — v1 emitted a flow event for every output
   * with an address but also counted nulldata txs towards "total".
   */
  readonly nulldata: boolean;
}

export type TransactionKind = 'transfer' | 'coinbase' | 'node_confirm' | 'other';

export interface NormalisedTx {
  readonly txid: string;
  readonly kind: TransactionKind;
  readonly inputs: readonly NormalisedInput[];
  readonly outputs: readonly NormalisedOutput[];
  /**
   * `false` when the source returned a summary only and the adapter had to skip
   * enrichment. The pipeline must treat such a block as incomplete rather than silently
   * writing partial flows (#14/#15).
   */
  readonly complete: boolean;
}

export interface NormalisedBlock {
  readonly height: number;
  readonly hash: string;
  readonly prevHash: string | null;
  /** Unix seconds. */
  readonly time: number;
  readonly txCount: number;
  readonly transactions: readonly NormalisedTx[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The data source contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A source of chain data.
 *
 * Implementations must be safe to call concurrently: the ingest pipeline shares one
 * limiter across all of them.
 */
export interface DataSource {
  /** Stable identifier, stored on every `blocks` row for traceability (#12). */
  readonly id: string;
  /** Human-readable description for logs and the status endpoint. */
  readonly description: string;

  /** Current chain tip. */
  getTip(): Promise<number>;

  /**
   * Fetch a whole block, including every transaction, normalised to satoshis.
   *
   * Implementations must not truncate the transaction list. #15 was a
   * `TRANSACTION_FETCH_LIMIT` of 50 (indexer) / 20 (Blockbook) that silently dropped
   * every transfer past that point in the block.
   *
   * @throws {HttpError} on a transport failure; callers record the height as missing so it
   * is retried rather than skipped (#13).
   */
  getBlock(height: number): Promise<NormalisedBlock>;

  /**
   * Cheap liveness probe used by the circuit breaker to decide whether to try a source
   * again. Must not throw; return `false` rather than raising.
   */
  isHealthy(): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow derivation
// ─────────────────────────────────────────────────────────────────────────────

export type FlowType = 'buying' | 'selling' | 'p2p';
export type AddressKind = 'exchange' | 'foundation' | 'node_operator' | 'unknown';

export interface ValueDelta {
  readonly address: string;
  satIn: number;
  satOut: number;
}

/**
 * Collapse a transaction into one row per address.
 *
 * This is the transformation that becomes `tx_deltas`. Inputs from the same address are
 * summed, which is what makes a multi-input consolidation behave.
 */
export function toValueDeltas(tx: NormalisedTx): ValueDelta[] {
  const byAddress = new Map<string, ValueDelta>();

  const touch = (address: string): ValueDelta => {
    let delta = byAddress.get(address);
    if (!delta) {
      delta = { address, satIn: 0, satOut: 0 };
      byAddress.set(address, delta);
    }
    return delta;
  };

  for (const input of tx.inputs) {
    if (input.address) touch(input.address).satIn += input.sat;
  }

  for (const output of tx.outputs) {
    if (output.address) touch(output.address).satOut += output.sat;
  }

  // Only addresses that actually moved value, and never a zero-value row.
  return [...byAddress.values()].filter((delta) => delta.satIn > 0 || delta.satOut > 0);
}

/**
 * Decide whether a transaction is worth keeping.
 *
 * A transfer matters only if it touches an address we can name. Everything else — the
 * coinbase, node confirmations, a transfer between two wallets we know nothing about — can
 * be dropped before it ever reaches the database.
 */
export function isRelevantTx(tx: NormalisedTx, kindOf: (address: string) => AddressKind): boolean {
  if (tx.kind !== 'transfer') return false;

  return (
    tx.inputs.some((input) => input.address && kindOf(input.address) !== 'unknown') ||
    tx.outputs.some((output) => output.address && kindOf(output.address) !== 'unknown')
  );
}

/**
 * Sanity-check a transaction's arithmetic.
 *
 * Output total must not exceed input total; the difference is the miner's fee. A source
 * reporting the wrong unit produces a violation here, which is why the unit is asserted
 * rather than assumed — an off-by-1e8 is otherwise completely silent (#15).
 *
 * @returns `null` when the transaction is consistent, otherwise a diagnostic.
 */
export function checkConservation(tx: NormalisedTx): string | null {
  const inputTotal = tx.inputs.reduce((sum, input) => sum + input.sat, 0);
  const outputTotal = tx.outputs.reduce((sum, output) => sum + output.sat, 0);

  if (inputTotal === 0 && outputTotal > 0) {
    return `tx ${tx.txid}: outputs (${outputTotal} sat) with no inputs — missing input data or wrong value unit`;
  }

  if (outputTotal > inputTotal) {
    return `tx ${tx.txid}: outputs ${outputTotal} sat exceed inputs ${inputTotal} sat — likely a value unit mismatch`;
  }

  return null;
}
