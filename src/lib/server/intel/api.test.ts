import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FailoverDataSource } from '../ingest/datasource/circuitbreaker.js';
import { loadLabels, type LabelLookup } from '../labels.js';
import {
  createTestConfig,
  createTestDb,
  fakeDataSource,
  silentLogger,
  startTestServer,
  type Db,
  type TestServer
} from '../testkit.js';
import type { Config } from '../config.js';
import { createApiRouter, errorHandler } from '../api/router.js';
import { IntelService } from './service.js';
import { rollupMismatches, writeChain, writeLabelsFile, type SimpleTx } from './testchain.js';

const TOKEN = 'a'.repeat(40);
// Real-format addresses: the API validates them.
const KUCOIN = 't1g7QCktktwReoHgwWtAgNBVvzzboQVZy19';
const OPERATOR = 't1X1hKAb9rYmsikPKVJXBHueJU4VeuV7Tbb';
const RETIRED = 't1XF3LA8ak3LT34AweXPpzwaShTZAsxiUeC';
const DEPOSIT = 't1LGZFS1jQwUpGbDYLAGMh9tBh6E1qTAYqp';
const FOUNDATION = 't1hPu1YDeGUCp8m7BQCnnNUmRMJBa5RadyB';

const NODE_LIST = {
  status: 'success',
  data: [
    { payment_address: OPERATOR, tier: 'STRATUS' },
    { payment_address: OPERATOR, tier: 'CUMULUS' }
  ]
};

