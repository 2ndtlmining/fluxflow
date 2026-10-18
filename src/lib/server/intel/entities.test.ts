import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { createApiRouter, errorHandler } from '../api/router.js';
import { dataVersion } from '../api/queries.js';
import { blockTime, writeChain, writeLabelsFile, type SimpleTx } from './testchain.js';
import { foundationReport } from './foundation.js';
import {
  EntityIndex,
  addMembers,
  createEntity,
  entityReport,
  listClusters,
  withEntityNames
} from './entities.js';

const TOKEN = 'a'.repeat(40);
// Real-format addresses: the API validates them.
const KUCOIN_HOT = 't1g7QCktktwReoHgwWtAgNBVvzzboQVZy19';
const KUCOIN_2 = 't1X1hKAb9rYmsikPKVJXBHueJU4VeuV7Tbb';
const TREASURY = 't1hPu1YDeGUCp8m7BQCnnNUmRMJBa5RadyB';
const PAYROLL = 't1XF3LA8ak3LT34AweXPpzwaShTZAsxiUeC';
const MINER_A = 't1LGZFS1jQwUpGbDYLAGMh9tBh6E1qTAYqp';
const MINER_B = 't1Dep2aaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MINER_C = 't1Dep3aaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const STRANGER = 't1Strangeraaaaaaaaaaaaaaaaaaaaaaaaa';

const LABELS = {
  exchanges: [{ name: 'Kucoin', addresses: [KUCOIN_HOT, KUCOIN_2] }],
  foundation: {
    name: 'Flux Foundation',
    addresses: [],
    wallets: [
      { name: 'Treasury', addresses: [TREASURY] },
      { name: 'Payroll', addresses: [PAYROLL] }
    ]
  }
};

/**
 * The Foundation moves money between its own wallets and pays out; three miners (one
 * co-spend cluster) withdraw from two Kucoin addresses and pay a stranger.
 */
const CHAIN: SimpleTx[] = [
  { height: 10, txid: 'in', inputs: [[STRANGER, 5_000]], outputs: [[TREASURY, 4_999]] },
  { height: 11, txid: 'move', inputs: [[TREASURY, 2_000]], outputs: [[PAYROLL, 1_999.99]] },
  { height: 12, txid: 'wage', inputs: [[PAYROLL, 1_000]], outputs: [[MINER_A, 999.99]] },
  { height: 13, txid: 'w1', inputs: [[KUCOIN_HOT, 300]], outputs: [[MINER_B, 300]] },
  { height: 14, txid: 'w2', inputs: [[KUCOIN_2, 200]], outputs: [[MINER_C, 200]] },
  {
    height: 15,
    txid: 'cospend',
    inputs: [
      [MINER_A, 500],
      [MINER_B, 300],
      [MINER_C, 200]
    ],
    outputs: [[STRANGER, 999.9]]
  }
];

const WINDOW = {
  fromTime: blockTime(0),
  toTime: blockTime(100),
  fromHeight: 0,
  toHeight: 100
};

/** The clustering pass's output for the co-spend above. */
function writeCluster(db: Db): void {
  const insert = db.prepare(
    `INSERT INTO address_clusters (address, cluster_id, size) VALUES (?, ?, 3)`
  );
  for (const address of [MINER_A, MINER_B, MINER_C]) insert.run(address, MINER_A);
}

