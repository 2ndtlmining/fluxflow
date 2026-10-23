import express from 'express';
import { replaceBehaviourTags } from '../intel/behaviour.js';
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
import { BalanceCache } from './balances.js';

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
      balances?: BalanceCache;
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
      createApiRouter({
        config,
        db,
        labels,
        dataSource,
        log: silentLogger(),
        health,
        ...(options.balances ? { balances: options.balances } : {})
      })
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

  async function send(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
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
      // 7 exchange addresses and 38 Foundation addresses in the real config/labels.json.
      expect(body.labels).toMatchObject({ exchanges: 7, foundation: 38 });
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

    it('rejects a hostile page size with the reason, rather than guessing (#21)', async () => {
      await boot();
      seed();

      const { status, body } = await get('/api/flow/24H/events?limit=100000');

      expect(status).toBe(400);
      expect(body.issues).toEqual([expect.objectContaining({ parameter: 'limit' })]);
    });

    it('rejects unknown filter values instead of ignoring them (#21)', async () => {
      await boot();

      expect((await get('/api/flow/24H/events?type=dumping')).status).toBe(400);
      expect((await get('/api/flow/24H/events?kind=whale')).status).toBe(400);
      expect((await get('/api/flow/24H/events?minAmount=-5')).status).toBe(400);
      expect((await get('/api/flow/24H/buyers?limit=0')).status).toBe(400);
      expect((await get('/api/flow/24H/sellers?limit=abc')).status).toBe(400);
    });

    it('accepts valid filters', async () => {
      await boot();
      seed();

      const { status } = await get('/api/flow/24H/events?type=buying&kind=node_operator&limit=10');
      expect(status).toBe(200);
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

    it('shows behaviour tags on leaderboard rows and filters by them (#68)', async () => {
      await boot();
      seedWallet();
      const OTHER = 't1Other'.padEnd(35, 'D');
      seedFlows(db, [
        {
          txid: 'w3',
          height: 21,
          time: NOW,
          fromAddress: OTHER,
          fromKind: 'unknown',
          toAddress: KUCOIN,
          toKind: 'exchange',
          flowType: 'selling',
          exchange: 'Kucoin',
          amountFlux: 900
        }
      ]);
      replaceBehaviourTags(db, [
        { address: WHALE, tag: 'automated', evidence: { sends: 150 } },
        { address: WHALE, tag: 'recurring_payer', evidence: { payments: 40 } }
      ]);

      const all = await get('/api/flow/24H/sellers');
      const rows = all.body.sellers as { address: string; tags: string[] }[];
      expect(rows.map((row) => [row.address, row.tags])).toEqual([
        [OTHER, []],
        [WHALE, ['recurring_payer', 'automated']]
      ]);

      const tagged = await get('/api/flow/24H/sellers?tag=automated');
      expect(tagged.body.tag).toBe('automated');
      expect((tagged.body.sellers as { address: string }[]).map((row) => row.address)).toEqual([
        WHALE
      ]);

      expect((await get('/api/flow/24H/sellers?tag=whale')).status).toBe(400);

      const profile = await get(`/api/wallets/${WHALE}`);
      expect(profile.body.tags).toEqual([
        expect.objectContaining({ tag: 'recurring_payer', evidence: { payments: 40 } }),
        expect.objectContaining({ tag: 'automated', evidence: { sends: 150 } })
      ]);
    });

    it('narrows the summary, leaderboards, events and hops to a range inside the period (#29)', async () => {
      await boot();
      seedWallet();
      // Covers the 500 FLUX withdrawal an hour ago, not the 200 FLUX deposit now.
      const range = `from=${NOW - 7_200}&to=${NOW - 1_800}`;

      const summary = await get(`/api/flow/24H?${range}`);
      expect(summary.status).toBe(200);
      expect(summary.body).toMatchObject({
        // Clamped to the oldest stored block, the withdrawal itself.
        range: { from: NOW - 3_600, to: NOW - 1_800 },
        buying: { total: 500 },
        selling: { total: 0 }
      });
      // The whole period still sees both.
      expect((await get('/api/flow/24H')).body).toMatchObject({
        range: null,
        buying: { total: 500 },
        selling: { total: 200 }
      });

      const buyers = await get(`/api/flow/24H/buyers?${range}`);
      expect((buyers.body.buyers as { address: string }[]).map((row) => row.address)).toEqual([
        WHALE
      ]);
      expect((await get(`/api/flow/24H/sellers?${range}`)).body.sellers).toEqual([]);

      const events = await get(`/api/flow/24H/events?${range}`);
      expect((events.body.events as { txid: string }[]).map((event) => event.txid)).toEqual(['w1']);

      expect((await get(`/api/flow/24H/hops?${range}`)).status).toBe(200);
    });

    it('clamps a range to the period and rejects a malformed one (#29)', async () => {
      await boot();
      seedWallet();

      // Starting before the 24H window is clamped rather than refused: to the window, and
      // further to the oldest stored block (here the withdrawal, an hour ago).
      const wide = await get(`/api/flow/24H?from=${NOW - 10 * 86_400}&to=${NOW - 1_800}`);
      expect(wide.status).toBe(200);
      expect((wide.body.range as { from: number }).from).toBe(NOW - 3_600);

      for (const bad of [
        `from=${NOW}`,
        `from=${NOW}&to=${NOW - 60}`,
        'from=abc&to=def',
        `from=${NOW - 30 * 86_400}&to=${NOW - 20 * 86_400}`
      ]) {
        expect((await get(`/api/flow/24H?${bad}`)).status, bad).toBe(400);
      }
    });

    it('finds a path between two wallets and validates the query (#70)', async () => {
      await boot();
      seedWallet();

      const found = await get(`/api/path?src=${WHALE}&dst=${KUCOIN}`);
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({ src: WHALE, dst: KUCOIN, maxHops: 4, truncated: false });
      expect(found.body.paths).toEqual([
        expect.objectContaining({
          bottleneck: 200,
          hops: [expect.objectContaining({ from: WHALE, to: KUCOIN, total: 200, internal: false })]
        })
      ]);

      for (const bad of [
        `src=nope&dst=${KUCOIN}`,
        `src=${WHALE}`,
        `src=${WHALE}&dst=${KUCOIN}&maxHops=9`,
        `src=${WHALE}&dst=${KUCOIN}&through=everything`
      ]) {
        expect((await get(`/api/path?${bad}`)).status, bad).toBe(400);
      }
    });

    it('keeps a note on a wallet, shows it on its page and finds it in search (#69)', async () => {
      await boot();
      seedWallet();

      const saved = await send('PUT', `/api/notes/${WHALE}`, {
        note: 'Flux paying for its own app deployments',
        tags: ['team', 'apps']
      });
      expect(saved.status).toBe(200);

      const profile = await get(`/api/wallets/${WHALE}`);
      expect(profile.body.note).toMatchObject({
        note: 'Flux paying for its own app deployments',
        tags: ['team', 'apps']
      });

      // By note text, and by tag; the match carries the note.
      for (const q of ['own%20app', 'apps']) {
        const found = await get(`/api/search?q=${q}`);
        expect(found.body.results, q).toEqual([
          expect.objectContaining({
            address: WHALE,
            note: expect.objectContaining({ tags: ['team', 'apps'] })
          })
        ]);
      }

      expect((await send('PUT', `/api/notes/${WHALE}`, { tags: ['<script>'] })).status).toBe(400);
      expect((await send('PUT', `/api/notes/${WHALE}`, { note: 'x'.repeat(4_001) })).status).toBe(
        400
      );
      expect((await send('PUT', '/api/notes/nope', { note: 'x' })).status).toBe(400);
    });

    it('saves a case with five addresses and a graph view, reopens, changes and deletes it (#69)', async () => {
      await boot();
      seedWallet();
      const FIVE = [WHALE, KUCOIN, ...['t1A', 't1B', 't1C'].map((p) => p.padEnd(35, 'Z'))];

      const created = await send('POST', '/api/cases', {
        name: 'Whale cycling through Kucoin',
        addresses: FIVE,
        graph: { root: WHALE, period: '24h', expand: [`${WHALE}:out`] }
      });
      expect(created.status).toBe(201);
      const id = created.body.id as string;

      const opened = await get(`/api/cases/${id}`);
      expect(opened.body).toMatchObject({
        name: 'Whale cycling through Kucoin',
        addresses: FIVE,
        graph: { root: WHALE, period: '24H', min: 0, expand: [`${WHALE}:out`] }
      });
      expect((opened.body.members as { address: string; kind: string }[])[1]).toMatchObject({
        address: KUCOIN
      });
      expect((await get('/api/cases')).body.cases).toEqual([
        expect.objectContaining({ id, count: 5 })
      ]);
      expect((await get(`/api/wallets/${WHALE}`)).body.cases).toEqual([
        { id, name: 'Whale cycling through Kucoin' }
      ]);

      expect((await send('PATCH', `/api/cases/${id}`, { name: 'Renamed' })).status).toBe(200);
      expect((await get(`/api/cases/${id}`)).body).toMatchObject({
        name: 'Renamed',
        addresses: FIVE
      });

      expect((await send('DELETE', `/api/cases/${id}`)).status).toBe(200);
      expect((await get(`/api/cases/${id}`)).status).toBe(404);
      expect((await send('DELETE', `/api/cases/${id}`)).status).toBe(404);
    });

    it('validates cases (#69)', async () => {
      await boot();
      for (const bad of [
        {},
        { name: '' },
        { name: 'x', addresses: ['nope'] },
        { name: 'x', graph: { root: 'nope' } },
        { name: 'x', graph: { root: WHALE, expand: [`${WHALE}:sideways`] } }
      ]) {
        expect((await send('POST', '/api/cases', bad)).status, JSON.stringify(bad)).toBe(400);
      }
      expect((await send('PATCH', '/api/cases/none', { name: 'x' })).status).toBe(404);
      expect((await send('PATCH', '/api/cases/none', {})).status).toBe(400);
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

    it('serves source and destination of funds, and bounds the hop count', async () => {
      await boot();
      seedWallet();

      const sources = await get(`/api/wallets/${WHALE}/sources?hops=2`);
      expect(sources.status).toBe(200);
      expect(sources.body).toMatchObject({ address: WHALE, direction: 'in', hops: 2 });

      const destinations = await get(`/api/wallets/${WHALE}/destinations`);
      expect(destinations.body).toMatchObject({ direction: 'out', hops: 3, truncated: false });

      expect((await get(`/api/wallets/${WHALE}/sources?hops=9`)).status).toBe(400);
      expect((await get('/api/wallets/not-an-address/sources')).status).toBe(400);
    });

    it('serves the fund-flow graph and validates its query', async () => {
      await boot();
      seedWallet();

      const { status, body } = await get(`/api/graph?address=${WHALE}&period=30d`);
      expect(status).toBe(200);
      expect(body).toMatchObject({ root: WHALE, direction: 'both', depth: 1, truncated: false });
      expect((body.nodes as { address: string }[]).map((node) => node.address)).toContain(WHALE);

      expect((await get('/api/graph?address=nope')).status).toBe(400);
      expect((await get(`/api/graph?address=${WHALE}&depth=9`)).status).toBe(400);
      expect((await get(`/api/graph?address=${WHALE}&period=1Y`)).status).toBe(400);
    });

    it("serves a wallet's balance history, anchored on the node's balance", async () => {
      await boot({
        balances: new BalanceCache(async (addresses) => ({
          at: 1,
          sat: new Map(addresses.map((address) => [address, 1_000 * 1e8]))
        }))
      });
      // Deltas, not flows, drive the balance: 500 in on one day, 200 out the next.
      db.prepare(
        `INSERT INTO tx_deltas (txid, address, height, time, sat_in, sat_out) VALUES
           ('b1', ?, 20, ?, 0, 50000000000), ('b2', ?, 21, ?, 20000000000, 0)`
      ).run(WHALE, NOW - 86_400, WHALE, NOW);

      const { status, body } = await get(`/api/wallets/${WHALE}/balance`);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        address: WHALE,
        balance: 1_000,
        opening: 700,
        consistent: true
      });
      expect((body.series as { balance: number }[]).map((point) => point.balance)).toEqual([
        1_200, 1_000
      ]);
      expect((await get('/api/wallets/nope/balance')).status).toBe(400);
    });

    it('serves balance history as net change when no node is configured', async () => {
      await boot();
      const { status, body } = await get(`/api/wallets/${WHALE}/balance`);
      expect(status).toBe(200);
      expect(body).toMatchObject({ balance: null, series: [] });
    });

    it('serves a transaction and validates its id', async () => {
      await boot();
      const txid = 'ab'.repeat(32);
      seedFlows(db, [
        {
          txid,
          height: 22,
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

      const { status, body } = await get(`/api/tx/${txid.toUpperCase()}`);
      expect(status).toBe(200);
      expect(body).toMatchObject({ txid, height: 22 });
      expect(body.flows).toEqual([
        expect.objectContaining({ fromAddress: WHALE, flowType: 'selling', amount: 200 })
      ]);

      expect((await get('/api/tx/nope')).status).toBe(400);
      expect((await get(`/api/tx/${'cd'.repeat(32)}`)).status).toBe(404);
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
        foundation: { count: 38 }
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
