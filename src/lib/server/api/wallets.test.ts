import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedFlows, SATS, type Db, type SeedFlow } from '../testkit.js';
import { BlockWriter } from '../ingest/writer.js';
import { openDatabase } from '../db/database.js';
import { MIGRATIONS, migrate } from '../db/migrations.js';
import { createTestConfig } from '../testkit.js';
import { previousRange, resolvePeriod, summariseFlowRange, openRange } from './queries.js';
import { ADDRESS_PATTERN, leaderboard, search, walletEvents, walletProfile } from './wallets.js';

const DAY = 86_400;
const BASE = 1_740_000_000 - (1_740_000_000 % DAY);
const KINDS = ['unknown', 'node_operator', 'foundation'] as const;
const EXCHANGES = ['Kucoin', 'Coinex', 'GateIO'] as const;

/** A well-formed FLUX address with a readable stem. */
export function address(stem: string): string {
  return `t1${stem}`.padEnd(35, 'A');
}

const WALLETS = Array.from({ length: 12 }, (_, i) => address(`W${'abcdefghijkm'[i]}x`));

function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

/**
 * Flows over ~75 days (several 30-day buckets), ten minutes per block.
 * A wallet's kind is fixed, as a real label would be.
 */
function randomFlows(count: number, seed = 1): SeedFlow[] {
  const next = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;

  return Array.from({ length: count }, (_, i) => {
    const flowType = pick(['buying', 'selling', 'selling', 'p2p'] as const);
    const walletIndex = Math.floor(next() ** 2 * WALLETS.length);
    const wallet = WALLETS[walletIndex]!;
    const kind = KINDS[walletIndex % KINDS.length]!;
    const exchange = pick(EXCHANGES);
    const exchangeAddress = address(`X${exchange}`);
    const height = 1 + Math.floor(i / 2);
    const other = WALLETS[(walletIndex + 1) % WALLETS.length]!;

    return {
      txid: `tx-${i}`,
      vout: 0,
      height,
      time: BASE + height * 600,
      fromAddress:
        flowType === 'buying' ? exchangeAddress : flowType === 'selling' ? wallet : wallet,
      fromKind: flowType === 'buying' ? 'exchange' : kind,
      toAddress: flowType === 'buying' ? wallet : flowType === 'selling' ? exchangeAddress : other,
      toKind: flowType === 'selling' ? 'exchange' : flowType === 'buying' ? kind : 'unknown',
      flowType,
      exchange: flowType === 'p2p' ? null : exchange,
      amountFlux: Math.round(next() * 100_000) / 100
    };
  });
}

/** Wallet rollups vs raw, per (type, address, kind[, exchange]). Must be identical. */
function mismatches(db: Db): unknown[] {
  const side = `CASE flow_type WHEN 'buying' THEN to_address ELSE from_address END`;
  const kind = `CASE flow_type WHEN 'buying' THEN to_kind ELSE from_kind END`;

  return [
    ...db
      .prepare(
        `WITH raw AS (
           SELECT flow_type, ${side} AS address, ${kind} AS kind, COALESCE(exchange, '') AS exchange,
                  SUM(sat) AS sat, COUNT(*) AS count
           FROM flows WHERE flow_type IN ('buying', 'selling') GROUP BY 1, 2, 3, 4
         ), roll AS (
           SELECT flow_type, address, kind, exchange, SUM(sat) AS sat, SUM(count) AS count
           FROM wallet_daily GROUP BY 1, 2, 3, 4
         )
         SELECT * FROM raw FULL OUTER JOIN roll USING (flow_type, address, kind, exchange)
         WHERE raw.sat IS NOT roll.sat OR raw.count IS NOT roll.count`
      )
      .all(),
    ...db
      .prepare(
        `WITH raw AS (
           SELECT flow_type, ${side} AS address, ${kind} AS kind, SUM(sat) AS sat, COUNT(*) AS count
           FROM flows WHERE flow_type IN ('buying', 'selling') GROUP BY 1, 2, 3
         ), roll AS (
           SELECT flow_type, address, kind, SUM(sat) AS sat, SUM(count) AS count
           FROM wallet_monthly GROUP BY 1, 2, 3
         )
         SELECT * FROM raw FULL OUTER JOIN roll USING (flow_type, address, kind)
         WHERE raw.sat IS NOT roll.sat OR raw.count IS NOT roll.count`
      )
      .all()
  ];
}

