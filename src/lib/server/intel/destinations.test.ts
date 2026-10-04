import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestConfig, createTestDb, silentLogger, type Db } from '../testkit.js';
import { replaceSourceLabels, type LabelLookup } from '../labels.js';
import { foundationReport } from './foundation.js';
import { traceFoundation } from './destinations.js';
import { detectIntermediaries, INTERMEDIARY_SOURCE } from './intermediaries.js';
import { parseCollateralTxids } from './nodes.js';
import { Relabeler } from './relabel.js';
import { IntelService } from './service.js';
import { labelBook, writeChain, type SimpleTx } from './testchain.js';

const FOUND = 't1found1';
const KUCOIN = 't1kucoinHot';
const NODE = 't1nodeOperator';
const LABELS = {
  exchanges: [{ name: 'Kucoin', addresses: [KUCOIN] }],
  foundation: { name: 'Flux Foundation', addresses: [FOUND] }
};
const ALL = { fromTime: 0, toTime: 2e9 };

const pay = (
  height: number,
  txid: string,
  from: string,
  amount: number,
  to: readonly (readonly [string, number])[]
): SimpleTx => ({ height, txid, inputs: [[from, amount]], outputs: to });

/** Apply detected intermediaries as labels and re-derive the flows they touch. */
function applyIntermediaries(db: Db, labels: LabelLookup) {
  const rows = detectIntermediaries(db, labels);
  replaceSourceLabels(db, INTERMEDIARY_SOURCE, rows);
  labels.refresh('test');
  const relabeler = new Relabeler(db, labels, silentLogger());
  for (let round = 0; round < 100 && relabeler.pending() > 0; round++) relabeler.run();
  return rows;
}

describe('Foundation intermediaries (#31)', () => {
  let db: Db;
  let labels: LabelLookup;

  beforeEach(() => {
    db = createTestDb();
    labels = labelBook(db, LABELS);
    replaceSourceLabels(db, 'node_list', [{ address: NODE, kind: 'node_operator', confidence: 1 }]);
    labels.refresh('node list');
  });

  afterEach(() => db.close());

  // The live case: 1.92M in, all of it out as 40,000 FLUX collateral to one node address.
  const collateralWallet: SimpleTx[] = [
    pay(10, 'f1', FOUND, 100_000.01, [['t1middle', 100_000]]),
    pay(20, 'f2', FOUND, 100_000.01, [['t1middle', 100_000]]),
    ...[30, 31, 32, 33, 34].map((height) =>
      pay(height, `c${height}`, 't1middle', 40_000.0001, [[NODE, 40_000]])
    )
  ];

  it('labels a wallet that passes Foundation money on as node collateral', () => {
    writeChain(db, labels, collateralWallet);

    const live = new Set(['c30', 'c31', 'c32', 'c33', 'c34']);
    const [row, ...rest] = detectIntermediaries(db, labels, live);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      address: 't1middle',
      kind: 'foundation',
      confidence: 0.8,
      evidence: {
        paymentsFromFoundation: 2,
        toNodeShare: 1,
        collateralPayments: 5,
        collateralSized: 5
      }
    });
  });

  it('turns the pass-through into an internal move and its payments into the outflows', () => {
    writeChain(db, labels, collateralWallet);
    const before = foundationReport(db, labels, ALL);
    expect(before.totals.outflow).toBeCloseTo(200_000, 0);
    expect(before.recent[0]!.counterparty).toBe('t1middle');

    applyIntermediaries(db, labels);
    const after = foundationReport(db, labels, ALL);

    expect(after.totals.internalTransfers).toBe(2);
    expect(after.totals.outflow).toBeCloseTo(200_000, 0);
    expect(after.recent.map((move) => move.counterparty)).toEqual(Array(5).fill(NODE));

    // Derivation agrees: no Foundation -> intermediary flow, five Foundation -> node flows.
    const flows = db
      .prepare<[], { kinds: string; n: number }>(
        `SELECT from_kind || '>' || to_kind AS kinds, COUNT(*) AS n FROM flows GROUP BY 1`
      )
      .all();
    expect(flows).toEqual([{ kinds: 'foundation>node_operator', n: 5 }]);
  });

  it('is stable: the applied label does not erase its own evidence', () => {
    writeChain(db, labels, collateralWallet);
    const first = applyIntermediaries(db, labels);
    expect(detectIntermediaries(db, labels)).toEqual(first);
  });

  it('does not take a round amount to an unknown wallet as node collateral', () => {
    writeChain(db, labels, [
      pay(10, 'f1', FOUND, 20_000.01, [['t1middle', 20_000]]),
      pay(20, 'f2', FOUND, 20_000.01, [['t1middle', 20_000]]),
      pay(30, 'k', 't1middle', 40_000.0001, [['t1stranger', 40_000]])
    ]);

    expect(detectIntermediaries(db, labels)).toMatchObject([
      { address: 't1middle', confidence: 0.5, evidence: { collateralSized: 1, toNodeShare: 0 } }
    ]);
    expect(detectIntermediaries(db, labels, new Set(['k']))).toMatchObject([
      { address: 't1middle', confidence: 0.8, evidence: { collateralPayments: 1 } }
    ]);
  });

  it('never applies to a wallet that forwards its wages to an exchange', () => {
    writeChain(db, labels, [
      pay(10, 'w1', FOUND, 500.01, [['t1contributor', 500]]),
      pay(20, 'w2', FOUND, 500.01, [['t1contributor', 500]]),
      {
        height: 30,
        txid: 'sell',
        inputs: [['t1contributor', 1_000]],
        outputs: [[KUCOIN, 999.99]]
      }
    ]);

    const rows = applyIntermediaries(db, labels);
    expect(rows).toMatchObject([{ address: 't1contributor', confidence: 0.5 }]);
    expect(labels.kindOf('t1contributor')).toBe('unknown');
    expect(db.prepare(`SELECT from_kind, flow_type FROM flows WHERE txid = 'sell'`).get()).toEqual({
      from_kind: 'unknown',
      flow_type: 'selling'
    });
  });

  it('ignores wallets that keep most of what they received', () => {
    writeChain(db, labels, [
      pay(10, 'w1', FOUND, 500.01, [['t1saver', 500]]),
      pay(20, 'w2', FOUND, 500.01, [['t1saver', 500]]),
      pay(30, 'spend', 't1saver', 100, [[NODE, 100]])
    ]);
    expect(detectIntermediaries(db, labels)).toEqual([]);
  });

  it('outranks an inferred node-operator label on the same wallet', () => {
    writeChain(db, labels, collateralWallet);
    // What node forwarding infers for a wallet that sends everything to node operators.
    replaceSourceLabels(db, 'forwarding', [
      { address: 't1middle', kind: 'node_operator', confidence: 0.75 }
    ]);
    labels.refresh('forwarding');
    expect(labels.kindOf('t1middle')).toBe('node_operator');

    applyIntermediaries(db, labels);
    expect(labels.labelOf('t1middle')).toMatchObject({
      kind: 'foundation',
      source: INTERMEDIARY_SOURCE
    });
  });

  it('does not claim an address that already has another label', () => {
    writeChain(db, labels, [
      pay(10, 'n1', FOUND, 40_000.01, [[NODE, 40_000]]),
      pay(20, 'n2', FOUND, 40_000.01, [[NODE, 40_000]]),
      pay(30, 'n3', NODE, 80_000, [['t1elsewhere', 79_999]])
    ]);
    expect(detectIntermediaries(db, labels)).toEqual([]);
  });
});

