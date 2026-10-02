/**
 * Versioned schema migrations.
 *
 * The current schema version is stored in SQLite's `user_version` pragma, so migrations
 * are a plain ordered list and the applied version is self-describing. There are no
 * down-migrations: a bad release is rolled back by redeploying the previous image against
 * a database restored from backup.
 */

import type { Db } from './database.js';

export interface Migration {
  /** Must be strictly greater than every previously applied version. */
  readonly version: number;
  readonly name: string;
  readonly up: (db: Db) => void;
}

const now = "CAST(strftime('%s','now') AS INTEGER)";

/**
 * Migration 1 — the v2 data model.
 *
 * The guiding idea (ADR 0001): chain facts are immutable and stored once; everything the
 * dashboard shows is derived from them and can be rebuilt. That is what fixes #16
 * (`INSERT OR REPLACE` wiping enhancement results and renumbering row ids) and #18
 * (classification frozen at sync time) by construction rather than by patching.
 */
const initialSchema: Migration = {
  version: 1,
  name: 'initial_v2_schema',
  up: (db) => {
    // ── Chain facts ──────────────────────────────────────────────────────────
    // `prev_hash` and `source` are what make reorg detection (#13) and per-source
    // traceability possible; v1 stored neither.
    db.exec(`
      CREATE TABLE blocks (
        height      INTEGER PRIMARY KEY,
        hash        TEXT    NOT NULL,
        prev_hash   TEXT,
        time        INTEGER NOT NULL,
        tx_count    INTEGER NOT NULL DEFAULT 0,
        source      TEXT    NOT NULL DEFAULT 'unknown',
        ingested_at INTEGER NOT NULL DEFAULT (${now})
      );
    `);
    db.exec(`CREATE INDEX idx_blocks_time ON blocks(time);`);

    /*
     * Per transfer, per address value deltas, in satoshis.
     *
     * This is the unit of analysis that replaces v1's `flow_events`: it records what each
     * address sent and received in each transfer transaction, with inputs from the same
     * address collapsed. Flows, wallet profiles, exchange clustering and multi-hop tracing
     * are all derived from it, which means none of them needs an external API call (#7).
     *
     * Values are integers. v1 stored `amount` as a REAL derived from `value / 1e8`, which
     * is where the unit ambiguity in #15 came from.
     */
    db.exec(`
      CREATE TABLE tx_deltas (
        txid    TEXT    NOT NULL,
        address TEXT    NOT NULL,
        height  INTEGER NOT NULL,
        time    INTEGER NOT NULL,
        sat_in  INTEGER NOT NULL DEFAULT 0,
        sat_out INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (txid, address)
      ) WITHOUT ROWID;
    `);
    db.exec(`CREATE INDEX idx_tx_deltas_height ON tx_deltas(height);`);
    db.exec(`CREATE INDEX idx_tx_deltas_address ON tx_deltas(address, height);`);

    /*
     * Coinbase-derived node rewards, aggregated per address per day.
     *
     * A reward proves the address was mining at that moment, which gives time-accurate
     * "was a node operator" answers without replaying history through an indexer (#18).
     */
    db.exec(`
      CREATE TABLE node_rewards (
        address      TEXT    NOT NULL,
        day          INTEGER NOT NULL,
        reward_count INTEGER NOT NULL DEFAULT 0,
        sat          INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (address, day)
      ) WITHOUT ROWID;
    `);
    db.exec(`CREATE INDEX idx_node_rewards_day ON node_rewards(day);`);

    // ── Mutable labels, deliberately separate from the facts above ────────────
    db.exec(`
      CREATE TABLE address_labels (
        address    TEXT    NOT NULL,
        kind       TEXT    NOT NULL,
        name       TEXT,
        sub_label  TEXT,
        source     TEXT    NOT NULL DEFAULT 'config',
        confidence REAL    NOT NULL DEFAULT 1.0,
        valid_from INTEGER,
        valid_to   INTEGER,
        evidence   TEXT,
        updated_at INTEGER NOT NULL DEFAULT (${now}),
        PRIMARY KEY (address, kind, source),
        CHECK (confidence >= 0 AND confidence <= 1)
      ) WITHOUT ROWID;
    `);
    db.exec(`CREATE INDEX idx_labels_kind ON address_labels(kind, confidence DESC);`);

    // ── Derived read models ──────────────────────────────────────────────────
    /*
     * One row per transaction output that moved value between two parties.
     *
     * `exchange` is denormalised onto the row: grouping dashboard queries by it without
     * a `json_extract` on every row is most of the difference between a 1.3 s query and a
     * 50 ms one (#2).
     */
    db.exec(`
      CREATE TABLE flows (
        txid         TEXT    NOT NULL,
        vout         INTEGER NOT NULL,
        height       INTEGER NOT NULL,
        time         INTEGER NOT NULL,
        from_address TEXT    NOT NULL,
        from_kind    TEXT    NOT NULL,
        to_address   TEXT    NOT NULL,
        to_kind      TEXT    NOT NULL,
        exchange     TEXT,
        flow_type    TEXT    NOT NULL,
        sat          INTEGER NOT NULL,
        confidence   REAL    NOT NULL DEFAULT 1.0,
        PRIMARY KEY (txid, vout),
        CHECK (flow_type IN ('buying', 'selling', 'p2p'))
      ) WITHOUT ROWID;
    `);
    // These three indexes mirror the three dashboard queries, so none of them needs a
    // sort over the whole table.
    db.exec(`CREATE INDEX idx_flows_period ON flows(flow_type, height);`);
    db.exec(`CREATE INDEX idx_flows_to ON flows(to_address, height);`);
    db.exec(`CREATE INDEX idx_flows_from ON flows(from_address, height);`);

    // ── Bookkeeping ──────────────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE sync_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (${now})
      ) WITHOUT ROWID;
    `);

    /*
     * Heights that could not be fetched. v1 dropped these silently and never retried,
     * so any block that failed once was missing forever (#13). `next_retry_at` carries
     * the backoff.
     */
    db.exec(`
      CREATE TABLE missing_blocks (
        height        INTEGER PRIMARY KEY,
        attempts      INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT,
        next_retry_at INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL DEFAULT (${now})
      );
    `);
    db.exec(`CREATE INDEX idx_missing_retry ON missing_blocks(next_retry_at);`);

    /* Per-node health for the FluxNode pool, backing the circuit breaker (#12). */
    db.exec(`
      CREATE TABLE node_health (
        url          TEXT PRIMARY KEY,
        ok_count     INTEGER NOT NULL DEFAULT 0,
        fail_count   INTEGER NOT NULL DEFAULT 0,
        banned_until INTEGER,
        last_ok_at   INTEGER,
        last_error   TEXT
      ) WITHOUT ROWID;
    `);
  }
};

/** Every migration, in ascending version order. Append only — never edit a shipped one. */
export const MIGRATIONS: readonly Migration[] = [initialSchema];

/** The version a fresh database ends up at. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0
);

export function getSchemaVersion(db: Db): number {
  const row = db.pragma('user_version', { simple: true });
  return typeof row === 'number' ? row : 0;
}

export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly string[];
}

/**
 * Bring the database up to {@link LATEST_SCHEMA_VERSION}.
 *
 * Each migration runs inside its own transaction together with the `user_version`
 * bump, so an interrupted upgrade leaves the previous version fully intact rather than a
 * half-applied schema.
 */
export function migrate(db: Db, log?: { info: (o: object, m: string) => void }): MigrationResult {
  const from = getSchemaVersion(db);

  const pending = MIGRATIONS.filter((migration) => migration.version > from).sort(
    (a, b) => a.version - b.version
  );

  if (pending.length === 0) {
    return { from, to: from, applied: [] };
  }

  const applied: string[] = [];

  for (const migration of pending) {
    log?.info({ version: migration.version, name: migration.name }, 'applying migration');

    const run = db.transaction(() => {
      migration.up(db);
      // `user_version` does not accept a bound parameter.
      db.pragma(`user_version = ${migration.version}`);
    });

    run();
    applied.push(`${migration.version}_${migration.name}`);
  }

  return { from, to: getSchemaVersion(db), applied };
}

/**
 * Detect a database written by the legacy v1 service.
 *
 * v1 created its tables with `CREATE TABLE IF NOT EXISTS` and never set `user_version`,
 * so a v1 database looks like "version 0 with tables already present". Applying the v2
 * schema on top would silently produce a half-and-half database, so we refuse instead.
 *
 * @returns a human-readable reason, or `null` when the database is safe to migrate.
 */
export function detectLegacyDatabase(db: Db): string | null {
  if (getSchemaVersion(db) !== 0) return null;

  const tables = db
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('flow_events', 'blocks')`
    )
    .all()
    .map((row) => row.name);

  if (tables.length === 0) return null;

  return [
    `found a legacy v1 database (tables: ${tables.join(', ')}, no schema version).`,
    'The v2 schema is not compatible with v1 tables.',
    'Point DATABASE_PATH at a fresh file, or move the old file aside to keep it as a backup.'
  ].join(' ');
}