/** The exact leaderboard, straight from raw rows. */
function rawLeaders(
  db: Db,
  flowType: string,
  from: number,
  to: number,
  kind?: string
): { address: string; total: number }[] {
  const side = flowType === 'buying' ? 'to' : 'from';
  return db
    .prepare<(string | number)[], { address: string; sat: number }>(
      `SELECT ${side}_address AS address, SUM(sat) AS sat FROM flows
       WHERE flow_type = ? AND time >= ? AND time < ? ${kind ? `AND ${side}_kind = ?` : ''}
       GROUP BY address ORDER BY sat DESC, address`
    )
    .all(flowType, from, to, ...(kind ? [kind] : []))
    .map((row) => ({ address: row.address, total: row.sat / SATS }));
}

const count = (db: Db, sql: string): number =>
  db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${sql}`).get()!.n;

describe('wallet rollups (#28, #30)', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => db.close());

  it('match raw sums after inserts', () => {
    seedFlows(db, randomFlows(2_000));
    expect(count(db, 'wallet_monthly')).toBeGreaterThan(0);
    expect(mismatches(db)).toEqual([]);
  });

  it('match raw sums after every flow is rewritten in place (a relabel)', () => {
    seedFlows(db, randomFlows(800));
    seedFlows(db, randomFlows(800, 42));
    expect(mismatches(db)).toEqual([]);
  });

  it('match raw sums after a reorg rollback', () => {
    seedFlows(db, randomFlows(1_000));
    new BlockWriter(db).rollbackFrom(300);
    expect(mismatches(db)).toEqual([]);
  });

  it('outlive raw data pruned by retention', () => {
    seedFlows(db, randomFlows(1_000));
    const sum = () =>
      db
        .prepare(
          `SELECT (SELECT SUM(sat) FROM wallet_daily) AS daily,
                  (SELECT SUM(sat) FROM wallet_monthly) AS monthly`
        )
        .get();
    const before = sum();

    new BlockWriter(db).pruneBefore(300);

    expect(count(db, 'flows WHERE height < 300')).toBe(0);
    expect(sum()).toEqual(before);
  });

  it('backfill a schema-2 database on upgrade', () => {
    const upgraded = openDatabase({
      config: createTestConfig(),
      log: { debug: () => {}, info: () => {}, error: () => {} } as never,
      inMemory: true
    });
    upgraded.transaction(() => {
      MIGRATIONS[0]!.up(upgraded);
      MIGRATIONS[1]!.up(upgraded);
      upgraded.pragma('user_version = 2');
    })();
    seedFlows(upgraded, randomFlows(600));

    expect(migrate(upgraded)).toMatchObject({ from: 2, to: MIGRATIONS.length });
    expect(mismatches(upgraded)).toEqual([]);
    upgraded.close();
  });
});

describe('leaderboard (#28)', () => {
  let db: Db;
  let maxTime: number;

  beforeEach(() => {
    db = createTestDb();
    seedFlows(db, randomFlows(4_000));
    maxTime = db.prepare<[], { t: number }>(`SELECT MAX(time) AS t FROM blocks`).get()!.t;
  });

  afterEach(() => db.close());

  it('ranks exactly over open windows that start mid-day', () => {
    for (const hoursBack of [5, 30, 24 * 7 + 3, 24 * 40 + 11, 24 * 70]) {
      const window = resolvePeriod(db, maxTime - hoursBack * 3_600);
      for (const flowType of ['buying', 'selling'] as const) {
        const board = leaderboard(db, openRange(window), flowType, { limit: 100 });
        const expected = rawLeaders(db, flowType, window.fromTime, maxTime + 1);

        expect(board.leaders.map((leader) => leader.address)).toEqual(
          expected.map((leader) => leader.address)
        );
        board.leaders.forEach((leader, index) =>
          expect(leader.total).toBeCloseTo(expected[index]!.total, 6)
        );
      }
    }
  });

  it('filters by counterparty kind', () => {
    const window = resolvePeriod(db, maxTime - 20 * DAY);
    const board = leaderboard(db, openRange(window), 'selling', { kind: 'node_operator' });
    const expected = rawLeaders(db, 'selling', window.fromTime, maxTime + 1, 'node_operator');

    expect(board.leaders.map((leader) => leader.address)).toEqual(
      expected.slice(0, 10).map((leader) => leader.address)
    );
    expect(board.leaders.every((leader) => leader.kind === 'node_operator')).toBe(true);
  });

  it('compares each leader with the same wallet over the previous equal window', () => {
    const window = resolvePeriod(db, maxTime - 9 * DAY - 5 * 3_600);
    const range = openRange(window);
    const before = previousRange(range);
    const board = leaderboard(db, range, 'selling', { limit: 5 });
    const previous = new Map(
      rawLeaders(db, 'selling', before.fromTime, before.toTime).map((row) => [
        row.address,
        row.total
      ])
    );

    for (const leader of board.leaders) {
      expect(leader.previousTotal).toBeCloseTo(previous.get(leader.address) ?? 0, 6);
      expect(leader.change).toBeCloseTo(leader.total - leader.previousTotal, 6);
    }
  });

  it('breaks each leader down by exchange, summing to its total', () => {
    const window = resolvePeriod(db, maxTime - 33 * DAY);
    const board = leaderboard(db, openRange(window), 'buying', { limit: 5 });

    for (const leader of board.leaders) {
      const sum = leader.exchanges.reduce((total, entry) => total + entry.total, 0);
      expect(sum).toBeCloseTo(leader.total, 6);
      expect(leader.share).toBeCloseTo(leader.total / board.total, 9);
      expect(leader.lastSeen).not.toBeNull();
    }
  });

  it('sums closed windows exactly (previous-period totals)', () => {
    const range = {
      fromTime: maxTime - 50 * DAY - 777,
      toTime: maxTime - 3 * DAY + 4_321,
      open: false
    };
    for (const flowType of ['buying', 'selling'] as const) {
      const raw = db
        .prepare<[string, number, number], { sat: number }>(
          `SELECT SUM(sat) AS sat FROM flows WHERE flow_type = ? AND time >= ? AND time < ?`
        )
        .get(flowType, range.fromTime, range.toTime)!.sat;
      expect(summariseFlowRange(db, range, flowType).totalSat).toBeCloseTo(raw / SATS, 6);
    }
  });
});

describe('wallet profile, events and search (#30)', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    seedFlows(db, randomFlows(1_500));
  });

  afterEach(() => db.close());

  it('totals a wallet exactly', () => {
    const wallet = WALLETS[0]!;
    const profile = walletProfile(db, wallet)!;
    const raw = (sql: string) =>
      (db.prepare<[string], { sat: number | null }>(sql).get(wallet)!.sat ?? 0) / SATS;

    expect(profile.totals.bought).toBeCloseTo(
      raw(`SELECT SUM(sat) AS sat FROM flows WHERE flow_type = 'buying' AND to_address = ?`),
      6
    );
    expect(profile.totals.sold).toBeCloseTo(
      raw(`SELECT SUM(sat) AS sat FROM flows WHERE flow_type = 'selling' AND from_address = ?`),
      6
    );
    expect(profile.totals.p2pOut).toBeCloseTo(
      raw(`SELECT SUM(sat) AS sat FROM flows WHERE flow_type = 'p2p' AND from_address = ?`),
      6
    );
    expect(profile.firstSeen).toBeLessThanOrEqual(profile.lastSeen!);
    expect(profile.series.length).toBeGreaterThan(0);
  });

  it('is null for a wallet with no activity', () => {
    expect(walletProfile(db, address('Nobody'))).toBeNull();
  });

  it('pages a wallet history without gaps or repeats', () => {
    const wallet = WALLETS[1]!;
    const all = db
      .prepare<[string, string], { txid: string }>(
        `SELECT txid FROM flows WHERE from_address = ? OR to_address = ?
         ORDER BY height DESC, txid DESC, vout DESC`
      )
      .all(wallet, wallet)
      .map((row) => row.txid);

    const seen: string[] = [];
    let cursor: { height: number; txid: string; vout: number } | undefined;
    for (;;) {
      const page = walletEvents(db, wallet, { limit: 7, ...(cursor ? { cursor } : {}) });
      seen.push(...page.events.map((event) => event.txid));
      if (!page.nextCursor) break;
      const [height, txid, vout] = page.nextCursor.split(':');
      cursor = { height: Number(height), txid: txid!, vout: Number(vout) };
    }

    expect(seen).toEqual(all);
  });

  it('finds wallets by prefix and transactions by txid', () => {
    expect(search(db, WALLETS[2]!.slice(0, 6))).toContainEqual({
      type: 'wallet',
      address: WALLETS[2]!,
      name: null
    });
    expect(search(db, 'tx-1'.padEnd(64, '0'))).toEqual([]);
  });

  it('finds wallets by label name', () => {
    db.prepare(
      `INSERT INTO address_labels (address, kind, name, source) VALUES (?, 'exchange', 'Kucoin Hot', 'test')`
    ).run(address('XKucoin'));

    expect(search(db, 'kucoin')).toEqual([
      { type: 'wallet', address: address('XKucoin'), name: 'Kucoin Hot' }
    ]);
    // LIKE wildcards in the query are literal, not a way to list every label.
    expect(search(db, '%%')).toEqual([]);
  });

  it('validates addresses strictly', () => {
    expect(ADDRESS_PATTERN.test(address('ok'))).toBe(true);
    expect(ADDRESS_PATTERN.test('t1short')).toBe(false);
    expect(ADDRESS_PATTERN.test(`t1${'0'.repeat(33)}`)).toBe(false);
    expect(ADDRESS_PATTERN.test(`t1${'A'.repeat(33)}' OR 1=1`)).toBe(false);
  });
});