describe('Foundation destinations (#31)', () => {
  let db: Db;
  let labels: LabelLookup;

  beforeEach(() => {
    db = createTestDb();
    labels = labelBook(db, LABELS);
  });

  afterEach(() => db.close());

  it('follows a wage to an exchange and keeps the rest as held', () => {
    writeChain(db, labels, [
      // Exactly 1,000 FLUX, the Cumulus collateral: still a wage unless a node uses it.
      pay(10, 'wage', FOUND, 1_000.01, [['t1alice', 1_000]]),
      pay(20, 'sell', 't1alice', 600, [[KUCOIN, 600]])
    ]);

    const result = traceFoundation(db, labels, ALL);
    expect(result).toMatchObject({
      traced: 1_000,
      exchange: 600,
      byExchange: { Kucoin: 600 },
      nodes: 0,
      collateral: { payments: 0, unconfirmedPayments: 1, unconfirmedAmount: 1_000 }
    });
    expect(result.held).toBeCloseTo(400, 6);
    expect(result.recipients).toMatchObject([
      // Foundation -> alice -> Kucoin: the exchange is the second hop.
      { address: 't1alice', received: 1_000, exchange: 600, hops: 2 }
    ]);
  });

  it('follows value through two wallets, up to the hop limit', () => {
    writeChain(db, labels, [
      pay(10, 'wage', FOUND, 1_000.01, [['t1bob', 1_000]]),
      pay(20, 'b>c', 't1bob', 1_000, [['t1carol', 999.99]]),
      pay(30, 'c>k', 't1carol', 999.99, [[KUCOIN, 990]])
    ]);

    expect(traceFoundation(db, labels, ALL)).toMatchObject({ exchange: 990, untraced: 0 });
    expect(traceFoundation(db, labels, ALL, { maxHops: 1 })).toMatchObject({
      exchange: 0,
      untraced: 999.99
    });
  });

  it('passes on no more than was traced into a wallet', () => {
    writeChain(db, labels, [
      pay(5, 'savings', 't1other', 900, [['t1dave', 900]]),
      pay(10, 'wage', FOUND, 100.01, [['t1dave', 100]]),
      pay(20, 'sell', 't1dave', 1_000, [[KUCOIN, 1_000]])
    ]);

    const result = traceFoundation(db, labels, ALL);
    expect(result.exchange).toBeCloseTo(100, 6);
    expect(result.held).toBe(0);
  });

  it('credits the Foundation only with its share of a transaction it co-funded', () => {
    writeChain(db, labels, [
      {
        height: 10,
        txid: 'shared',
        inputs: [
          [FOUND, 60],
          ['t1partner', 40]
        ],
        outputs: [['t1erin', 100]]
      }
    ]);
    expect(traceFoundation(db, labels, ALL).traced).toBeCloseTo(60, 6);
  });

  it('counts exact collateral as nodes, once per payment', () => {
    writeChain(db, labels, [
      pay(10, 'p1', FOUND, 30_000.01, [['t1frank', 30_000]]),
      pay(11, 'p2', FOUND, 30_000.01, [['t1frank', 30_000]]),
      // One 40,000 payment funded by both traced amounts.
      pay(20, 'c', 't1frank', 40_000.0001, [['t1newnode', 40_000]])
    ]);

    const result = traceFoundation(db, labels, ALL, { collateralTxids: new Set(['c']) });
    expect(result.nodes).toBeCloseTo(40_000, 6);
    expect(result.collateral).toEqual({
      payments: 1,
      amount: 40_000,
      unconfirmedPayments: 0,
      unconfirmedAmount: 0
    });
    expect(result.held).toBeCloseTo(20_000, 6);
  });

  it('stays bounded when a recipient fans out to very many wallets, and still adds up', () => {
    const fanout = Array.from(
      { length: 400 },
      (_, i) => [`t1fan${String(i).padStart(3, '0')}`, 2.5] as [string, number]
    );
    writeChain(db, labels, [
      pay(10, 'wage', FOUND, 1_000.01, [['t1spray', 1_000]]),
      pay(20, 'spray', 't1spray', 1_000, fanout),
      // Every one of them sprays again: 400 x 400 wallets if nothing bounded the walk.
      ...fanout.map(([address], i) =>
        pay(30 + i, `again${i}`, address, 2.5, [
          [`${address}a`, 1.2],
          [`${address}b`, 1.2]
        ])
      )
    ]);

    const result = traceFoundation(db, labels, ALL);
    const accounted =
      result.exchange + result.nodes + result.returned + result.held + result.untraced;

    expect(result.truncated).toBe(false);
    // 50 recipients followed; the other 350 (875 FLUX) are untraced, as is the dust below.
    expect(result.untraced).toBeGreaterThanOrEqual(875 - 1e-6);
    expect(accounted).toBeCloseTo(result.traced, 4);
  });

  it('gives up after its step budget and says so, without losing value', () => {
    writeChain(db, labels, [
      pay(10, 'wage', FOUND, 1_000.01, [['t1hop1', 1_000]]),
      pay(20, 'h2', 't1hop1', 1_000, [['t1hop2', 999.99]]),
      pay(30, 'h3', 't1hop2', 999.99, [['t1hop3', 999.98]])
    ]);

    const result = traceFoundation(db, labels, ALL, { maxSteps: 2 });

    expect(result.truncated).toBe(true);
    // Two wallets visited; what reached the third (999.98 after fees) is untraced.
    expect(result.untraced).toBeCloseTo(999.98, 6);
  });

  it('stops following value that sat longer than the hop window', () => {
    writeChain(db, labels, [
      pay(10, 'wage', FOUND, 100.01, [['t1gina', 100]]),
      pay(10 + 501, 'late', 't1gina', 100, [[KUCOIN, 100]])
    ]);
    expect(traceFoundation(db, labels, ALL, { hopBlocks: 500 })).toMatchObject({
      exchange: 0,
      held: 100
    });
  });
});

