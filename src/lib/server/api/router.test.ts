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
