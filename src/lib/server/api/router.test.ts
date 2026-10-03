import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FailoverDataSource } from '../ingest/datasource/circuitbreaker.js';
import { loadLabels } from '../labels.js';
import {
  createTestConfig,
  createTestDb,
  fakeDataSource,
  seedFlows,
  silentLogger,
  startTestServer,
  type Db,
  type TestServer
} from '../testkit.js';
import { ApiError, createApiRouter, errorHandler } from './router.js';

const NOW = 1_756_000_000;

describe('api router', () => {
  let db: Db;
  let server: TestServer;
  let health: {
    startedAt: number;
    lastSuccessfulSyncAt: number | null;
    degraded(): { degraded: boolean; reason: string | null };
  };

  async function boot(
    options: {
      lastSync?: number | null;
      degraded?: { degraded: boolean; reason: string | null };
    } = {}
  ): Promise<void> {
    const config = createTestConfig();
    const labels = loadLabels(db, config, silentLogger());
    const dataSource = new FailoverDataSource({
      sources: [fakeDataSource()],
      config,
      log: silentLogger()
    });

    health = {
      startedAt: Date.now(),
      lastSuccessfulSyncAt: options.lastSync === undefined ? NOW * 1000 : options.lastSync,
      degraded: () => options.degraded ?? { degraded: false, reason: null }
    };

    const app = express();
    app.use('/api', express.json());
    app.use(
      '/api',
      createApiRouter({ config, db, labels, dataSource, log: silentLogger(), health })
    );
    app.use('/api', errorHandler(config, silentLogger()));

    server = await startTestServer(app);
  }

  beforeAll(() => {
    db = createTestDb();
  });

  afterAll(() => {
    db.close();
  });

  afterEach(async () => {
    await server?.close();
    db.exec('DELETE FROM flows; DELETE FROM blocks; DELETE FROM tx_deltas;');
  });

  function seed(): void {
    seedFlows(db, [
      {
        txid: 'b1',
        vout: 0,
        height: 10,
        time: NOW,
        fromAddress: 't1coinex1',
        fromKind: 'exchange',
        toAddress: 't1node1',
        toKind: 'node_operator',
        flowType: 'buying',
        exchange: 'Coinex',
        amountFlux: 100
      },
      {
        txid: 's1',
        vout: 0,
        height: 11,
        time: NOW,
        fromAddress: 't1node1',
        fromKind: 'node_operator',
        toAddress: 't1coinex1',
        toKind: 'exchange',
        flowType: 'selling',
        exchange: 'Coinex',
        amountFlux: 40
      }
    ]);
  }

  async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${server.url}${path}`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  describe('GET /api/health', () => {
    it('is 200 and ok when sync is fresh', async () => {
      await boot();

      const { status, body } = await get('/api/health');

      expect(status).toBe(200);
      expect(body.status).toBe('ok');
      expect(typeof body.uptimeSeconds).toBe('number');
      // A redeploy checks this to be sure the new build is the one answering.
      expect(body.version).toBe('dev');
    });

    it('is 503 and degraded when sync has never succeeded', async () => {
      await boot({
        lastSync: null,
        degraded: { degraded: true, reason: 'no successful sync yet' }
      });

      const { status, body } = await get('/api/health');

      // v1 returned 200 with status ok here, which is why a stalled service looked healthy.
      expect(status).toBe(503);
      expect(body.status).toBe('degraded');
      expect(body.reason).toBe('no successful sync yet');
    });

    it('is 503 when sync is stale', async () => {
      await boot({ degraded: { degraded: true, reason: 'last successful sync was 900s ago' } });

      expect((await get('/api/health')).status).toBe(503);
    });

    it('runs no table scans: the whole response is field reads', async () => {
      await boot();

      // A healthcheck that scans cannot stay fast as the database grows (#3).
      const original = db.prepare.bind(db);
      let statements = 0;
      // Swapped in place to count statements issued by this one request.
      db.prepare = ((sql: string) => {
        statements++;
        return original(sql);
      }) as typeof db.prepare;

      await get('/api/health');
      db.prepare = original;

      expect(statements).toBe(0);
    });
  });

  describe('GET /api/status', () => {
    it('reports sync, database and data-source state', async () => {
      await boot();
      seed();

      const { status, body } = await get('/api/status');

      expect(status).toBe(200);
      expect(body.sync).toMatchObject({ enabled: true, latestHeight: 11, degraded: false });
      expect(body.database).toMatchObject({ blocks: 2, flows: 2, missingBlocks: 0 });
      expect(body.dataSources).toMatchObject({ active: 'fake' });
      // 7 exchange addresses and 17 Foundation addresses in the real config/labels.json.
      expect(body.labels).toMatchObject({ exchanges: 7, foundation: 17 });
    });
  });

  describe('GET /api/flow/:period', () => {
    it('reports that it is still syncing when there is no data', async () => {
      await boot();

      const { body } = await get('/api/flow/24H');

      expect(body.ready).toBe(false);
      expect(body.partial).toBe(false);
      expect(body.progress).toBe(0);
      expect(body.message).toMatch(/No data available yet/);
    });

    it('aggregates totals in SQL, not in JS', async () => {
      await boot();
      seed();

      const { body } = await get('/api/flow/24H');

      expect(body.buying).toMatchObject({ total: 100, count: 1 });
      expect(body.selling).toMatchObject({ total: 40, count: 1 });
      expect(body.netFlow).toBe(60);
    });

    it('keeps the breakdown keys the existing UI reads', async () => {
      await boot();
      seed();

      const { body } = await get('/api/flow/24H');
      const buying = body.buying as Record<string, Record<string, number>>;

      expect(buying.breakdown).toHaveProperty('toNodeOperators', 100);
      expect(buying.breakdown).toHaveProperty('toUnknown', 0);
      expect(buying.breakdown).toHaveProperty('toFoundation', 0);
    });

    it('groups by exchange', async () => {
      await boot();
      seed();

      const { body } = await get('/api/flow/24H');

      expect((body.buying as Record<string, unknown>).byExchange).toEqual({
        Coinex: { name: 'Coinex', total: 100, count: 1 }
      });
    });

    it('flags a partial period rather than pretending it is complete', async () => {
      await boot();
      seed();

      const { body } = await get('/api/flow/6M');

      expect(body.partial).toBe(true);
      expect(body.partialWarning).toMatch(/incomplete/);
    });

    it('rejects an unknown period', async () => {
      await boot();

      const { status, body } = await get('/api/flow/1Y');

      expect(status).toBe(400);
      expect(body.error).toBe('Invalid period');
    });

    it('does not accept a period that tries to inject SQL', async () => {
      await boot();

      const { status } = await get(`/api/flow/${encodeURIComponent("24H' OR 1=1--")}`);

      expect(status).toBe(400);
    });
  });

  describe('GET /api/flow/:period/events', () => {
    it('pages events with a cursor instead of returning the whole period', async () => {
      await boot();
      seedFlows(
        db,
        Array.from({ length: 5 }, (_, index) => ({
          txid: `tx${index}`,
          vout: 0,
          height: 100 + index,
          time: NOW,
          fromAddress: 't1coinex1',
          fromKind: 'exchange' as const,
          toAddress: `t1w${index}`,
          toKind: 'unknown' as const,
          flowType: 'buying' as const,
          exchange: 'Coinex',
          amountFlux: index + 1
        }))
      );

      const first = await get('/api/flow/24H/events?limit=2');
      const body = first.body as { events: unknown[]; nextCursor: string };

      expect(body.events).toHaveLength(2);
      expect(body.nextCursor).toBeTruthy();

      const second = await get(`/api/flow/24H/events?limit=2&cursor=${body.nextCursor}`);

      expect((second.body as { events: unknown[] }).events).toHaveLength(2);
    });

    it('rejects a malformed cursor rather than silently ignoring it', async () => {
      await boot();
      seed();

      const { status, body } = await get('/api/flow/24H/events?cursor=garbage');

      expect(status).toBe(400);
      expect(body.error).toBe('Invalid cursor');
    });

    it('filters by type, kind and exchange', async () => {
      await boot();
      seed();

      expect((await get('/api/flow/24H/events?type=buying')).body.events).toHaveLength(1);
      expect((await get('/api/flow/24H/events?type=p2p')).body.events).toHaveLength(0);
      // `kind` matches the counterparty on either side, so the node operator matches both
      // the buy it received and the sell it sent.
      expect((await get('/api/flow/24H/events?kind=node_operator')).body.events).toHaveLength(2);
      expect((await get('/api/flow/24H/events?kind=foundation')).body.events).toHaveLength(0);
      expect((await get('/api/flow/24H/events?exchange=Coinex')).body.events).toHaveLength(2);
      expect((await get('/api/flow/24H/events?exchange=Nope')).body.events).toHaveLength(0);
    });

    it('clamps a hostile page size', async () => {
      await boot();
      seed();

      expect((await get('/api/flow/24H/events?limit=100000')).body.events).toHaveLength(2);
    });
  });

  describe('GET /api/flow/:period/{buyers,sellers}', () => {
    it('lists top buyers by total', async () => {
      await boot();
      seed();

      const { body } = await get('/api/flow/24H/buyers?limit=5');
      const buyers = body.buyers as { address: string; total: number }[];

      expect(buyers[0]).toMatchObject({ address: 't1node1', total: 100 });
    });

    it('lists top sellers by total', async () => {
      await boot();
      seed();

      const { body } = await get('/api/flow/24H/sellers');
      const sellers = body.sellers as { address: string; total: number }[];

      expect(sellers[0]).toMatchObject({ address: 't1node1', total: 40 });
    });

    it('rejects an unknown period', async () => {
      await boot();

      expect((await get('/api/flow/nope/buyers')).status).toBe(400);
    });
  });

  describe('wallets, leaderboards and series (#28, #29, #30)', () => {
    const WHALE = 't1WhaLe'.padEnd(35, 'A');
    const KUCOIN = 't1Kuc'.padEnd(35, 'B');

    function seedWallet(): void {
      seedFlows(db, [
        {
          txid: 'w1',
          height: 20,
          time: NOW - 3_600,
          fromAddress: KUCOIN,
          fromKind: 'exchange',
          toAddress: WHALE,
          toKind: 'unknown',
          flowType: 'buying',
          exchange: 'Kucoin',
          amountFlux: 500
        },
        {
          txid: 'w2',
          height: 21,
          time: NOW,
          fromAddress: WHALE,
          fromKind: 'unknown',
          toAddress: KUCOIN,
          toKind: 'exchange',
          flowType: 'selling',
          exchange: 'Kucoin',
          amountFlux: 200
        }
      ]);
    }

    it('ranks sellers with breakdown, previous period and name', async () => {
      await boot();
      seedWallet();

      const { status, body } = await get('/api/flow/24H/sellers');
      const [first] = body.sellers as Record<string, unknown>[];

      expect(status).toBe(200);
      expect(body.total).toBe(200);
      expect(first).toMatchObject({
        rank: 1,
        address: WHALE,
        total: 200,
        share: 1,
        previousTotal: 0,
        change: 200,
        exchanges: [{ name: 'Kucoin', total: 200, count: 1 }]
      });
      expect(first).toHaveProperty('name');
    });

    it('rejects an unknown leaderboard kind', async () => {
      await boot();
      expect((await get('/api/flow/24H/buyers?kind=everyone')).status).toBe(400);
    });

    it('adds previous-period deltas and per-type totals to the summary', async () => {
      await boot();
      seedWallet();

      const { body } = await get('/api/flow/24H');
      expect(body.previousPeriod).toMatchObject({ buying: { total: 0 }, selling: { total: 0 } });
      expect(body.byType).toMatchObject({ buying: { unknown: 500 }, selling: { unknown: 200 } });
    });

    it('serves an hourly net-flow series whose buckets sum to the period', async () => {
      await boot();
      seedWallet();

      const { body } = await get('/api/flow/24H/series');
      const points = body.points as { buying: number; selling: number; cumulativeNet: number }[];

      expect(body.bucketSeconds).toBe(3_600);
      expect(points.reduce((sum, point) => sum + point.buying, 0)).toBe(500);
      expect(points.reduce((sum, point) => sum + point.selling, 0)).toBe(200);
      expect(points.at(-1)!.cumulativeNet).toBe(300);
      expect((await get('/api/flow/24H/series?kind=nope')).status).toBe(400);
    });

    it('serves a wallet profile with recent events', async () => {
      await boot();
      seedWallet();

      const { status, body } = await get(`/api/wallets/${WHALE}`);

      expect(status).toBe(200);
      expect(body.totals).toMatchObject({ bought: 500, sold: 200, net: 300 });
      expect((body.recent as { events: unknown[] }).events).toHaveLength(2);
    });

    it('answers 400 for a malformed address and 404 for an unknown one', async () => {
      await boot();

      expect((await get('/api/wallets/not-an-address')).status).toBe(400);
      expect((await get(`/api/wallets/${'t1Nobody'.padEnd(35, 'C')}`)).status).toBe(404);
    });

    it('pages wallet events and validates the cursor', async () => {
      await boot();
      seedWallet();

      const first = await get(`/api/wallets/${WHALE}/events?limit=1`);
      expect(first.body.events).toHaveLength(1);

      const second = await get(
        `/api/wallets/${WHALE}/events?limit=1&cursor=${String(first.body.nextCursor)}`
      );
      expect((second.body.events as { txid: string }[])[0]!.txid).toBe('w1');
      expect((await get(`/api/wallets/${WHALE}/events?cursor=bad`)).status).toBe(400);
    });

    it('searches by address prefix, and bounds the query', async () => {
      await boot();
      seedWallet();

      const { body } = await get('/api/search?q=t1WhaL');
      expect(body.results).toContainEqual(
        expect.objectContaining({ type: 'wallet', address: WHALE })
      );
      expect((await get('/api/wallets/search?q=x')).status).toBe(400);
      expect((await get(`/api/wallets/search?q=${'a'.repeat(65)}`)).status).toBe(400);
    });
  });

  describe('compatibility endpoints', () => {
    it('keeps /blocks/status, /database/stats and /classification/stats alive for the UI', async () => {
      await boot();
      seed();

      expect((await get('/api/blocks/status')).body).toMatchObject({ blockCount: 2 });
      expect((await get('/api/database/stats')).body).toMatchObject({ blocks: 2 });
      expect((await get('/api/classification/stats')).body).toMatchObject({
        exchanges: { count: 7 },
        foundation: { count: 17 }
      });
      expect((await get('/api/classifications/stats')).status).toBe(200);
    });

    it('reports unknowns', async () => {
      await boot();
      seed();

      expect((await get('/api/unknowns/stats')).body).toMatchObject({ totalUnknowns: 0 });
    });

    it('answers the removed enhancement endpoints honestly instead of pretending to run', async () => {
      await boot();

      expect((await get('/api/enhance-wallets/status')).body).toMatchObject({ isRunning: false });
      expect((await get('/api/enhancement/background/status')).body).toMatchObject({
        enabled: false
      });
    });
  });

  describe('error handling', () => {
    it('returns a generic message for an unknown failure in production', async () => {
      const config = createTestConfig();
      const app = express();
      app.get('/api/boom', () => {
        throw new Error('secret internal detail: /app/data/flux-flow.db');
      });
      app.use('/api', errorHandler({ ...config, isProduction: true }, silentLogger()));

      server = await startTestServer(app);
      const response = await fetch(`${server.url}/api/boom`);
      const body = (await response.json()) as Record<string, unknown>;

      // v1 returned error.message verbatim, leaking file paths to the browser.
      expect(response.status).toBe(500);
      expect(body.error).toBe('Internal server error');
      expect(JSON.stringify(body)).not.toContain('flux-flow.db');
    });

    it('includes the detail outside production to help debugging', async () => {
      const config = createTestConfig();
      const app = express();
      app.get('/api/boom', () => {
        throw new Error('useful detail');
      });
      app.use('/api', errorHandler(config, silentLogger()));

      server = await startTestServer(app);

      expect((await get('/api/boom')).body.detail).toBe('useful detail');
    });

    it('describes an ApiError to the client', async () => {
      const app = express();
      app.get('/api/boom', () => {
        throw ApiError.unauthorized();
      });
      app.use('/api', errorHandler(createTestConfig(), silentLogger()));

      server = await startTestServer(app);
      const { status, body } = await get('/api/boom');

      expect(status).toBe(401);
      expect(body.error).toBe('unauthorized');
    });
  });
});