describe('node collateral from the node list', () => {
  it('reads collateral transactions from the daemon and explorer shapes', () => {
    const a = 'a'.repeat(64);
    const b = 'B'.repeat(64);
    expect(
      parseCollateralTxids({
        status: 'success',
        data: [
          { txhash: a, collateral: `COutPoint(${a}, 0)`, payment_address: 't1x' },
          { collateral: `COutPoint(${b}, 1)` },
          { txhash: 'not-a-txid' }
        ]
      })
    ).toEqual(new Set([a, b.toLowerCase()]));
  });
});

describe('Foundation report cache', () => {
  it('computes once per data version and serves a stale copy while refreshing', async () => {
    const db = createTestDb();
    const labels = labelBook(db, LABELS);
    const intel = new IntelService({
      config: createTestConfig(),
      db,
      labels,
      log: silentLogger()
    });

    let calls = 0;
    const compute = () => ++calls;

    expect(intel.foundationReport('7D', compute)).toBe(1);
    expect(intel.foundationReport('7D', compute)).toBe(1);

    writeChain(db, labels, [pay(10, 'wage', FOUND, 1.01, [['t1x', 1]])]);
    // Data changed: the old answer is served at once, the new one computed in the background.
    expect(intel.foundationReport('7D', compute)).toBe(1);
    await intel.refreshFoundation();
    expect(intel.foundationReport('7D', compute)).toBe(2);
    expect(calls).toBe(2);
    db.close();
  });
});
