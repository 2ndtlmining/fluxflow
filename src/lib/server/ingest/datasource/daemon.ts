/**
 * `fluxd` RPC shapes, as published over HTTP by FluxOS.
 *
 * FluxOS wraps every daemon reply in an envelope — `{"status":"success","data":…}` or
 * `{"status":"error","data":{"message":…}}` — and, on most daemon routes, caches responses
 * for 30 seconds. Neither is obvious from the daemon's own JSON-RPC types, and getting the
 * envelope wrong is how you end up treating an error body as a block with no transactions.
 *
 * These are declarations of what we *consume*, not a copy of fluxd's structs. Anything not
 * needed for ingestion is omitted, so an unexpected extra field is never a surprise.
 */

/**
 * The FluxOS reply envelope.
 *
 * Declared with the index signature because the real replies carry more than this — `code`
 * and `name` on errors, for instance — and a fixture recording an actual response must not
 * have to be trimmed to satisfy a type. Anything present is simply not read.
 */
export interface DaemonEnvelope<T> {
  status: 'success' | 'error';
  data: T;
  /** Present on some error replies. */
  message?: string;
  [key: string]: unknown;
}

export interface DaemonErrorBody {
  message?: string;
  code?: number;
  name?: string;
}

/**
 * A `vin` entry as returned by `getblock` at verbosity 2.
 *
 * `address` and `valueSat` are present **only on nodes running `insightexplorer=1`**. On
 * everything else a spent input is just `{ txid, vout }`, which is the whole reason this
 * project has to probe for capability rather than assume it (#35).
 */
export interface DaemonVin {
  txid?: string;
  vout?: number;
  /** Coinbase inputs carry the block subsidy text here and no txid. */
  coinbase?: string;
  scriptSig?: { asm?: string; hex?: string };
  sequence?: number;
  /** Insight-only. */
  address?: string;
  /** Insight-only. In satoshis. Prefer this over `value` (#15). */
  valueSat?: number | string;
  /** In FLUX. 100,000,000x smaller than the satoshi figure for the same output. */
  value?: number | string;
}

export interface DaemonVoutScript {
  asm?: string;
  hex?: string;
  reqSigs?: number;
  type?: string;
  /** Absent for OP_RETURN and other non-standard scripts. */
  addresses?: string[];
}

export interface DaemonVout {
  /** In FLUX. */
  value?: number | string;
  /** In satoshis. What we use. */
  valueSat?: number | string;
  n: number;
  scriptPubKey?: DaemonVoutScript;
}

export interface DaemonTx {
  txid: string;
  vin?: DaemonVin[];
  vout?: DaemonVout[];
  blocktime?: number;
  blockheight?: number;
  /** FLUX node confirmations carry a `type` field that is not standard Bitcoin. */
  type?: string;
  /** Present on some builds in place of `type`. */
  kind?: string;
  /** A node confirmation names the collateral it locks. Recorded, never interpreted. */
  collateral_output?: string;
  [key: string]: unknown;
}

export interface DaemonBlock {
  hash: string;
  height: number;
  time: number;
  /** Absent on the genesis block only. */
  previousblockhash?: string;
  nextblockhash?: string;
  confirmations?: number;
  size?: number;
  merkleroot?: string;
  tx?: DaemonTx[];
  txCount?: number;
}

/**
 * One transaction's contribution to the block, from `getblockdeltas`.
 *
 * Note the nesting: the reply is `{ data: { deltas: [ … ] } }`, not the flat
 * `{ inputs, outputs }` shape the issue text describes. Measured against live nodes, which
 * is the only reason this is right.
 */
export interface DaemonTxDelta {
  txid: string;
  /** Index of this tx within the block. */
  index?: number;
  /** `satoshis` is negative, which is what carries the direction. */
  inputs?: {
    address?: string;
    satoshis?: number;
    index?: number;
    prevtxid?: string;
    prevout?: number;
  }[];
  /** `satoshis` is positive. */
  outputs?: { address?: string; satoshis?: number; index?: number }[];
}

export interface DaemonBlockDeltas {
  hash: string;
  height?: number;
  previousblockhash?: string;
  time?: number;
  /** Per-transaction deltas. Empty on a block with no value movement. */
  deltas?: DaemonTxDelta[];
}

/** `getblockcount` returns the height as a bare number in `data`. */
export type DaemonBlockCount = number;

/** `getblockhash` returns the hash as a bare string in `data`. */
export type DaemonBlockHash = string;

/** Unwrap the FluxOS envelope, turning an error body into a thrown `Error`. */
export function unwrap<T>(url: string, envelope: DaemonEnvelope<T>): T {
  if (envelope?.status === 'success') return envelope.data;

  const message =
    (envelope as DaemonErrorBody | undefined)?.message ??
    (envelope as { data?: DaemonErrorBody } | undefined)?.data?.message;

  throw new Error(
    `fluxd error from ${url}${message ? `: ${message}` : ''} (status=${String(envelope?.status)})`
  );
}

/**
 * Whether a `getblock` reply carries spent-input addresses.
 *
 * The probe is for presence, not value: a node without the spent index returns `vin`
 * entries with only `txid`/`vout`. This is what separates a node that can serve a whole
 * block from one that can only serve a tip (#35).
 */
export function hasInputAddresses(block: DaemonBlock): boolean {
  for (const tx of block.tx ?? []) {
    for (const vin of tx.vin ?? []) {
      // A coinbase has no previous output to resolve, so it says nothing about capability.
      if (vin.coinbase !== undefined) continue;
      if (vin.address !== undefined || vin.valueSat !== undefined) return true;
    }
  }

  return false;
}
