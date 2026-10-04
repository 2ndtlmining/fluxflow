import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, silentLogger, SATS, type Db } from '../testkit.js';
import { replaceSourceLabels, type LabelLookup } from '../labels.js';
import { MIGRATIONS } from '../db/migrations.js';
import { Relabeler } from './relabel.js';
import { labelBook, rollupMismatches, writeChain, type SimpleTx } from './testchain.js';

const KUCOIN = 't1kucoinHot';
const DEPOSIT = 't1depositAddr';
const ALICE = 't1alice';
const BOB = 't1bob';

const LABELS = {
  exchanges: [{ name: 'Kucoin', addresses: [KUCOIN] }],
  foundation: { name: 'Flux Foundation', addresses: ['t1found1', 't1found2'] }
};

/** Alice and Bob deposit into an unknown address, which is later swept into Kucoin. */
const CHAIN: SimpleTx[] = [
  { height: 1, txid: 'a1', inputs: [[ALICE, 100]], outputs: [[DEPOSIT, 99.9]] },
  { height: 2, txid: 'b1', inputs: [[BOB, 50]], outputs: [[DEPOSIT, 49.9]] },
  { height: 3, txid: 'sweep', inputs: [[DEPOSIT, 149.8]], outputs: [[KUCOIN, 149.7]] },
  { height: 4, txid: 'w1', inputs: [[KUCOIN, 30]], outputs: [[ALICE, 29.9]] }
];

function kindTotals(db: Db) {
  return db
    .prepare(
      `SELECT flow_type AS type, counterparty_kind AS kind, SUM(sat) AS sat
       FROM rollup_daily GROUP BY 1, 2 ORDER BY 1, 2`
    )
    .all();
}

