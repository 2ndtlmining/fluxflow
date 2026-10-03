/**
 * Recorded daemon responses.
 *
 * Shapes taken from fluxd's `getblock` verbosity 2 and `getblockdeltas`, and trimmed. The
 * point of the `nonInsight` fixture is that it is *shaped correctly but wrong* — the same
 * block with no input addresses — because that is the failure that would silently produce
 * flows with no counterparty if the pool did not probe for capability (#15, #35).
 *
 * Kept as data rather than constructed in tests so a change in the real daemon's shape
 * shows up as a test failure rather than as a quietly adapted expectation.
 */

import type { DaemonBlock, DaemonBlockDeltas, DaemonEnvelope, DaemonErrorBody } from './daemon.js';

const HASH_1000 = 'a'.repeat(64);
const HASH_999 = 'b'.repeat(64);

/** A block from a node running `insightexplorer=1`: inputs carry address and `valueSat`. */
export const INSIGHT_BLOCK: DaemonBlock = {
  hash: HASH_1000,
  height: 1_000,
  time: 1_756_000_000,
  previousblockhash: HASH_999,
  txCount: 2,
  tx: [
    {
      txid: 'cb-1000',
      kind: 'coinbase',
      vin: [{ coinbase: '03a0860104', sequence: 0xffffffff }],
      vout: [
        {
          // `value` is FLUX and `valueSat` is satoshis. Reading the wrong one is a
          // 100,000,000x error that still looks like a plausible amount (#15).
          value: 0.00003,
          valueSat: 3_000,
          n: 0,
          scriptPubKey: {
            type: 'pubkeyhash',
            addresses: ['t1nodeoperator0001']
          }
        }
      ]
    },
    {
      txid: 'tx-1000-1',
      kind: 'transfer',
      vin: [{ txid: 'prev-tx', vout: 3, address: 't1exchange00001', valueSat: 500_000 }],
      vout: [
        {
          value: 0.005,
          valueSat: 500_000,
          n: 0,
          scriptPubKey: { type: 'pubkeyhash', addresses: ['t1whale00000001'] }
        },
        {
          // OP_RETURN: an address-less, unspendable output. Must never become a flow.
          value: 0,
          valueSat: 0,
          n: 1,
          scriptPubKey: { type: 'nulldata', hex: '6a' }
        }
      ]
    }
  ]
};

/**
 * The same block from a node **without** the spent index: `vin` has no `address` and no
 * `valueSat`, so the sender is unknowable.
 */
export const NON_INSIGHT_BLOCK: DaemonBlock = {
  ...INSIGHT_BLOCK,
  tx: [
    (INSIGHT_BLOCK.tx ?? [])[0]!,
    {
      txid: 'tx-1000-1',
      kind: 'transfer',
      vin: [{ txid: 'prev-tx', vout: 3, sequence: 0xffffffff }],
      vout: (INSIGHT_BLOCK.tx ?? [])[1]!.vout
    }
  ]
};

/**
 * The leaner format a node with the spent index offers: per-address deltas, no scripts.
 *
 * Recorded from a live node. Note the nesting under `deltas` with one entry per
 * transaction — the flat `{ inputs, outputs }` shape the issue text describes is not what
 * the daemon actually returns, and a parser written to it silently reads an empty block.
 */
export const BLOCK_DELTAS: DaemonBlockDeltas = {
  hash: HASH_1000,
  height: 1_000,
  previousblockhash: HASH_999,
  deltas: [
    {
      txid: 'cb-1000',
      index: 0,
      // A coinbase has no inputs, so this entry carries outputs only.
      inputs: [],
      outputs: [{ address: 't1nodeoperator0001', satoshis: 3_000, index: 0 }]
    },
    {
      txid: 'tx-1000-1',
      index: 1,
      // `satoshis` is negative for inputs: the sign is what carries the direction.
      inputs: [{ address: 't1exchange00001', satoshis: -500_000, prevtxid: 'prev-tx', prevout: 3 }],
      outputs: [{ address: 't1whale00000001', satoshis: 500_000, index: 0 }]
    }
  ]
};

/**
 * A block with no transfers at all — the common case, since most FLUX blocks hold only the
 * coinbase and node confirmations.
 *
 * This is the fixture that matters: probing capability by fetching a block and looking for a
 * resolved input reports every node on a quiet chain as incapable. It is what the live
 * network did on first contact — 39 nodes answered, 0 were marked capable.
 */
export const QUIET_BLOCK: DaemonBlock = {
  hash: HASH_1000,
  height: 1_000,
  time: 1_756_000_000,
  previousblockhash: HASH_999,
  txCount: 13,
  tx: [
    {
      txid: 'cb-1000',
      vin: [{ coinbase: '03a0860104' }],
      vout: [
        {
          valueSat: 50_000_000,
          n: 0,
          scriptPubKey: { type: 'scripthash', addresses: ['t3hPu1YDeGUCp8m7BQCnnNUmRMJBa5RadyA'] }
        }
      ]
    },
    // A node confirmation: a tx with no vin and no vout at all.
    {
      txid: 'nc-1',
      type: 'Confirming a fluxnode',
      collateral_output: 'COutPoint(2c7ab24e88, 0)'
    }
  ]
};

/** An error body as FluxOS returns one, e.g. `getblockdeltas` on a non-insight node. */
export const DISABLED_ERROR: DaemonEnvelope<DaemonErrorBody> = {
  status: 'error',
  data: { message: 'getblockdeltas is disabled, run with insightexplorer=1' },
  message: 'getblockdeltas is disabled, run with insightexplorer=1',
  code: -1
};

/**
 * A node list shaped like the explorer's live `getFluxNodes` response.
 *
 * Recorded from the real endpoint, including the details that matter and are easy to get
 * wrong: the top-level key is `fluxNodes` (not `data.nodes`), entries carry an **inline
 * API port** (`24.108.153.230:16147`, which is how UPnP nodes publish themselves), the tier
 * values are `CUMULUS`/`STRATUS` rather than the names in the issue text, and roughly half
 * the list is not a usable address at all.
 */
export const NODE_LIST = {
  fluxNodes: [
    {
      ip: '80.241.213.220',
      network: 'ipv4',
      tier: 'CUMULUS',
      payment_address: 't1NPdVvHG8v1EXu8r4pgTcbDWgJEBfNmwge',
      last_confirmed_height: 3_002_888,
      rank: 0
    },
    {
      // Inline port. Probing only the default ports would miss every node published this
      // way, which on the live list is a large share of them.
      ip: '24.108.153.230:16147',
      network: 'ipv4',
      tier: 'CUMULUS',
      payment_address: 't1anotheroperator',
      last_confirmed_height: 3_002_880
    },
    {
      ip: '185.13.30.13',
      network: 'ipv4',
      tier: 'STRATUS',
      payment_address: 't1nodeop13'
    },
    // Unusable entries, all of which appear in the real response and all of which must be
    // ignored rather than turned into doomed requests.
    { ip: 'not-an-ip', tier: 'CUMULUS' },
    { ip: '127.0.0.1', tier: 'CUMULUS' },
    { ip: '0.0.0.0', tier: 'CUMULUS' },
    { ip: '169.254.1.1', tier: 'CUMULUS' },
    { ip: '999.1.1.1', tier: 'CUMULUS' },
    // A duplicate: the same node must not be probed twice.
    { ip: '80.241.213.220', tier: 'CUMULUS' }
  ]
};

export const HASHES = { 1000: HASH_1000, 999: HASH_999 };