const CHAIN: SimpleTx[] = [
  {
    height: 1,
    txid: 'cb1',
    kind: 'coinbase',
    outputs: [
      [OPERATOR, 1],
      [RETIRED, 1]
    ]
  },
  // The operator sells to Kucoin; the retired operator too; two deposit addresses are swept
  // (the sale is attributed to the smaller funder, DEPOSIT).
  { height: 10, txid: 's1', inputs: [[OPERATOR, 500]], outputs: [[KUCOIN, 499.9]] },
  { height: 11, txid: 's2', inputs: [[RETIRED, 200]], outputs: [[KUCOIN, 199.9]] },
  {
    height: 12,
    txid: 'sweep',
    inputs: [
      [DEPOSIT, 40],
      ['t1Dep2aaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 60]
    ],
    outputs: [[KUCOIN, 99.9]]
  },
  { height: 13, txid: 'f1', inputs: [[FOUNDATION, 1_000]], outputs: [[KUCOIN, 999.9]] }
];

/** Response bodies, loosely: assertions below say which fields they expect. */
type Row = Record<string, unknown>;
type Body = Row & {
  sellers?: Row[];
  candidates?: Row[];
  byType?: { selling: Record<string, number> };
};

describe('intelligence API', () => {
  let db: Db;
  let config: Config;
  let labels: LabelLookup;
  let intel: IntelService;
  let server: TestServer;
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(NODE_LIST), { status: 200 }));

  beforeEach(async () => {
    db = createTestDb();
    config = createTestConfig({
      ADMIN_TOKEN: TOKEN,
      FLUX_NODES_API: 'http://explorer.test/api/status?q=getFluxNodes',
      LABELS_PATH: writeLabelsFile({
        exchanges: [{ name: 'Kucoin', addresses: [KUCOIN] }],
        foundation: {
          name: 'Flux Foundation',
          addresses: [],
          wallets: [{ name: 'Treasury', addresses: [FOUNDATION] }]
        }
      })
    });
    labels = loadLabels(db, config, silentLogger());
    writeChain(db, labels, CHAIN);

    intel = new IntelService({
      config,
      db,
      labels,
      log: silentLogger(),
      http: { fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0 }
    });

    const app = express();
    app.use('/api', express.json());
    app.use(
      '/api',
      createApiRouter({
        config,
        db,
        labels,
        intel,
        dataSource: new FailoverDataSource({
          sources: [fakeDataSource()],
          config,
          log: silentLogger()
        }),
        log: silentLogger(),
        health: {
          startedAt: Date.now(),
          lastSuccessfulSyncAt: Date.now(),
          degraded: () => ({ degraded: false, reason: null })
        }
      })
    );
    app.use('/api', errorHandler(config, silentLogger()));
    server = await startTestServer(app);
  });

  afterEach(async () => {
    intel.stop();
    await server.close();
    db.close();
  });

  const get = async (path: string) => {
    const response = await fetch(`${server.url}${path}`);
    return { status: response.status, body: (await response.json()) as Body };
  };
  const send = async (method: string, path: string, body?: unknown, token = TOKEN) => {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: (await response.json()) as Body };
  };

  it('runs the whole pass on demand, behind the admin token', async () => {
    expect((await send('POST', '/api/admin/intel/run', undefined, '')).status).toBe(401);

    const run = await send('POST', '/api/admin/intel/run');
    expect(run.status).toBe(200);
    expect(run.body.status).toMatchObject({
      relabelQueue: 0,
      nodeList: { addresses: 1, source: 'explorer' },
      nodeOperators: { list: 1, rewards: 1 }
    });
    expect(rollupMismatches(db)).toEqual([]);

    const status = await get('/api/intel/status');
    expect(status.body.labels).toMatchObject({ nodeOperators: 2, exchanges: 1, foundation: 1 });
  });

  it('shows node operators selling, with confidence, and filters by it', async () => {
    await intel.runAll();

    const summary = await get('/api/flow/30D');
    expect(summary.body.byType!.selling.node_operator).toBeCloseTo(699.8, 6);

    const all = await get('/api/flow/30D/sellers?kind=node_operator');
    expect(all.body.sellers!.map((s) => [s.address, s.level])).toEqual([
      [OPERATOR, 'confirmed'],
      [RETIRED, 'likely']
    ]);

    const confirmed = await get('/api/flow/30D/sellers?kind=node_operator&minConfidence=confirmed');
    expect(confirmed.body.sellers!.map((s) => s.address)).toEqual([OPERATOR]);

    expect((await get('/api/flow/30D/sellers?minConfidence=very')).status).toBe(400);
  });

  it('lists candidates and applies one only when accepted', async () => {
    await intel.runAll();

    const pending = await send('GET', '/api/admin/labels/candidates?status=pending');
    expect(pending.body.candidates!.map((c) => [c.address, c.method])).toContainEqual([
      DEPOSIT,
      'sweep'
    ]);

    // Not applied yet: the sweep is still a sale by the deposit address.
    let wallet = await get(`/api/wallets/${DEPOSIT}`);
    expect(wallet.body.kind).toBe('unknown');
    expect(wallet.body.candidates).toHaveLength(1);

    const decided = await send('POST', '/api/admin/labels/candidates/decide', {
      address: DEPOSIT,
      kind: 'exchange',
      name: 'Kucoin',
      decision: 'accepted'
    });
    expect(decided.status).toBe(200);
    await intel.relabel(Number.POSITIVE_INFINITY);

    wallet = await get(`/api/wallets/${DEPOSIT}`);
    expect(wallet.body.label).toMatchObject({ kind: 'exchange', source: 'accepted' });
    expect(rollupMismatches(db)).toEqual([]);

    expect(
      (
        await send('POST', '/api/admin/labels/candidates/decide', {
          address: 'nope',
          kind: 'exchange',
          decision: 'accepted'
        })
      ).status
    ).toBe(400);
  });

  it('lets a manual label override, and removes it again', async () => {
    const set = await send('POST', '/api/admin/labels', {
      address: KUCOIN,
      kind: 'unknown',
      note: 'not an exchange after all'
    });
    expect(set.body).toMatchObject({ success: true, changed: 1 });
    expect(labels.kindOf(KUCOIN)).toBe('unknown');

    const removed = await send('DELETE', `/api/admin/labels/${KUCOIN}`);
    expect(removed.body).toMatchObject({ removed: 1, changed: 1 });
    expect(labels.kindOf(KUCOIN)).toBe('exchange');
  });

  it('reports the Foundation and exchange hops', async () => {
    const foundation = await get('/api/foundation?period=30D');
    expect(foundation.status).toBe(200);
    expect(foundation.body.wallets).toEqual([
      expect.objectContaining({ address: FOUNDATION, subLabel: 'Treasury', outflow: 1_000 })
    ]);
    expect((await get('/api/foundation?period=2W')).status).toBe(400);

    const hops = await get('/api/flow/30D/hops');
    expect(hops.body).toMatchObject({ summary: { count: 0 }, hops: [] });

    const summary = await get('/api/flow/30D');
    expect(summary.body).toHaveProperty('adjusted.netFlow');
    expect(summary.body).toHaveProperty('exchangeHops.count', 0);
  });
});
