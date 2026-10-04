import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedFlows, SATS, type Db, type SeedFlow } from '../testkit.js';
import {
  listFlowEvents,
  resolvePeriod,
  summariseDatabase,
  summariseFlow,
  summariseUnknowns,
  openRange,
  unionOver
} from './queries.js';
import { leaderboard } from './wallets.js';

const NOW = 1_756_000_000;
const HOUR = 60 * 60;

function flow(overrides: Partial<SeedFlow> & { height: number; txid: string }): SeedFlow {
  return {
    time: NOW,
    fromAddress: 't1wallet',
    fromKind: 'unknown',
    toAddress: 't1wallet2',
    toKind: 'unknown',
    flowType: 'p2p',
    exchange: null,
    amountFlux: 1,
    ...overrides
  };
}

describe('resolvePeriod', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => db.close());

  it('returns a zero window for an empty database', () => {
    const window = resolvePeriod(db, NOW);

    expect(window).toMatchObject({ fromHeight: 0, toHeight: 0, toTime: 0 });
  });

  it('resolves a start height from block time, not from a block count', () => {
    // Heights 100..103 spanning three hours, with block times that are not 30s apart.
    seedFlows(
      db,
      [100, 101, 102, 103].map((height) =>
        flow({ txid: `t${height}`, height, time: NOW - (103 - height) * HOUR })
      )
    );

    const window = resolvePeriod(db, NOW - 2 * HOUR);

    expect(window.fromHeight).toBe(101);
    expect(window.toHeight).toBe(103);
  });

  it('falls back to the oldest block when the window predates all data', () => {
    seedFlows(db, [flow({ txid: 'a', height: 500, time: NOW })]);

    const window = resolvePeriod(db, NOW - 10 * HOUR);

    expect(window.fromHeight).toBe(500);
  });
});

describe('summariseFlow', () => {
  let db: Db;
  let window: ReturnType<typeof resolvePeriod>;

  beforeEach(() => {
    db = createTestDb();
    seedFlows(db, [
      flow({
        txid: 'b1',
        vout: 0,
        height: 1,
        toAddress: 't1node1',
        toKind: 'node_operator',
        flowType: 'buying',
        exchange: 'Kucoin',
        amountFlux: 10
      }),
      flow({
        txid: 'b2',
        vout: 0,
        height: 2,
        toAddress: 't1node2',
        toKind: 'node_operator',
        flowType: 'buying',
        exchange: 'Kucoin',
        amountFlux: 5
      }),
      flow({
        txid: 'b3',
        vout: 0,
        height: 3,
        toAddress: 't1whale',
        toKind: 'unknown',
        flowType: 'buying',
        exchange: 'Coinex',
        amountFlux: 2
      }),
      flow({
        txid: 's1',
        vout: 0,
        height: 4,
        fromAddress: 't1node1',
        fromKind: 'node_operator',
        flowType: 'selling',
        exchange: 'GateIO',
        amountFlux: 4
      }),
      // Outside the window: a distinct height, well before `fromTime` below.
      flow({
        txid: 'old',
        vout: 0,
        height: 0,
        time: NOW - 30 * 24 * 60 * 60,
        flowType: 'buying',
        amountFlux: 1_000
      })
    ]);

    window = resolvePeriod(db, NOW - HOUR);
  });

  afterEach(() => db.close());

  it('sums one direction only', () => {
    expect(summariseFlow(db, window, 'buying').totalSat).toBe(17);
    expect(summariseFlow(db, window, 'selling').totalSat).toBe(4);
  });

  it('counts events per direction', () => {
    expect(summariseFlow(db, window, 'buying').count).toBe(3);
  });

  it('groups by counterparty kind', () => {
    const buying = summariseFlow(db, window, 'buying');

    expect(buying.byKind).toEqual({ node_operator: 15, unknown: 2 });
  });

  it('groups by exchange', () => {
    const buying = summariseFlow(db, window, 'buying');

    expect(buying.byExchange).toEqual([
      { name: 'Kucoin', totalSat: 15, count: 2 },
      { name: 'Coinex', totalSat: 2, count: 1 }
    ]);
  });

  it('uses the source side for selling', () => {
    const selling = summariseFlow(db, window, 'selling');

    expect(selling.byKind).toEqual({ node_operator: 4 });
    expect(selling.byExchange).toEqual([{ name: 'GateIO', totalSat: 4, count: 1 }]);
  });

  it('returns zeros for an empty window rather than undefined', () => {
    const empty = summariseFlow(
      db,
      { fromHeight: 9_000, toHeight: 9_500, fromTime: 0, toTime: 0 },
      'buying'
    );

    expect(empty).toMatchObject({ totalSat: 0, count: 0, byKind: {}, byExchange: [] });
  });
});

