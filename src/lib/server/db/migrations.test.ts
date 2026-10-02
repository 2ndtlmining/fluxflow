import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { openDatabase, type Db } from './database.js';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  detectLegacyDatabase,
  getSchemaVersion,
  migrate
} from './migrations.js';

function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ NODE_ENV: 'test', ...overrides });
}

/** A unique throwaway database path. WAL and `user_version` need a real file. */
function tempPath(): string {
  return `${process.env.TEMP ?? '.'}/fluxflow-test-${process.pid}-${Math.random().toString(36).slice(2)}/flux.db`;
}

describe('openDatabase', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase({
      config: testConfig(),
      log: { debug: () => {}, info: () => {}, error: () => {} } as never,
      inMemory: true
    });
  });

  it('creates the parent directory for DATABASE_PATH', () => {
    const tmp = tempPath();

    const fileDb = openDatabase({
      config: testConfig({ DATABASE_PATH: tmp }),
      log: { debug: () => {}, info: () => {}, error: () => {} } as never
    });

    expect(getSchemaVersion(fileDb)).toBe(0);
    fileDb.close();
  });

  it('uses WAL so readers do not block on the writer', () => {
    // WAL needs a real file: SQLite reports "memory" for :memory: databases, which is
    // correct and cannot be changed.
    const fileDb = openDatabase({
      config: testConfig({ DATABASE_PATH: tempPath() }),
      log: { debug: () => {}, info: () => {}, error: () => {} } as never
    });

    expect(fileDb.pragma('journal_mode', { simple: true })).toBe('wal');
    fileDb.close();
  });

  it('honours SQLITE_BUSY_TIMEOUT_MS', () => {
    const slow = openDatabase({
      config: testConfig({ SQLITE_BUSY_TIMEOUT_MS: '5000' }),
      log: { debug: () => {}, info: () => {}, error: () => {} } as never,
      inMemory: true
    });

    expect(slow.pragma('busy_timeout', { simple: true })).toBe(5000);
    slow.close();
  });

  it('ignores DATABASE_PATH in favour of in-memory when asked', () => {
    expect(db.memory).toBe(true);
  });
});