describe('entities', () => {
  let db: Db;
  let labels: LabelLookup;

  beforeEach(() => {
    db = createTestDb();
    labels = loadLabels(
      db,
      createTestConfig({ LABELS_PATH: writeLabelsFile(LABELS) }),
      silentLogger()
    );
    writeChain(db, labels, CHAIN);
    writeCluster(db);
  });

  afterEach(() => db.close());

  it('derives one entity per labelled name, and one Foundation', () => {
    const index = EntityIndex.build(db, labels);

    expect(index.get('exchange:Kucoin')).toMatchObject({
      name: 'Kucoin',
      kind: 'exchange',
      source: 'label',
      members: 2
    });
    expect(index.get('foundation')).toMatchObject({ name: 'Flux Foundation', members: 2 });
    expect(index.entityOf(PAYROLL)?.id).toBe('foundation');
    expect(index.entityOf(STRANGER)).toBeNull();
  });

  it("gives the Foundation entity the Foundation report's totals", () => {
    const index = EntityIndex.build(db, labels);
    const entity = entityReport(db, labels, index, 'foundation', WINDOW)!;
    const foundation = foundationReport(db, labels, WINDOW);

    expect(entity.totals).toEqual(foundation.totals);
    // The move between its own wallets is internal, not an outflow and an inflow.
    expect(entity.totals).toMatchObject({ inflow: 4_999, internalTransfers: 1 });
  });

  it('names a cluster: every member, including ones clustering finds later', () => {
    const id = createEntity(db, { name: 'Miner group', kind: 'unknown' });
    addMembers(db, id, [{ address: MINER_B, source: 'cluster' }]);

    let index = EntityIndex.build(db, labels);
    expect(id).toBe('e-miner-group');
    expect(
      index
        .members(id)
        .map((m) => m.address)
        .sort()
    ).toEqual([MINER_A, MINER_B, MINER_C].sort());

    // The next clustering pass finds a fourth address (and a new cluster id).
    db.prepare(`DELETE FROM address_clusters`).run();
    for (const address of [MINER_A, MINER_B, MINER_C, STRANGER]) {
      db.prepare(`INSERT INTO address_clusters VALUES (?, ?, 4)`).run(address, MINER_C);
    }
    index = EntityIndex.build(db, labels);
    expect(index.get(id)!.members).toBe(4);
  });

  it('combines flows and groups counterparties by entity', () => {
    const id = createEntity(db, { name: 'Miner group', kind: 'unknown' });
    addMembers(db, id, [{ address: MINER_A, source: 'cluster' }]);
    const index = EntityIndex.build(db, labels);
    const report = entityReport(db, withEntityNames(labels, index), index, id, WINDOW)!;

    // Both Kucoin addresses are one counterparty; the Foundation is one too.
    expect(report.incoming.parties).toEqual([
      expect.objectContaining({
        entity: { id: 'foundation', members: 2 },
        name: 'Flux Foundation',
        total: 999.99
      }),
      expect.objectContaining({
        entity: { id: 'exchange:Kucoin', members: 2 },
        name: 'Kucoin',
        kind: 'exchange',
        total: 500,
        count: 2
      })
    ]);
    expect(report.outgoing.parties).toEqual([
      expect.objectContaining({ entity: null, address: STRANGER, total: 999.9 })
    ]);
    expect(report.totals).toMatchObject({ inflow: 1_499.99, outflow: 1_000 });
    expect(report.memberSources).toEqual({ label: 0, manual: 0, cluster: 3 });
  });

  it('calls an unlabelled member by its entity name, but never renames a labelled one', () => {
    const id = createEntity(db, { name: 'Miner group', kind: 'unknown' });
    addMembers(db, id, [
      { address: MINER_A, source: 'manual' },
      { address: KUCOIN_2, source: 'manual' }
    ]);
    const named = withEntityNames(labels, EntityIndex.build(db, labels));

    expect(named.nameOf(MINER_A)).toBe('Miner group');
    expect(named.nameOf(KUCOIN_2)).toBe('Kucoin');
    expect(named.kindOf(MINER_A)).toBe('unknown');
  });

  it('bumps the data version on every change, so cached answers refresh', () => {
    const before = dataVersion(db);
    const id = createEntity(db, { name: 'X', kind: 'unknown' });
    addMembers(db, id, [{ address: MINER_A, source: 'manual' }]);
    db.prepare(`DELETE FROM entities WHERE id = ?`).run(id);

    // Create, add, delete, and the member row the delete cascades to.
    expect(dataVersion(db)).toBe(before + 4);
    // Members go with the entity.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM entity_members`).get()).toEqual({ n: 0 });
  });

  it('lists clusters with what is already known about them', () => {
    expect(listClusters(db, EntityIndex.build(db, labels))).toEqual([
      expect.objectContaining({ anchor: MINER_B, size: 3, unassigned: 3, entities: [] })
    ]);

    const id = createEntity(db, { name: 'Miner group', kind: 'unknown' });
    addMembers(db, id, [{ address: MINER_A, source: 'cluster' }]);
    const index = EntityIndex.build(db, labels);
    expect(listClusters(db, index)[0]).toMatchObject({
      unassigned: 0,
      entities: [{ id, name: 'Miner group', members: 3 }]
    });
    expect(listClusters(db, index, { unnamedOnly: true })).toEqual([]);
  });
});