describe('leaderboard', () => {
  let db: Db;
  let window: ReturnType<typeof resolvePeriod>;

  beforeEach(() => {
    db = createTestDb();
    seedFlows(
      db,
      Array.from({ length: 30 }, (_, index) =>
        flow({
          txid: `t${index}`,
          vout: 0,
          height: index + 1,
          toAddress: `t1buyer${index % 5}`,
          toKind: 'unknown',
          flowType: 'buying',
          exchange: 'Kucoin',
          amountFlux: (index % 5) + 1
        })
      )
    );
    window = resolvePeriod(db, 0);
  });

  afterEach(() => db.close());

  it('orders by total descending', () => {
    const top = leaderboard(db, openRange(window), 'buying', { limit: 5 }).leaders;

    expect(top[0]!.address).toBe('t1buyer4');
    expect(top[0]!.total).toBe(30);
  });

  it('aggregates several events per address', () => {
    const top = leaderboard(db, openRange(window), 'buying', { limit: 5 }).leaders;

    expect(top[0]!.count).toBe(6);
  });

  it('honours the limit', () => {
    expect(leaderboard(db, openRange(window), 'buying', { limit: 2 }).leaders).toHaveLength(2);
  });

  it('clamps a hostile limit instead of trusting it', () => {
    expect(leaderboard(db, openRange(window), 'buying', { limit: 10_000 }).leaders).toHaveLength(5);
    expect(leaderboard(db, openRange(window), 'buying', { limit: -1 }).leaders).toHaveLength(1);
  });

  it('lists the exchanges an address traded through', () => {
    const top = leaderboard(db, openRange(window), 'buying', { limit: 5 }).leaders;

    expect(top[0]!.exchanges).toEqual([{ name: 'Kucoin', total: 30, count: 6 }]);
  });
});

describe('listFlowEvents', () => {
  let db: Db;
  let window: ReturnType<typeof resolvePeriod>;

  beforeEach(() => {
    db = createTestDb();
    seedFlows(
      db,
      Array.from({ length: 10 }, (_, index) =>
        flow({
          txid: `tx${String(index).padStart(2, '0')}`,
          vout: 0,
          height: index + 1,
          toAddress: `t1buyer${index}`,
          toKind: index % 2 === 0 ? 'node_operator' : 'unknown',
          flowType: 'buying',
          exchange: 'Kucoin',
          amountFlux: index + 1
        })
      )
    );
    window = resolvePeriod(db, 0);
  });

  afterEach(() => db.close());

  it('returns newest first', () => {
    const page = listFlowEvents(db, window, { limit: 3 });

    expect(page.events.map((event) => event.height)).toEqual([10, 9, 8]);
  });

  it('reports a cursor when there is more', () => {
    const page = listFlowEvents(db, window, { limit: 3 });

    expect(page.nextCursor).toBe('8:tx07:0');
  });

  it('returns a null cursor on the last page', () => {
    const page = listFlowEvents(db, window, { limit: 50 });

    expect(page.nextCursor).toBeNull();
  });

  it('walks the whole set exactly once using the cursor', () => {
    const seen: number[] = [];
    let cursor: string | undefined;

    for (;;) {
      const page: ReturnType<typeof listFlowEvents> = listFlowEvents(db, window, {
        limit: 3,
        ...(cursor ? { cursor: parse(cursor) } : {})
      });

      seen.push(...page.events.map((event) => event.height));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
  });

  it('excludes the cursor row from the next page', () => {
    const first = listFlowEvents(db, window, { limit: 3 });
    const second = listFlowEvents(db, window, { limit: 3, cursor: parse(first.nextCursor!) });

    const firstIds = first.events.map((event) => `${event.height}:${event.txid}`);
    const secondIds = second.events.map((event) => `${event.height}:${event.txid}`);

    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
  });

  function parse(cursor: string): { height: number; txid: string; vout: number } {
    const [height, txid, vout] = cursor.split(':');
    return { height: Number(height), txid: txid!, vout: Number(vout) };
  }

  it('filters by flow type', () => {
    expect(listFlowEvents(db, window, { flowType: 'selling' }).events).toHaveLength(0);
    expect(listFlowEvents(db, window, { flowType: 'buying' }).events).toHaveLength(10);
  });

  it('filters by counterparty kind on either side', () => {
    expect(listFlowEvents(db, window, { kind: 'node_operator' }).events).toHaveLength(5);
  });

  it('filters by exchange', () => {
    expect(listFlowEvents(db, window, { exchange: 'Kucoin' }).events).toHaveLength(10);
    expect(listFlowEvents(db, window, { exchange: 'Nope' }).events).toHaveLength(0);
  });

  it('filters by a minimum amount', () => {
    expect(listFlowEvents(db, window, { minSat: 6 }).events).toHaveLength(5);
  });

  it('clamps the page size', () => {
    expect(listFlowEvents(db, window, { limit: 100_000 }).events).toHaveLength(10);
    expect(listFlowEvents(db, window, { limit: -5 }).events).toHaveLength(1);
  });

  it('never returns a full payload: a page is bounded and lightweight', () => {
    const page = listFlowEvents(db, window, { limit: 50 });

    expect(JSON.stringify(page).length).toBeLessThan(4_000);
    expect(page.events[0]!.amount).toBe(10);
  });
});

describe('summariseDatabase', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => db.close());

  it('reports zeroes for a fresh database', () => {
    expect(summariseDatabase(db)).toMatchObject({
      blocks: 0,
      flows: 0,
      missingBlocks: 0,
      minHeight: 0,
      maxHeight: 0
    });
  });

  it('counts blocks, flows and gaps', () => {
    seedFlows(db, [
      flow({ txid: 'a', height: 10, time: NOW }),
      flow({ txid: 'b', height: 12, time: NOW + HOUR })
    ]);
    db.prepare(`INSERT INTO missing_blocks (height) VALUES (11)`).run();

    const summary = summariseDatabase(db);

    expect(summary.blocks).toBe(2);
    expect(summary.flows).toBe(2);
    expect(summary.missingBlocks).toBe(1);
    expect(summary.minHeight).toBe(10);
    expect(summary.maxHeight).toBe(12);
    expect(summary.minTime).toBe(NOW);
    expect(summary.maxTime).toBe(NOW + HOUR);
  });

  it('reports a non-zero database size', () => {
    expect(summariseDatabase(db).dbSizeBytes).toBeGreaterThan(0);
  });
});