describe('re-derivation after a label change (#18)', () => {
  let db: Db;
  let labels: LabelLookup;
  let relabeler: Relabeler;

  beforeEach(() => {
    db = createTestDb();
    labels = labelBook(db, LABELS);
    writeChain(db, labels, CHAIN);
    db.prepare(`DELETE FROM relabel_queue`).run();
    relabeler = new Relabeler(db, labels, silentLogger());
  });

  afterEach(() => db.close());

  it('moves totals between kinds when a deposit address is labelled, with zero drift', () => {
    // Before: the sweep is the only "sale", by an unknown wallet.
    expect(
      db.prepare(`SELECT from_address, flow_type FROM flows WHERE txid = 'sweep'`).get()
    ).toEqual({ from_address: DEPOSIT, flow_type: 'selling' });

    replaceSourceLabels(db, 'accepted', [
      { address: DEPOSIT, kind: 'exchange', name: 'Kucoin', confidence: 0.9 }
    ]);
    expect(labels.refresh('test')).toEqual([DEPOSIT]);

    const result = relabeler.run({ budgetMs: 1_000 });
    expect(result.remaining).toBe(0);
    expect(result.changedTxs).toBe(3);

    // After: Alice and Bob are the sellers; the sweep is exchange-internal.
    const selling = db
      .prepare(
        `SELECT from_address AS seller, sat FROM flows WHERE flow_type = 'selling' ORDER BY seller`
      )
      .all();
    expect(selling).toEqual([
      { seller: ALICE, sat: Math.round(99.9 * SATS) },
      { seller: BOB, sat: Math.round(49.9 * SATS) }
    ]);
    expect(db.prepare(`SELECT flow_type FROM flows WHERE txid = 'sweep'`).get()).toEqual({
      flow_type: 'p2p'
    });

    expect(rollupMismatches(db)).toEqual([]);
  });

  it('moves a seller between kinds when it becomes a node operator', () => {
    replaceSourceLabels(db, 'node_list', [
      { address: ALICE, kind: 'node_operator', confidence: 1 }
    ]);
    labels.refresh('test');
    relabeler.run({ budgetMs: 1_000 });

    // Alice now buys as a node operator (w1).
    expect(kindTotals(db)).toContainEqual({
      type: 'buying',
      kind: 'node_operator',
      sat: Math.round(29.9 * SATS)
    });
    expect(rollupMismatches(db)).toEqual([]);

    // And back: removing the label moves it back to unknown.
    replaceSourceLabels(db, 'node_list', []);
    labels.refresh('test');
    relabeler.run({ budgetMs: 1_000 });

    expect(kindTotals(db)).not.toContainEqual(
      expect.objectContaining({ type: 'buying', kind: 'node_operator' })
    );
    expect(rollupMismatches(db)).toEqual([]);
  });

  it('does not apply a label below "likely"', () => {
    replaceSourceLabels(db, 'forwarding', [
      { address: ALICE, kind: 'node_operator', confidence: 0.5 }
    ]);

    expect(labels.refresh('test')).toEqual([]);
    expect(labels.kindOf(ALICE)).toBe('unknown');
    expect(labels.allLabels(ALICE)).toHaveLength(1);
  });

  it('works through a large backlog in bounded batches, resuming where it stopped', () => {
    const many: SimpleTx[] = Array.from({ length: 30 }, (_, index) => ({
      height: 10 + index,
      txid: `k${index}`,
      inputs: [[KUCOIN, 10]],
      outputs: [[`t1buyer${index}`, 9.9]]
    }));
    writeChain(db, labels, many);
    db.prepare(`DELETE FROM relabel_queue`).run();

    replaceSourceLabels(db, 'manual', [
      { address: KUCOIN, kind: 'exchange', name: 'KuCoin (renamed)', confidence: 1 }
    ]);
    labels.refresh('test');

    const first = relabeler.run({ maxTxs: 10, budgetMs: 0 });
    expect(first.txs).toBe(10);
    expect(first.remaining).toBe(1);

    let rounds = 1;
    while (relabeler.pending() > 0 && rounds < 10) {
      relabeler.run({ maxTxs: 10, budgetMs: 0 });
      rounds++;
    }

    expect(relabeler.pending()).toBe(0);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM flows WHERE exchange = 'KuCoin (renamed)'`).get()
    ).toEqual({ n: 32 }); // the 30 withdrawals, w1, and the sweep into the hot wallet
    expect(rollupMismatches(db)).toEqual([]);
  });
});

describe('upgrading to split funders (migration 5)', () => {
  it('re-derives a sweep stored the old way into one row per funder, with zero drift', () => {
    const db = createTestDb();
    const labels = labelBook(db, LABELS);
    writeChain(db, labels, [
      {
        height: 1,
        txid: 'sweep',
        inputs: [
          ['t1depA', 40],
          ['t1depB', 60]
        ],
        outputs: [[KUCOIN, 99.9]]
      }
    ]);

    // As a pre-upgrade database stored it: the whole sweep credited to the smaller funder.
    db.prepare(`DELETE FROM flows WHERE txid = 'sweep'`).run();
    db.prepare(
      `INSERT INTO flows (txid, vout, height, time, from_address, from_kind, to_address, to_kind,
                          exchange, flow_type, sat)
       SELECT 'sweep', 0, height, time, 't1depA', 'unknown', ?, 'exchange', 'Kucoin', 'selling', ?
       FROM blocks WHERE height = 1`
    ).run(KUCOIN, Math.round(99.9 * SATS));
    db.prepare(`DELETE FROM relabel_queue`).run();

    MIGRATIONS.find((migration) => migration.version === 5)!.up(db);
    expect(db.prepare(`SELECT address FROM relabel_queue`).all()).toEqual([{ address: 't1depA' }]);

    new Relabeler(db, labels, silentLogger()).run({ budgetMs: 1_000 });

    expect(
      db
        .prepare(`SELECT from_address AS seller, sat FROM flows WHERE txid = 'sweep' ORDER BY 1`)
        .all()
    ).toEqual([
      { seller: 't1depA', sat: Math.round(99.9 * SATS * 0.4) },
      { seller: 't1depB', sat: Math.round(99.9 * SATS * 0.6) }
    ]);
    expect(rollupMismatches(db)).toEqual([]);
    db.close();
  });
});

describe('the label book', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => db.close());

  it('prefers a manual label over the config, and config over inferred labels', () => {
    const labels = labelBook(db, LABELS);
    replaceSourceLabels(db, 'node_rewards', [
      { address: KUCOIN, kind: 'node_operator', confidence: 0.8 }
    ]);
    labels.refresh();
    expect(labels.kindOf(KUCOIN)).toBe('exchange');

    replaceSourceLabels(db, 'manual', [
      { address: KUCOIN, kind: 'unknown', confidence: 1 },
      { address: BOB, kind: 'foundation', name: 'Flux Foundation', confidence: 1 }
    ]);
    labels.refresh();
    expect(labels.kindOf(KUCOIN)).toBe('unknown');
    expect(labels.kindOf(BOB)).toBe('foundation');
  });

  it('honours validity windows at the time of the flow', () => {
    const labels = labelBook(db, LABELS);
    replaceSourceLabels(db, 'node_rewards', [
      { address: ALICE, kind: 'node_operator', confidence: 0.8, validTo: 1_000 }
    ]);
    labels.refresh();

    expect(labels.kindOf(ALICE, 999)).toBe('node_operator');
    expect(labels.kindOf(ALICE, 1_001)).toBe('unknown');
  });

  it('forgets a config label removed from the file and queues the address', () => {
    const labels = labelBook(db, LABELS);
    expect(labels.kindOf(KUCOIN)).toBe('exchange');
    db.prepare(`DELETE FROM relabel_queue`).run();

    replaceSourceLabels(db, 'config', []);
    expect(labels.refresh()).toContain(KUCOIN);
    expect(labels.kindOf(KUCOIN)).toBe('unknown');
    expect(
      db.prepare(`SELECT address FROM relabel_queue WHERE address = ?`).get(KUCOIN)
    ).toBeDefined();
  });

  it('reads Foundation sub-wallets from the config', () => {
    const labels = labelBook(db, {
      foundation: {
        name: 'Flux Foundation',
        addresses: ['t1found1'],
        wallets: [{ name: 'Treasury', addresses: ['t1treasury'] }]
      }
    });

    expect(labels.labelOf('t1treasury')).toMatchObject({
      kind: 'foundation',
      subLabel: 'Treasury',
      level: 'confirmed'
    });
  });
});

describe('Foundation internal transfers (#31)', () => {
  it('produce no flow', () => {
    const db = createTestDb();
    const labels = labelBook(db, LABELS);

    writeChain(db, labels, [
      { height: 1, txid: 'internal', inputs: [['t1found1', 1_000]], outputs: [['t1found2', 999]] },
      { height: 2, txid: 'external', inputs: [['t1found1', 10]], outputs: [[ALICE, 9.9]] }
    ]);

    expect(db.prepare(`SELECT txid FROM flows ORDER BY txid`).all()).toEqual([
      { txid: 'external' }
    ]);
    db.close();
  });
});
