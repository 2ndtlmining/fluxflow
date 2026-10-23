import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type Db } from '../testkit.js';
import type { LabelLookup } from '../labels.js';
import { labelBook, writeChain, type SimpleTx } from '../intel/testchain.js';
import { findPaths } from './path.js';

// The acceptance shape (#70): Foundation t1eabPBa… → t1Mzja… → t1XktDZ9… → app hosting.
const FOUND = 't1found';
const PAYER = 't1payer';
const FIAT = 't1fiat';
const HOSTING = 't3hosting';
const KUCOIN = 't1kucoin';
const ALL = { fromHeight: 0, toHeight: 1_000_000 };

const pay = (height: number, txid: string, from: string, amount: number, to: string): SimpleTx => ({
  height,
  txid,
  inputs: [[from, amount]],
  outputs: [[to, amount]]
});

describe('path finder (#70)', () => {
  let db: Db;
  let labels: LabelLookup;

  beforeEach(() => {
    db = createTestDb();
    labels = labelBook(db, {
      exchanges: [{ name: 'Kucoin', addresses: [KUCOIN] }],
      foundation: { name: 'Flux Foundation', addresses: [FOUND, PAYER, FIAT] },
      appHosting: [{ name: 'Flux App Hosting', addresses: [HOSTING] }]
    });
    writeChain(db, labels, [
      // Foundation-internal moves: never flows (#31), still a trail.
      pay(10, 'f1', FOUND, 80_000, PAYER),
      pay(20, 'f2', PAYER, 30_000, FIAT),
      pay(30, 'f3', FIAT, 400, HOSTING),
      pay(31, 'f4', FIAT, 600, HOSTING),
      // A weaker route through an unlabelled wallet: bottleneck 50.
      pay(40, 'w1', FOUND, 50, 't1side'),
      pay(41, 'w2', 't1side', 50, HOSTING),
      // A route through an exchange, which a trail cannot be followed through.
      pay(50, 'x1', FOUND, 5_000, KUCOIN),
      pay(51, 'x2', KUCOIN, 5_000, HOSTING),
      // Too long for maxHops 4: five hops.
      pay(60, 'l1', 't1a', 10, 't1b'),
      pay(61, 'l2', 't1b', 10, 't1c'),
      pay(62, 'l3', 't1c', 10, 't1d'),
      pay(63, 'l4', 't1d', 10, 't1e'),
      pay(64, 'l5', 't1e', 10, 't1f')
    ]);
  });

  afterEach(() => db.close());

  const chain = (path: { hops: { from: string; to: string }[] }) => [
    path.hops[0]!.from,
    ...path.hops.map((hop) => hop.to)
  ];

  it('follows Foundation-internal moves into a payment, strongest path first', () => {
    const result = findPaths(db, labels, FOUND, HOSTING, ALL);

    expect(result.paths.map(chain)).toEqual([
      [FOUND, PAYER, FIAT, HOSTING],
      [FOUND, 't1side', HOSTING]
    ]);
    const [best] = result.paths;
    expect(best).toMatchObject({ bottleneck: 1_000 });
    expect(best!.hops.map((hop) => [hop.total, hop.internal])).toEqual([
      [80_000, true],
      [30_000, true],
      [1_000, false]
    ]);
    expect(best!.hops[2]).toMatchObject({ count: 2 });
    expect(result.nodes[PAYER]).toMatchObject({ kind: 'foundation' });
  });

  it('passes through an exchange only when asked to', () => {
    const through = findPaths(db, labels, FOUND, HOSTING, ALL, { throughExchanges: true });
    expect(through.paths.map(chain)).toContainEqual([FOUND, KUCOIN, HOSTING]);
    // Ranked by bottleneck: the exchange route (5,000) beats the internal one (1,000).
    expect(chain(through.paths[0]!)).toEqual([FOUND, KUCOIN, HOSTING]);
  });

  it('respects the hop limit and the time window', () => {
    expect(findPaths(db, labels, 't1a', 't1f', ALL, { maxHops: 4 }).paths).toEqual([]);
    expect(findPaths(db, labels, 't1a', 't1f', ALL, { maxHops: 5 }).paths.map(chain)).toEqual([
      ['t1a', 't1b', 't1c', 't1d', 't1e', 't1f']
    ]);
    // Before the payments, the Foundation trail does not reach the hosting address yet.
    const early = findPaths(db, labels, FOUND, HOSTING, { fromHeight: 0, toHeight: 29 });
    expect(early.paths).toEqual([]);
  });

  it('answers with no path, not an error, for wallets that never met', () => {
    expect(findPaths(db, labels, 't1a', HOSTING, ALL)).toMatchObject({
      paths: [],
      truncated: false
    });
  });
});
