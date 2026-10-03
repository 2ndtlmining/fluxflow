import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createService, type Service } from './index.js';
import { fakeDataSource } from './testkit.js';

const services: Service[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.close().catch(() => {});
  }
});

function boot(
  env: Record<string, string> = {},
  options: { autoStartSync?: boolean } = {}
): Service {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-service-'));
  const labelsPath = path.join(dataDir, 'labels.json');
  fs.writeFileSync(
    labelsPath,
    JSON.stringify({ exchanges: [{ name: 'Coinex', addresses: ['t1coinex'] }] })
  );

  const service = createService({
    env: {
      NODE_ENV: 'test',
      DATABASE_PATH: path.join(dataDir, 'flux.db'),
      LABELS_PATH: labelsPath,
      LOG_LEVEL: 'silent',
      // No network at boot: the fake source is injected below.
      SYNC_ENABLED: '0',
      ...env
    },
    sources: [fakeDataSource()],
    ...options
  });

  services.push(service);
  return service;
}

describe('createService', () => {
  it('applies the schema on a fresh database file', () => {
    const service = boot();

    const tables = service.db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
      )
      .all()
      .map((row) => row.name);

    expect(tables).toEqual(
      expect.arrayContaining(['blocks', 'flows', 'tx_deltas', 'address_labels', 'sync_state'])
    );
  });

  it('honours DATABASE_PATH exactly, rather than cwd-relative', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-path-'));
    const dbPath = path.join(dataDir, 'custom-name.db');

    const service = boot({ DATABASE_PATH: dbPath });

    expect(fs.existsSync(dbPath)).toBe(true);
    expect(service.db.name).toBe(dbPath);
  });

  it('loads labels from LABELS_PATH', () => {
    const service = boot();

    expect(service.labels.kindOf('t1coinex')).toBe('exchange');
  });

  it('fails loudly on a legacy v1 database instead of half-migrating it', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-legacy-'));
    const dbPath = path.join(dataDir, 'legacy.db');

    // Exactly what v1 created: its tables, and no schema version.
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE flow_events (id INTEGER PRIMARY KEY, txid TEXT NOT NULL)`);
    legacy.close();

    expect(() =>
      createService({
        env: { NODE_ENV: 'test', DATABASE_PATH: dbPath, LOG_LEVEL: 'silent' },
        sources: [fakeDataSource()]
      })
    ).toThrow(/legacy v1 database/);
  });

  it('fails loudly when production has no admin token', () => {
    expect(() => boot({ NODE_ENV: 'production' })).toThrow(/ADMIN_TOKEN/);
  });

  it('serves /api/health on the configured port and nothing else', async () => {
    const port = 34_000 + Math.floor(Math.random() * 1_000);
    const service = boot({ PORT: String(port) });

    await service.listen();

    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok' });

    // A route the API does not own must not answer: in production the SvelteKit handler
    // is mounted after it, and in tests there is no handler, so 404 is correct.
    expect((await fetch(`http://127.0.0.1:${port}/api/nope`)).status).toBe(404);
  });

  it('sends no CORS headers when ORIGIN is unset', async () => {
    const port = 35_000 + Math.floor(Math.random() * 1_000);
    const service = boot({ PORT: String(port) });
    await service.listen();

    const response = await fetch(`http://127.0.0.1:${port}/api/health`);

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows a cross-origin client only when ORIGIN is set', async () => {
    const port = 36_000 + Math.floor(Math.random() * 1_000);
    const service = boot({ PORT: String(port), ORIGIN: 'https://flux.example' });
    await service.listen();

    const response = await fetch(`http://127.0.0.1:${port}/api/health`);

    expect(response.headers.get('access-control-allow-origin')).toBe('https://flux.example');
  });

  it('does not advertise the framework', async () => {
    const port = 37_000 + Math.floor(Math.random() * 1_000);
    const service = boot({ PORT: String(port) });
    await service.listen();

    const response = await fetch(`http://127.0.0.1:${port}/api/health`);

    expect(response.headers.get('x-powered-by')).toBeNull();
  });

  describe('markSyncSuccess', () => {
    it('flips health from degraded to ok once a cycle succeeds', async () => {
      const port = 38_000 + Math.floor(Math.random() * 1_000);
      // Sync enabled but not auto-started: the loop is driven explicitly below so the
      // test never races a real poll against shutdown.
      const service = boot({ PORT: String(port), SYNC_ENABLED: '1' }, { autoStartSync: false });
      await service.listen();

      const before = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(before.status).toBe(503);

      service.markSyncSuccess();

      const after = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(after.status).toBe(200);
    });

    it('is reported by the sync loop itself, not only by an explicit call', async () => {
      const port = 38_000 + Math.floor(Math.random() * 1_000);
      const service = boot(
        { PORT: String(port), SYNC_ENABLED: '1', SYNC_BATCH_SIZE: '10' },
        { autoStartSync: false }
      );
      await service.listen();

      // Nothing in production calls markSyncSuccess, so without the loop reporting in,
      // /api/health answered 503 forever while blocks were landing.
      await service.sync!.runOnce();

      expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
    });

    it('exposes the ingestion service when sync is enabled', () => {
      expect(boot({ SYNC_ENABLED: '1' }, { autoStartSync: false }).sync).not.toBeNull();
      expect(boot({ SYNC_ENABLED: '0' }).sync).toBeNull();
    });

    it('never reports degraded when syncing is switched off entirely', async () => {
      const port = 39_000 + Math.floor(Math.random() * 1_000);
      const service = boot({ PORT: String(port), SYNC_ENABLED: '0' });
      await service.listen();

      expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
    });
  });

  describe('close', () => {
    it('closes the database handle', async () => {
      const service = boot();

      await service.listen();
      await service.close();

      expect(service.db.open).toBe(false);
    });

    it('is idempotent, so a second signal is harmless', async () => {
      const service = boot();
      await service.listen();

      await service.close();
      await expect(service.close()).resolves.toBeUndefined();
    });

    it('stops accepting new connections once closed', async () => {
      const port = 40_000 + Math.floor(Math.random() * 1_000);
      const service = boot({ PORT: String(port) });
      await service.listen();

      await expect(fetch(`http://127.0.0.1:${port}/api/health`)).resolves.toBeDefined();
      await service.close();
      await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
    });
  });
});
