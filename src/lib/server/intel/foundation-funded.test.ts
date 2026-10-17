import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type Db } from '../testkit.js';
import type { LabelLookup } from '../labels.js';
import { applyDecision, storeCandidates } from './clusters.js';
import {
  detectFoundationFunded,
  dropStaleFoundationFunded,
  FOUNDATION_FUNDED
} from './foundation-funded.js';
import { reviewCandidates } from './review.js';
import { labelBook, writeChain, type SimpleTx } from './testchain.js';

const FOUND_A = 't1foundA';
const FOUND_B = 't3foundB';
const HOSTING = 't3appHosting';
const KUCOIN = 't1kucoinHot';
const LABELS = {
  exchanges: [{ name: 'Kucoin', addresses: [KUCOIN] }],
  appHosting: [{ name: 'Flux App Hosting', addresses: [HOSTING] }],
  foundation: { name: 'Flux Foundation', addresses: [FOUND_A, FOUND_B] }
};

const pay = (
  height: number,
  txid: string,
  from: string,
  amount: number,
  to: readonly (readonly [string, number])[]
): SimpleTx => ({ height, txid, inputs: [[from, amount]], outputs: to });

describe('Foundation-funded wallets (#62)', () => {
  let db: Db;
  let labels: LabelLookup;

  beforeEach(() => {
    db = createTestDb();
    labels = labelBook(db, LABELS);
  });

  afterEach(() => db.close());

  // The live shape: a treasury mostly funded by two Foundation wallets (plus app fees), an
  // operations wallet it funds, and an app payer funded only through the operations wallet.
  const appCluster: SimpleTx[] = [
    pay(10, 'a1', FOUND_A, 300_000.01, [['t3treasury', 300_000]]),
    pay(11, 'a2', FOUND_B, 200_000.01, [['t3treasury', 200_000]]),
    pay(12, 'a3', HOSTING, 100_000.01, [['t3treasury', 100_000]]),
    pay(13, 'a4', 't1stranger', 50_000.01, [['t3treasury', 50_000]]),
    pay(20, 'b1', 't3treasury', 60_000.01, [['t1ops', 60_000]]),
    pay(21, 'b2', FOUND_A, 40_000.01, [['t1ops', 40_000]]),
    pay(30, 'c1', 't1ops', 30_000.01, [['t1payer', 30_000]]),
    pay(31, 'c2', 't1ops', 20_000.01, [['t1payer', 20_000]]),
    ...[40, 41, 42].map((height) => pay(height, `d${height}`, 't1payer', 100.01, [[HOSTING, 100]]))
  ];

  it('proposes wallets funded mostly by the Foundation, directly or through each other', () => {
    writeChain(db, labels, appCluster);

    const found = detectFoundationFunded(db, labels);
    const byAddress = new Map(found.map((row) => [row.address, row]));

    expect([...byAddress.keys()].sort()).toEqual(['t1ops', 't1payer', 't3treasury']);
    for (const row of found) {
      expect(row).toMatchObject({ kind: 'foundation', name: 'Flux Foundation' });
      expect(row.method).toBe(FOUNDATION_FUNDED.method);
    }

    // 500k of 650k came from Foundation wallets, in two payments.
    expect(byAddress.get('t3treasury')!.evidence).toMatchObject({
      shareFromFoundation: 0.769,
      directShare: 0.769,
      paymentsFromFoundation: 2,
      hops: 1
    });
    // Funded by the treasury and the Foundation: only once the treasury is suspected does
    // all of it count, so it is found on the second pass, at lower confidence.
    expect(byAddress.get('t1ops')).toMatchObject({
      confidence: FOUNDATION_FUNDED.confidence.indirect,
      evidence: { shareFromFoundation: 1, directShare: 0.4, hops: 2 }
    });
    // Never paid by the Foundation itself: found on the third pass.
    expect(byAddress.get('t1payer')).toMatchObject({
      confidence: FOUNDATION_FUNDED.confidence.indirect,
      evidence: { shareFromFoundation: 1, directShare: 0, hops: 3, toAppsShare: 1 }
    });
    expect(byAddress.get('t3treasury')!.confidence).toBe(FOUNDATION_FUNDED.confidence.direct);
  });

  it('lists the funders behind a proposal, Foundation first', () => {
    writeChain(db, labels, appCluster);
    const treasury = detectFoundationFunded(db, labels).find((row) => row.address === 't3treasury');
    expect(treasury!.evidence['funders']).toEqual([FOUND_A, FOUND_B]);
  });

  it('ignores a wallet that sells what the Foundation gave it', () => {
    // Treasury-sized, so only the selling rules it out.
    writeChain(db, labels, [
      pay(10, 'a1', FOUND_A, 150_000.01, [['t1seller', 150_000]]),
      pay(11, 'a2', FOUND_A, 150_000.01, [['t1seller', 150_000]]),
      pay(20, 's1', 't1seller', 200_000.01, [[KUCOIN, 200_000]])
    ]);
    expect(detectFoundationFunded(db, labels)).toEqual([]);
  });

  it('ignores someone the Foundation pays, who only holds it', () => {
    writeChain(db, labels, [
      pay(10, 'a1', FOUND_A, 20_000.01, [['t1contributor', 20_000]]),
      pay(11, 'a2', FOUND_A, 20_000.01, [['t1contributor', 20_000]])
    ]);
    expect(detectFoundationFunded(db, labels)).toEqual([]);
  });

  it('does not let a contributor qualify by forwarding to their own savings', () => {
    writeChain(db, labels, [
      pay(10, 'a1', FOUND_A, 20_000.01, [['t1contributor', 20_000]]),
      pay(11, 'a2', FOUND_A, 20_000.01, [['t1contributor', 20_000]]),
      pay(20, 'f1', 't1contributor', 20_000.01, [['t1savings', 20_000]]),
      pay(21, 'f2', 't1contributor', 20_000.01, [['t1savings', 20_000]])
    ]);
    expect(detectFoundationFunded(db, labels)).toEqual([]);
  });

  it('ignores a wallet spending far more than it was given, and whoever it funds', () => {
    // The live case: 29k from the Foundation, 446k sent on from its own (mined) money.
    writeChain(db, labels, [
      pay(10, 'a1', FOUND_A, 15_000.01, [['t1miner', 15_000]]),
      pay(11, 'a2', FOUND_A, 15_000.01, [['t1miner', 15_000]]),
      { height: 12, txid: 'cb', kind: 'coinbase', outputs: [['t1miner', 500_000]] },
      pay(20, 'f1', 't1miner', 300_000.01, [['t1stash', 300_000]]),
      pay(21, 'f2', 't1miner', 146_000.01, [['t1stash', 146_000]])
    ]);
    expect(detectFoundationFunded(db, labels)).toEqual([]);
  });

  it('keeps an operations wallet that only funds an app payer', () => {
    writeChain(db, labels, [
      pay(10, 'a1', FOUND_A, 20_000.01, [['t1ops', 20_000]]),
      pay(11, 'a2', FOUND_A, 20_000.01, [['t1ops', 20_000]]),
      pay(20, 'f1', 't1ops', 20_000.01, [['t1payer', 20_000]]),
      pay(21, 'f2', 't1ops', 20_000.01, [['t1payer', 20_000]]),
      ...[30, 31].map((height) => pay(height, `d${height}`, 't1payer', 100.01, [[HOSTING, 100]]))
    ]);
    const found = detectFoundationFunded(db, labels);
    expect(found.map((row) => row.address)).toEqual(['t1ops', 't1payer']);
    expect(found[0]!.evidence).toMatchObject({ toFoundationShare: 1, toAppsShare: 0 });
  });

  it('ignores a single payment, small amounts and wallets mostly funded elsewhere', () => {
    writeChain(db, labels, [
      // One payment only.
      pay(10, 'a1', FOUND_A, 50_000.01, [['t1once', 50_000]]),
      // Two payments, but too little to matter.
      pay(11, 'a2', FOUND_A, 100.01, [['t1dust', 100]]),
      pay(12, 'a3', FOUND_A, 100.01, [['t1dust', 100]]),
      // Two Foundation payments that are a minority of what it received.
      pay(13, 'a4', FOUND_A, 10_000.01, [['t1mixed', 10_000]]),
      pay(14, 'a5', FOUND_B, 10_000.01, [['t1mixed', 10_000]]),
      pay(15, 'a6', 't1stranger', 30_000.01, [['t1mixed', 30_000]])
    ]);
    expect(detectFoundationFunded(db, labels)).toEqual([]);
  });

  it('never proposes an address that already has a label', () => {
    writeChain(db, labels, [
      pay(10, 'a1', FOUND_A, 50_000.01, [[KUCOIN, 50_000]]),
      pay(11, 'a2', FOUND_A, 50_000.01, [[KUCOIN, 50_000]])
    ]);
    expect(detectFoundationFunded(db, labels)).toEqual([]);
  });

  it('does not build on a proposal the owner rejected', () => {
    writeChain(db, labels, appCluster);
    storeCandidates(db, detectFoundationFunded(db, labels));
    applyDecision(
      db,
      { address: 't1ops', kind: 'foundation', name: 'Flux Foundation' },
      'rejected'
    );

    const again = detectFoundationFunded(db, labels).map((row) => row.address);
    // t1payer was only reachable through t1ops.
    expect(again).toEqual(['t3treasury']);
  });

  it('drops pending proposals that no longer qualify, and keeps decided ones', () => {
    writeChain(db, labels, appCluster);
    storeCandidates(db, detectFoundationFunded(db, labels));
    applyDecision(
      db,
      { address: 't1ops', kind: 'foundation', name: 'Flux Foundation' },
      'accepted'
    );
    // As the review does: the accepted wallet is now one of the Foundation's own.
    labels.refresh('accepted');

    // The treasury later sells most of its money: it no longer qualifies.
    writeChain(db, labels, [pay(50, 's1', 't3treasury', 500_000.01, [[KUCOIN, 500_000]])]);
    expect(dropStaleFoundationFunded(db, detectFoundationFunded(db, labels))).toBe(1);

    const left = db
      .prepare<[], { address: string; status: string }>(
        `SELECT address, status FROM label_candidates ORDER BY address`
      )
      .all();
    expect(left).toEqual([
      { address: 't1ops', status: 'accepted' },
      { address: 't1payer', status: 'pending' }
    ]);
  });

  it('shows on the review page with how much came from the Foundation', () => {
    writeChain(db, labels, appCluster);
    storeCandidates(db, detectFoundationFunded(db, labels));

    const reviewed = reviewCandidates(db, labels);
    const treasury = reviewed.find((row) => row.address === 't3treasury')!;
    expect(treasury.activity.received.fromClaimed).toBeCloseTo(500_000, 0);
    expect(treasury.activity.received.fromClaimedShare).toBe(0.769);
    // Strength follows the funding share, not exchange deposits it never made.
    expect(treasury.strength).toBeGreaterThan(0.45);
  });
});
