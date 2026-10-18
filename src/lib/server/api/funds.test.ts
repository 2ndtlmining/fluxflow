import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type Db } from '../testkit.js';
import type { LabelLookup } from '../labels.js';
import { labelBook, writeChain, type SimpleTx } from '../intel/testchain.js';
import { appPayments } from './apps.js';
import { fundsTracer, walletFunds } from './funds.js';

const FOUND = 't1found1';
const KUCOIN = 't1kucoinHot';
const HOSTING = 't3appHosting';
const LABELS = {
  exchanges: [{ name: 'Kucoin', addresses: [KUCOIN] }],
  foundation: { name: 'Flux Foundation', addresses: [FOUND] },
  appHosting: [{ name: 'Flux App Hosting', addresses: [HOSTING] }]
};

const pay = (
  height: number,
  txid: string,
  from: string,
  amount: number,
  to: readonly (readonly [string, number])[]
): SimpleTx => ({ height, txid, inputs: [[from, amount]], outputs: to });

/**
 * Foundation -> A -> B -> C -> Kucoin, with A and B also paying for apps and keeping some,
 * and a retail wallet withdrawing from Kucoin.
 */
const CHAIN: SimpleTx[] = [
  pay(10, 'wage', FOUND, 1_000, [['t1walletA', 1_000]]),
  pay(11, 'withdraw', KUCOIN, 100, [['t1retail', 100]]),
  pay(20, 'a1', 't1walletA', 150, [[HOSTING, 150]]),
  pay(22, 'a2b', 't1walletA', 400, [['t1walletB', 400]]),
  pay(30, 'b1', 't1walletB', 100, [[HOSTING, 100]]),
  pay(31, 'b2c', 't1walletB', 200, [['t1walletC', 200]]),
  pay(40, 'c1', 't1walletC', 200, [[KUCOIN, 200]]),
  pay(41, 'r1', 't1retail', 50, [[HOSTING, 50]])
];

describe('source and destination of funds', () => {
  let db: Db;
  let labels: LabelLookup;

  beforeEach(() => {
    db = createTestDb();
    labels = labelBook(db, LABELS);
    writeChain(db, labels, CHAIN);
  });

  afterEach(() => db.close());

  it('follows unlabelled senders back one hop per extra hop', () => {
    expect(walletFunds(db, labels, 't1walletC', 'in', 1)).toMatchObject({
      total: 200,
      byKind: { unknown: 200 },
      untraced: 200
    });
    expect(walletFunds(db, labels, 't1walletC', 'in', 2).byKind).toEqual({ unknown: 200 });
    expect(walletFunds(db, labels, 't1walletC', 'in', 3)).toMatchObject({
      byKind: { foundation: 200 },
      untraced: 0,
      endpoints: [{ address: FOUND, kind: 'foundation', name: 'Flux Foundation', hop: 3 }]
    });
  });

  it('names the exchange money came from', () => {
    expect(walletFunds(db, labels, 't1retail', 'in', 3)).toMatchObject({
      total: 100,
      byKind: { exchange: 100 },
      byExchange: { Kucoin: 100 },
      endpoints: [{ address: KUCOIN, amount: 100, hop: 1 }]
    });
  });

  it('counts node rewards to the wallet and to the wallets it was funded by', () => {
    db.prepare(
      `INSERT INTO node_rewards (address, height, day, reward_count, sat) VALUES (?, ?, ?, ?, ?)`
    ).run('t1walletB', 25, 0, 1, 600 * 1e8);

    // B: 400 from A (all Foundation) and 600 in rewards.
    expect(walletFunds(db, labels, 't1walletB', 'in', 2)).toMatchObject({
      total: 1_000,
      byKind: { foundation: 400, node_rewards: 600 }
    });
    // C's 200 came from B, so it is 40% Foundation and 60% rewards.
    expect(walletFunds(db, labels, 't1walletC', 'in', 3).byKind).toEqual({
      foundation: 80,
      node_rewards: 120
    });
  });

  it('follows money forward, and says what each wallet kept', () => {
    // A received 1,000: 150 to apps, 400 to B, 450 kept.
    expect(walletFunds(db, labels, FOUND, 'out', 2).byKind).toEqual({
      app_hosting: 150,
      held: 450,
      unknown: 400
    });
    // B passed 100 to apps and 200 to C, kept 100; C deposited all 200 at Kucoin.
    expect(walletFunds(db, labels, FOUND, 'out', 4)).toMatchObject({
      total: 1_000,
      byKind: { app_hosting: 250, held: 550, exchange: 200 },
      byExchange: { Kucoin: 200 },
      untraced: 0
    });
  });

  it('adds up to the total either way', () => {
    for (const direction of ['in', 'out'] as const) {
      for (const address of [FOUND, KUCOIN, 't1walletA', 't1walletB', 't1walletC', 't1retail']) {
        const result = walletFunds(db, labels, address, direction, 4);
        const sum = Object.values(result.byKind).reduce((total, amount) => total + amount!, 0);
        expect(sum).toBeCloseTo(result.total, 6);
      }
    }
  });

  it('agrees with what /apps reports as funded by, at two hops', () => {
    const all = { fromHeight: 0, toHeight: 1_000_000 };
    for (const payer of appPayments(db, labels, all).topPayers) {
      const funds = walletFunds(db, labels, payer.address, 'in', 2);
      expect(payer.fundedBy).toEqual({ received: funds.total, mix: funds.byKind });
    }
  });

  it('stops at the step budget, counts the rest as unknown and says so', () => {
    const tracer = fundsTracer(db, labels, 'in', { maxHops: 4, maxReads: 1 });
    const exposure = tracer.trace('t1walletC');

    expect(exposure.mix).toEqual({ unknown: 200 * 1e8 });
    expect(tracer.truncated()).toBe(true);
    expect(walletFunds(db, labels, 't1walletC', 'in', 4).truncated).toBe(false);
  });

  it('caps the hop count', () => {
    expect(walletFunds(db, labels, 't1walletC', 'in', 99).hops).toBe(4);
    expect(walletFunds(db, labels, 't1walletC', 'in', 0).hops).toBe(1);
  });
});