describe('summariseUnknowns', () => {
  let db: Db;
  let window: ReturnType<typeof resolvePeriod>;

  beforeEach(() => {
    db = createTestDb();
    seedFlows(db, [
      flow({ txid: 'u1', vout: 0, height: 1, flowType: 'buying', toKind: 'unknown' }),
      flow({ txid: 'u2', vout: 0, height: 2, flowType: 'buying', toKind: 'unknown' }),
      flow({
        txid: 'u3',
        vout: 0,
        height: 3,
        flowType: 'buying',
        toKind: 'node_operator'
      }),
      flow({ txid: 's1', vout: 0, height: 4, flowType: 'selling', fromKind: 'unknown' })
    ]);
    window = resolvePeriod(db, 0);
  });

  afterEach(() => db.close());

  it('counts unknowns on the correct side of each direction', () => {
    expect(summariseUnknowns(db, window)).toEqual({
      unknownBuys: 2,
      unknownSells: 1,
      totalUnknowns: 3
    });
  });
});

describe('value handling', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => db.close());

  it('stores satoshis as integers, not floats', () => {
    seedFlows(db, [flow({ txid: 'a', height: 1, amountFlux: 0.00000001 })]);

    const row = db.prepare<[], { sat: number }>(`SELECT sat FROM flows`).get();

    expect(row!.sat).toBe(1);
    expect(Number.isInteger(row!.sat)).toBe(true);
  });

  it('converts FLUX back out for display', () => {
    seedFlows(db, [flow({ txid: 'a', height: 1, flowType: 'buying', amountFlux: 2.5 })]);

    const window = resolvePeriod(db, NOW - HOUR);

    expect(summariseFlow(db, window, 'buying').totalSat).toBe(2.5);
    expect(SATS).toBe(100_000_000);
  });
});

describe('unionOver', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => db.close());

  const plan = (sql: string, params: (string | number)[]) =>
    db
      .prepare<(string | number)[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row) => row.detail)
      .join('\n');

  it('forces a requested index on its own level only', () => {
    const union = unionOver(
      [
        { level: 0, fromBucket: 1, toBucket: 2 },
        { level: 1, fromBucket: 0, toBucket: 0 }
      ],
      'selling',
      {
        tables: ['wallet_daily', 'wallet_monthly'],
        indexes: ['idx_wallet_daily_address'],
        rollupColumns: 'address, sat',
        rawColumns: 'from_address AS address, sat',
        rollupWhere: { sql: 'AND address IN (?)', params: ['t1a'] }
      }
    );

    expect(union.sql.match(/INDEXED BY/g)).toHaveLength(1);
    expect(plan(union.sql, union.params)).toMatch(/wallet_daily USING .*idx_wallet_daily_address/);
  });
});
