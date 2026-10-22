import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, SATS, type Db } from '../testkit.js';
import type { LabelLookup } from '../labels.js';
import { foundationReport, type BalanceSnapshot } from '../intel/foundation.js';
import { blockTime, labelBook, writeChain, type SimpleTx } from '../intel/testchain.js';
import { BalanceCache, balanceHistory } from './balances.js';

const FOUND = 't1found1';
const KUCOIN = 't1kucoinHot';
const LABELS = {
  exchanges: [{ name: 'Kucoin', addresses: [KUCOIN] }],
  foundation: { name: 'Flux Foundation', addresses: [FOUND] }
};
/** Heights a day (2,880 blocks at 30 s) apart, so each lands on its own day. */
const DAY_BLOCKS = 2_880;

const CHAIN: SimpleTx[] = [
  { height: 10, txid: 'in1', inputs: [['t1donor', 1_000.1]], outputs: [[FOUND, 1_000]] },
  {
    height: 10 + DAY_BLOCKS,
    txid: 'out1',
    inputs: [[FOUND, 300]],
    outputs: [['t1grantee', 299.9]]
  },
  // A coinbase reward and a self-transfer both move the balance; neither is a flow.
  { height: 10 + 2 * DAY_BLOCKS, txid: 'cb', kind: 'coinbase', outputs: [[FOUND, 7.5]] },
  { height: 11 + 2 * DAY_BLOCKS, txid: 'self', inputs: [[FOUND, 100]], outputs: [[FOUND, 99.999]] },
  { height: 10 + 3 * DAY_BLOCKS, txid: 'sell', inputs: [[FOUND, 200]], outputs: [[KUCOIN, 199.9]] }
];

/** 1,000 - 300 + 7.5 - 0.001 - 200, plus 50 held from before the stored window. */
const CURRENT_SAT = Math.round((50 + 1_000 - 300 + 7.5 - 0.001 - 200) * SATS);
const snapshot = (sat: number, address = FOUND): BalanceSnapshot => ({
  at: 1_700_000_000_000,
  sat: new Map([[address, sat]])
});

describe('balance history', () => {
  let db: Db;
  let labels: LabelLookup;

  beforeEach(() => {
    db = createTestDb();
    labels = labelBook(db, LABELS);
    writeChain(db, labels, CHAIN);
  });

  afterEach(() => db.close());

  it("rebuilds daily closing balances backwards from today's", () => {
    const history = balanceHistory(db, [FOUND], snapshot(CURRENT_SAT));

    expect(history.balance).toBeCloseTo(557.499, 8);
    expect(history.opening).toBeCloseTo(50, 8);
    expect(history.consistent).toBe(true);
    expect(history.asOf).toBe(1_700_000_000_000);
    expect(history.series.map((point) => point.balance)).toEqual([
      expect.closeTo(1_050, 8),
      expect.closeTo(750, 8),
      expect.closeTo(757.499, 8),
      expect.closeTo(557.499, 8)
    ]);
    expect(history.series[0]!.time).toBe(Math.floor(blockTime(10) / 86_400) * 86_400);
  });

  it("matches the Foundation report's balance line (the #67 acceptance case)", () => {
    const balances = snapshot(CURRENT_SAT);
    const report = foundationReport(
      db,
      labels,
      { fromTime: 0, toTime: blockTime(20 * DAY_BLOCKS) },
      balances
    );
    const history = balanceHistory(db, [FOUND], balances);
    const byDay = new Map(history.series.map((point) => [point.time, point.balance]));

    expect(report.series.length).toBeGreaterThan(0);
    for (const point of report.series) {
      // The report leaves out the self-transfer (internal, within its 0.01 tolerance), so
      // on that day the two may differ by its fee at most.
      expect(Math.abs(byDay.get(point.time)! - point.balance!)).toBeLessThanOrEqual(0.001 + 1e-9);
    }
    expect(history.balance).toBe(report.totals.balance);
  });

  it('shows the running net change when no balance is known', () => {
    const history = balanceHistory(db, [FOUND], null);

    expect(history).toMatchObject({ balance: null, asOf: null, opening: null, consistent: true });
    expect(history.series.map((point) => point.balance)).toEqual([null, null, null, null]);
    expect(history.series.at(-1)!.change).toBeCloseTo(507.499, 8);
  });

  it('flags a history that would dip below zero as inconsistent', () => {
    // A balance 100 FLUX lower than the stored deltas allow: something is missing.
    const history = balanceHistory(db, [FOUND], snapshot(CURRENT_SAT - 100 * SATS));
    expect(history.opening).toBeCloseTo(-50, 8);
    expect(history.consistent).toBe(false);
  });

  it('treats a snapshot that misses an address as unknown', () => {
    const history = balanceHistory(db, [FOUND, 't1grantee'], snapshot(CURRENT_SAT));
    expect(history.balance).toBeNull();
  });

  it('sums several addresses, so a move between them nets to the fee', () => {
    const both = new Map([
      [FOUND, CURRENT_SAT],
      ['t1grantee', Math.round(299.9 * SATS)]
    ]);
    const history = balanceHistory(db, [FOUND, 't1grantee'], { at: 1, sat: both });
    // The grant to t1grantee is internal: that day loses only the 0.1 fee.
    expect(history.series[1]!.net).toBeCloseTo(-0.1, 8);
    expect(history.consistent).toBe(true);
  });
});

describe('balance cache', () => {
  const reply = (addresses: readonly string[], at = 1): BalanceSnapshot => ({
    at,
    sat: new Map(addresses.map((address) => [address, 100]))
  });

  it('shares one node call between concurrent requests and serves repeats from memory', async () => {
    const fetch = vi.fn(async (addresses: readonly string[]) => reply(addresses));
    const cache = new BalanceCache(fetch, { ttlMs: 1_000 });

    const [a, b] = await Promise.all([cache.get(['t1a'], 0), cache.get(['t1a'], 0)]);
    expect(a?.sat.get('t1a')).toBe(100);
    expect(b?.sat.get('t1a')).toBe(100);
    await cache.get(['t1a'], 500);
    expect(fetch).toHaveBeenCalledTimes(1);

    await cache.get(['t1a'], 1_500);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('asks only for what it lacks, and never more than the cap', async () => {
    const fetch = vi.fn(async (addresses: readonly string[]) => reply(addresses));
    const cache = new BalanceCache(fetch, { maxPerRequest: 2 });

    await cache.get(['t1a'], 0);
    await cache.get(['t1a', 't1b'], 0);
    expect(fetch).toHaveBeenLastCalledWith(['t1b']);

    expect(await cache.get(['t1c', 't1d', 't1e'], 0)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('survives a failing node', async () => {
    const cache = new BalanceCache(async () => {
      throw new Error('down');
    });
    expect(await cache.get(['t1a'])).toBeNull();
  });
});