describe('entities API', () => {
  let db: Db;
  let server: TestServer;

  beforeEach(async () => {
    db = createTestDb();
    const config = createTestConfig({
      ADMIN_TOKEN: TOKEN,
      LABELS_PATH: writeLabelsFile(LABELS)
    });
    const labels = loadLabels(db, config, silentLogger());
    writeChain(db, labels, CHAIN);
    writeCluster(db);

    const app = express();
    app.use('/api', express.json());
    app.use(
      '/api',
      createApiRouter({
        config,
        db,
        labels,
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
    await server.close();
    db.close();
  });

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    token: string | null = TOKEN
  ) => {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  it('names a cluster, then serves it as an entity everywhere', async () => {
    expect(
      (await call('POST', '/api/admin/entities', { name: 'X', clusterOf: [MINER_A] }, null)).status
    ).toBe(401);
    expect((await call('POST', '/api/admin/entities', { name: 'X' })).status).toBe(400);

    const created = await call('POST', '/api/admin/entities', {
      name: 'Miner group',
      clusterOf: [MINER_A]
    });
    expect(created.body).toEqual({ success: true, id: 'e-miner-group' });

    const list = await call('GET', '/api/entities?q=miner');
    expect(list.body).toMatchObject({ total: 1, entities: [{ id: 'e-miner-group', members: 3 }] });

    const entity = await call('GET', '/api/entities/e-miner-group?period=6M');
    expect(entity.status).toBe(200);
    expect(entity.body).toMatchObject({ entity: { name: 'Miner group' }, period: '6M' });

    const wallet = await call('GET', `/api/wallets/${MINER_B}`);
    expect(wallet.body.entity).toMatchObject({ id: 'e-miner-group', name: 'Miner group' });

    // Counterparty tables elsewhere use the entity name for its unlabelled members.
    const parties = await call('GET', `/api/wallets/${STRANGER}/counterparties`);
    expect(JSON.stringify(parties.body)).toContain('Miner group');

    expect((await call('GET', '/api/entities/nope')).status).toBe(404);
    expect((await call('GET', '/api/entities/foundation?period=7D')).status).toBe(200);
  });

  it('renames, edits members and deletes only named entities', async () => {
    await call('POST', '/api/admin/entities', { name: 'Miner group', addresses: [MINER_A] });

    expect(
      (await call('PATCH', '/api/admin/entities/e-miner-group', { name: 'Pool' })).status
    ).toBe(200);
    expect(
      (await call('POST', '/api/admin/entities/e-miner-group/members', { addresses: [MINER_B] }))
        .body
    ).toMatchObject({ added: 1 });
    expect(
      (await call('DELETE', `/api/admin/entities/e-miner-group/members/${MINER_A}`)).body
    ).toMatchObject({ removed: 1 });

    const entity = await call('GET', '/api/entities/e-miner-group');
    expect(entity.body).toMatchObject({ entity: { name: 'Pool', members: 1 } });

    expect((await call('PATCH', '/api/admin/entities/foundation', { name: 'X' })).status).toBe(404);
    expect((await call('DELETE', '/api/admin/entities/e-miner-group')).status).toBe(200);
    expect((await call('GET', '/api/entities/e-miner-group')).status).toBe(404);
  });

  it('lists clusters, optionally only the unnamed ones', async () => {
    const all = await call('GET', '/api/clusters');
    expect(all.body.clusters).toEqual([expect.objectContaining({ size: 3, unassigned: 3 })]);

    await call('POST', '/api/admin/entities', { name: 'Miner group', clusterOf: [MINER_A] });
    expect((await call('GET', '/api/clusters?unnamed=1')).body.clusters).toEqual([]);
  });
});