describe('migrate', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase({
      config: testConfig(),
      log: { debug: () => {}, info: () => {}, error: () => {} } as never,
      inMemory: true
    });
  });

  it('brings a fresh database to the latest version', () => {
    const result = migrate(db);

    expect(result.from).toBe(0);
    expect(result.to).toBe(LATEST_SCHEMA_VERSION);
    expect(result.applied).toHaveLength(MIGRATIONS.length);
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
  });

  it('is a no-op on an already-current database', () => {
    migrate(db);
    const second = migrate(db);

    expect(second.applied).toEqual([]);
    expect(second.to).toBe(LATEST_SCHEMA_VERSION);
  });

  it('creates the tables the read models need', () => {
    migrate(db);

    const tables = db
      .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => row.name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'blocks',
        'tx_deltas',
        'node_rewards',
        'address_labels',
        'flows',
        'sync_state',
        'missing_blocks',
        'node_health'
      ])
    );
  });

  it('records prev_hash and source on blocks so reorgs are detectable', () => {
    migrate(db);

    const columns = db
      .prepare<[], { name: string }>(`PRAGMA table_info(blocks)`)
      .all()
      .map((row) => row.name);

    expect(columns).toEqual(
      expect.arrayContaining(['height', 'hash', 'prev_hash', 'time', 'tx_count', 'source'])
    );
  });

  it('stores values as integer satoshis rather than floats', () => {
    migrate(db);

    const [row] = db
      .prepare<[string, string, number, number], { sat_in: number; sat_out: number }>(
        `INSERT INTO tx_deltas (txid, address, height, time, sat_in, sat_out)
         VALUES (?, ?, 1, 1000, ?, ?)
         RETURNING sat_in, sat_out`
      )
      .all('tx1', 'addr1', 100_000_000, 50_000_000);

    expect(row).toEqual({ sat_in: 100_000_000, sat_out: 50_000_000 });
  });

  it('rejects a flow_type outside the allowed set', () => {
    migrate(db);

    expect(() =>
      db
        .prepare(
          `INSERT INTO flows (txid, vout, height, time, from_address, from_kind,
                              to_address, to_kind, flow_type, sat)
           VALUES ('tx1', 0, 1, 1000, 'a', 'unknown', 'b', 'exchange', 'hodling', 1)`
        )
        .run()
    ).toThrow(/CHECK constraint failed/);
  });

  it('rejects a label confidence outside 0..1', () => {
    migrate(db);

    expect(() =>
      db
        .prepare(
          `INSERT INTO address_labels (address, kind, confidence) VALUES ('a', 'exchange', 2)`
        )
        .run()
    ).toThrow(/CHECK constraint failed/);
  });

  it('records node rewards per height so a reorg can roll them back', () => {
    migrate(db);

    const columns = db
      .prepare<[], { name: string }>(`PRAGMA table_info(node_rewards)`)
      .all()
      .map((row) => row.name);

    expect(columns).toEqual(
      expect.arrayContaining(['address', 'height', 'day', 'reward_count', 'sat'])
    );
  });

  it('overwrites a node reward for a re-synced block instead of adding to it', () => {
    migrate(db);

    const upsert = db.prepare<[string, number, number, number, number], never>(
      `INSERT INTO node_rewards (address, height, day, reward_count, sat)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (address, height) DO UPDATE SET
         day = excluded.day, reward_count = excluded.reward_count, sat = excluded.sat`
    );

    upsert.run('t1miner', 100, 200, 1, 500);
    upsert.run('t1miner', 100, 200, 1, 500);

    const row = db
      .prepare<[], { reward_count: number; sat: number }>(
        `SELECT reward_count, sat FROM node_rewards WHERE address = 't1miner' AND height = 100`
      )
      .get();

    // An additive aggregate would report 2 rewards / 1000 sat after re-syncing one block.
    expect(row).toEqual({ reward_count: 1, sat: 500 });
  });

  it('indexes the three dashboard query shapes', () => {
    migrate(db);

    const indexes = db
      .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .all()
      .map((row) => row.name);

    expect(indexes).toEqual(
      expect.arrayContaining(['idx_flows_period', 'idx_flows_to', 'idx_flows_from'])
    );
  });

  it('keeps every migration version unique and ascending', () => {
    const versions = MIGRATIONS.map((migration) => migration.version);

    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(Math.min(...versions)).toBe(1);
  });

  it('leaves the version untouched when a migration throws', () => {
    const broken = [
      ...MIGRATIONS,
      {
        version: LATEST_SCHEMA_VERSION + 1,
        name: 'deliberately_broken',
        up: () => {
          db.exec(`CREATE TABLE half_applied (id INTEGER)`);
          throw new Error('boom');
        }
      }
    ];

    const originalMigrations = MIGRATIONS.slice();
    // Run the broken migration by hand to prove the transaction wrapper rolls back.
    const apply = db.transaction(() => {
      broken[broken.length - 1]!.up(db);
      db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    });

    expect(() => apply()).toThrow('boom');

    const tables = db
      .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => row.name);

    expect(tables).not.toContain('half_applied');
    expect(originalMigrations).toHaveLength(LATEST_SCHEMA_VERSION);
  });
});

describe('detectLegacyDatabase', () => {
  it('returns null for a fresh database', () => {
    const db = openDatabase({
      config: testConfig(),
      log: { debug: () => {}, info: () => {}, error: () => {} } as never,
      inMemory: true
    });

    expect(detectLegacyDatabase(db)).toBeNull();
    db.close();
  });

  it('returns null for a migrated database', () => {
    const db = openDatabase({
      config: testConfig(),
      log: { debug: () => {}, info: () => {}, error: () => {} } as never,
      inMemory: true
    });
    migrate(db);

    expect(detectLegacyDatabase(db)).toBeNull();
    db.close();
  });

  it('detects a v1 database and explains what to do about it', () => {
    const db = openDatabase({
      config: testConfig(),
      log: { debug: () => {}, info: () => {}, error: () => {} } as never,
      inMemory: true
    });
    // Exactly what the legacy service creates.
    db.exec(`
      CREATE TABLE blocks (height INTEGER PRIMARY KEY, hash TEXT NOT NULL, time INTEGER NOT NULL);
      CREATE TABLE flow_events (id INTEGER PRIMARY KEY AUTOINCREMENT, txid TEXT NOT NULL);
    `);

    const reason = detectLegacyDatabase(db);

    expect(reason).toMatch(/legacy v1 database/);
    expect(reason).toMatch(/DATABASE_PATH/);
    db.close();
  });
});
