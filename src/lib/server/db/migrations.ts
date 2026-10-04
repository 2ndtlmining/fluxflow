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
     * Coinbase-derived node rewards, one row per address per block.
     *
     * A reward proves the address was mining at that moment, which gives time-accurate
     * "was a node operator" answers without replaying history through an indexer (#18).
     *
     * Keyed by height rather than by day so that (a) a reorg can roll it back, (b) retention
     * can prune it, and (c) re-syncing a block overwrites its row instead of adding to it.
     * An additive daily aggregate would be none of those three, and would double-count every
     * repair. `day` is carried alongside purely for querying.
     */
    db.exec(`
      CREATE TABLE node_rewards (
        address      TEXT    NOT NULL,
        height       INTEGER NOT NULL,
        day          INTEGER NOT NULL,
        reward_count INTEGER NOT NULL DEFAULT 0,
        sat          INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (address, height)
      ) WITHOUT ROWID;
    `);
    db.exec(`CREATE INDEX idx_node_rewards_day ON node_rewards(day);`);
    db.exec(`CREATE INDEX idx_node_rewards_height ON node_rewards(height);`);

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

/**
 * Rollup levels: hourly for the edges of a period, daily for everything between.
 *
 * Hourly alone was not enough: 6 months is ~4,300 hours × every (direction, counterparty,
 * exchange) combination, and grouping ~100k rows per direction took ~100 ms. Whole days
 * cut that to ~180 buckets.
 */
export const ROLLUP_LEVELS = {
  rollup_hourly: 3_600,
  rollup_daily: 86_400
} as const;

export type RollupTable = keyof typeof ROLLUP_LEVELS;

/**
 * The `sync_state` key that, while present, stops deletes from `flows` reaching the rollups.
 * Set inside the retention transaction only: pruning raw data must not erase history from
 * the totals, so rollups outlive the raw window (a 1Y total on 180 days of raw data).
 */
export const ROLLUP_RETAIN_KEY = 'rollup_retain';

/** Bumped by trigger on every block written or removed; the API's cache key (#4). */
export const DATA_VERSION_KEY = 'data_version';

/** The counterparty side of a flow: who bought from, or sold to, the exchange. */
const counterparty = (row: 'NEW' | 'OLD') =>
  `CASE ${row}.flow_type WHEN 'buying' THEN ${row}.to_kind ELSE ${row}.from_kind END`;

const addToRollups = (row: 'NEW' | 'OLD') =>
  Object.entries(ROLLUP_LEVELS)
    .map(
      ([table, seconds]) => `
  INSERT INTO ${table} (bucket, flow_type, counterparty_kind, exchange, sat, count)
  VALUES (${row}.time / ${seconds}, ${row}.flow_type, ${counterparty(row)},
          COALESCE(${row}.exchange, ''), ${row}.sat, 1)
  ON CONFLICT (flow_type, bucket, counterparty_kind, exchange)
  DO UPDATE SET sat = sat + excluded.sat, count = count + 1;`
    )
    .join('');

const subtractFromRollups = (row: 'NEW' | 'OLD') =>
  Object.entries(ROLLUP_LEVELS)
    .map(([table, seconds]) => {
      const key = `flow_type = ${row}.flow_type
      AND bucket = ${row}.time / ${seconds}
      AND counterparty_kind = ${counterparty(row)}
      AND exchange = COALESCE(${row}.exchange, '')`;

      return `
  UPDATE ${table} SET sat = sat - ${row}.sat, count = count - 1 WHERE ${key};
  DELETE FROM ${table} WHERE ${key} AND count <= 0;`;
    })
    .join('');

/**
 * Migration 2 — pre-aggregated rollups and a data version for caching (#2, #3, #4).
 *
 * The rollups are maintained by **triggers on `flows`**, not by the writer. Every path that
 * changes a flow — a new batch, an upsert after a label correction, a reorg rollback — goes
 * through them inside its own transaction, so the totals cannot drift from the raw rows no
 * matter which code made the change. Retention is the one deliberate exception (see
 * {@link ROLLUP_RETAIN_KEY}).
 */
const rollups: Migration = {
  version: 2,
  name: 'rollups_and_data_version',
  up: (db) => {
    // Key order matters: every read filters one direction over a bucket range, so leading
    // with flow_type makes that one contiguous range instead of interleaving both.
    for (const table of Object.keys(ROLLUP_LEVELS)) {
      db.exec(`
        CREATE TABLE ${table} (
          bucket            INTEGER NOT NULL,
          flow_type         TEXT    NOT NULL,
          counterparty_kind TEXT    NOT NULL,
          exchange          TEXT    NOT NULL DEFAULT '',
          sat               INTEGER NOT NULL,
          count             INTEGER NOT NULL,
          PRIMARY KEY (flow_type, bucket, counterparty_kind, exchange)
        ) WITHOUT ROWID;
      `);
    }

    // The partial first hour of a period is read from raw flows by time.
    db.exec(`CREATE INDEX idx_flows_type_time ON flows(flow_type, time);`);

    // The events list pages newest-first over every type. With no index on height alone,
    // SQLite sorted the whole period to return 50 rows (518 ms on 6 months); this index,
    // which carries the (txid, vout) key, is already in the page's order.
    db.exec(`CREATE INDEX idx_flows_height ON flows(height);`);

    db.exec(`
      CREATE TRIGGER flows_rollup_insert AFTER INSERT ON flows BEGIN
        ${addToRollups('NEW')}
      END;

      CREATE TRIGGER flows_rollup_update AFTER UPDATE ON flows BEGIN
        ${subtractFromRollups('OLD')}
        ${addToRollups('NEW')}
      END;

      CREATE TRIGGER flows_rollup_delete AFTER DELETE ON flows
      WHEN NOT EXISTS (SELECT 1 FROM sync_state WHERE key = '${ROLLUP_RETAIN_KEY}')
      BEGIN
        ${subtractFromRollups('OLD')}
      END;
    `);

    // Any change to the stored chain changes what the API would answer.
    const bump = `
      INSERT INTO sync_state (key, value) VALUES ('${DATA_VERSION_KEY}', '1')
      ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;`;

    db.exec(`
      CREATE TRIGGER blocks_version_insert AFTER INSERT ON blocks BEGIN ${bump} END;
      CREATE TRIGGER blocks_version_update AFTER UPDATE ON blocks BEGIN ${bump} END;
      CREATE TRIGGER blocks_version_delete AFTER DELETE ON blocks BEGIN ${bump} END;
      CREATE TRIGGER flows_version_update AFTER UPDATE ON flows BEGIN ${bump} END;
    `);

    // Existing flows, so an upgraded database answers from rollups straight away.
    for (const [table, seconds] of Object.entries(ROLLUP_LEVELS)) {
      db.exec(`
        INSERT INTO ${table} (bucket, flow_type, counterparty_kind, exchange, sat, count)
        SELECT time / ${seconds}, flow_type,
               CASE flow_type WHEN 'buying' THEN to_kind ELSE from_kind END,
               COALESCE(exchange, ''), SUM(sat), COUNT(*)
        FROM flows
        GROUP BY 1, 2, 3, 4;
      `);
    }

    db.exec(`INSERT OR IGNORE INTO sync_state (key, value) VALUES ('${DATA_VERSION_KEY}', '1');`);
  }
};

/**
 * Per-wallet rollup levels (#28, #30): daily, and 30-day buckets aligned to the epoch.
 *
 * Leaderboards group by address, so their cost is "distinct wallets per bucket × buckets".
 * Daily buckets alone made a 6-month leaderboard group ~180 days of wallets; 30-day buckets
 * cut that to six, with daily (and raw) only at the edges — see `api/ranges.ts`.
 */
export const WALLET_LEVELS = {
  wallet_daily: 86_400,
  wallet_monthly: 30 * 86_400
} as const;

/**
 * The wallet a flow is about: who withdrew from an exchange (buying) or deposited to one
 * (selling).
 *
 * p2p flows — wallet to wallet, and exchange to exchange — have no such side and are not
 * rolled up per wallet: a leaderboard of "who is buying or selling" is about exchange
 * flows, and a wallet profile reads its p2p history from raw `flows` through the address
 * indexes instead.
 */
const walletSide = (row: 'NEW' | 'OLD') => ({
  address: `CASE ${row}.flow_type WHEN 'buying' THEN ${row}.to_address ELSE ${row}.from_address END`,
  kind: `CASE ${row}.flow_type WHEN 'buying' THEN ${row}.to_kind ELSE ${row}.from_kind END`
});

const walletKeys = (row: 'NEW' | 'OLD') => {
  const side = walletSide(row);
  return {
    wallet_daily: {
      columns: 'flow_type, bucket, address, kind, exchange',
      values: `${row}.flow_type, ${row}.time / ${WALLET_LEVELS.wallet_daily}, ${side.address},
               ${side.kind}, COALESCE(${row}.exchange, '')`,
      where: `flow_type = ${row}.flow_type AND bucket = ${row}.time / ${WALLET_LEVELS.wallet_daily}
              AND address = ${side.address} AND kind = ${side.kind}
              AND exchange = COALESCE(${row}.exchange, '')`
    },
    wallet_monthly: {
      columns: 'flow_type, bucket, address, kind',
      values: `${row}.flow_type, ${row}.time / ${WALLET_LEVELS.wallet_monthly}, ${side.address},
               ${side.kind}`,
      where: `flow_type = ${row}.flow_type AND bucket = ${row}.time / ${WALLET_LEVELS.wallet_monthly}
              AND address = ${side.address} AND kind = ${side.kind}`
    }
  };
};

const addToWallets = (row: 'NEW' | 'OLD') =>
  Object.entries(walletKeys(row))
    .map(
      ([table, key]) => `
  INSERT INTO ${table} (${key.columns}, sat, count)
  VALUES (${key.values}, ${row}.sat, 1)
  ON CONFLICT (${key.columns}) DO UPDATE SET sat = sat + excluded.sat, count = count + 1;`
    )
    .join('');

const subtractFromWallets = (row: 'NEW' | 'OLD') =>
  Object.entries(walletKeys(row))
    .map(
      ([table, key]) => `
  UPDATE ${table} SET sat = sat - ${row}.sat, count = count - 1 WHERE ${key.where};
  DELETE FROM ${table} WHERE ${key.where} AND count <= 0;`
    )
    .join('');

const exchangeFlow = (row: 'NEW' | 'OLD') => `${row}.flow_type IN ('buying', 'selling')`;

/**
 * Migration 3 — per-wallet rollups for leaderboards and wallet profiles (#28, #30).
 *
 * Same contract as migration 2: maintained by triggers on `flows`, so inserts, upserts
 * (relabels), reorg deletes and updates keep them exact in the same transaction, and they
 * outlive retention via {@link ROLLUP_RETAIN_KEY}.
 *
 * `kind` is part of the key so a relabel moves a wallet's totals rather than mixing two
 * kinds into one row; `exchange` is in the daily key only, for per-exchange breakdowns.
 */
const walletRollups: Migration = {
  version: 3,
  name: 'wallet_rollups',
  up: (db) => {
    db.exec(`
      CREATE TABLE wallet_daily (
        flow_type TEXT    NOT NULL,
        bucket    INTEGER NOT NULL,
        address   TEXT    NOT NULL,
        kind      TEXT    NOT NULL,
        exchange  TEXT    NOT NULL DEFAULT '',
        sat       INTEGER NOT NULL,
        count     INTEGER NOT NULL,
        PRIMARY KEY (flow_type, bucket, address, kind, exchange)
      ) WITHOUT ROWID;

      CREATE TABLE wallet_monthly (
        flow_type TEXT    NOT NULL,
        bucket    INTEGER NOT NULL,
        address   TEXT    NOT NULL,
        kind      TEXT    NOT NULL,
        sat       INTEGER NOT NULL,
        count     INTEGER NOT NULL,
        PRIMARY KEY (flow_type, bucket, address, kind)
      ) WITHOUT ROWID;
    `);

    // One wallet's history (profile, leader breakdowns, previous-period deltas), and
    // address-prefix search.
    db.exec(`CREATE INDEX idx_wallet_daily_address ON wallet_daily(address, flow_type, bucket);`);

    // A wallet's p2p totals. The plain address indexes made a busy wallet's profile fetch
    // every one of its rows just to read flow_type (~250 ms for 60k flows); these partial,
    // covering indexes hold only p2p rows and the amount.
    db.exec(`
      CREATE INDEX idx_flows_p2p_in ON flows(to_address, sat) WHERE flow_type = 'p2p';
      CREATE INDEX idx_flows_p2p_out ON flows(from_address, sat) WHERE flow_type = 'p2p';
    `);

    db.exec(`
      CREATE TRIGGER flows_wallet_insert AFTER INSERT ON flows
      WHEN ${exchangeFlow('NEW')}
      BEGIN ${addToWallets('NEW')} END;

      CREATE TRIGGER flows_wallet_update_old AFTER UPDATE ON flows
      WHEN ${exchangeFlow('OLD')}
      BEGIN ${subtractFromWallets('OLD')} END;

      CREATE TRIGGER flows_wallet_update_new AFTER UPDATE ON flows
      WHEN ${exchangeFlow('NEW')}
      BEGIN ${addToWallets('NEW')} END;

      CREATE TRIGGER flows_wallet_delete AFTER DELETE ON flows
      WHEN ${exchangeFlow('OLD')}
        AND NOT EXISTS (SELECT 1 FROM sync_state WHERE key = '${ROLLUP_RETAIN_KEY}')
      BEGIN ${subtractFromWallets('OLD')} END;
    `);

    // Existing flows, so an upgraded database has leaderboards straight away.
    const side = {
      address: `CASE flow_type WHEN 'buying' THEN to_address ELSE from_address END`,
      kind: `CASE flow_type WHEN 'buying' THEN to_kind ELSE from_kind END`
    };
    db.exec(`
      INSERT INTO wallet_daily (flow_type, bucket, address, kind, exchange, sat, count)
      SELECT flow_type, time / ${WALLET_LEVELS.wallet_daily}, ${side.address}, ${side.kind},
             COALESCE(exchange, ''), SUM(sat), COUNT(*)
      FROM flows WHERE flow_type IN ('buying', 'selling')
      GROUP BY 1, 2, 3, 4, 5;

      INSERT INTO wallet_monthly (flow_type, bucket, address, kind, sat, count)
      SELECT flow_type, time / ${WALLET_LEVELS.wallet_monthly}, ${side.address}, ${side.kind},
             SUM(sat), COUNT(*)
      FROM flows WHERE flow_type IN ('buying', 'selling')
      GROUP BY 1, 2, 3, 4;
    `);
  }
};

/**
 * Migration 4 — address intelligence (#18, #19, #20, #31).
 *
 * - `label_candidates`: labels proposed by clustering and sweep detection. Never applied to
 *   flows until a human accepts one, which turns it into an `address_labels` row with
 *   `source = 'accepted'` (#20).
 * - `address_clusters`: common-input-ownership clusters, rebuilt on every clustering pass.
 * - `exchange_hops`: a withdrawal from one exchange matched to a deposit into another (or
 *   the same) by the same wallet shortly after. Kept so headline buy/sell can be shown with
 *   and without them; history, like the rollups, so retention does not erase it.
 * - `relabel_queue`: addresses whose effective label changed. Their flows are re-derived in
 *   bounded batches so totals follow the label, not the label at sync time (#18).
 *
 * Seeds the queue with every labelled address, so the new derivation rules (Foundation
 * internal transfers produce no flow; funder choice is order-independent) apply to flows
 * already stored.
 */
const intelligence: Migration = {
  version: 4,
  name: 'address_intelligence',
  up: (db) => {
    db.exec(`
      CREATE TABLE label_candidates (
        address    TEXT    NOT NULL,
        kind       TEXT    NOT NULL,
        name       TEXT    NOT NULL DEFAULT '',
        method     TEXT    NOT NULL,
        confidence REAL    NOT NULL,
        evidence   TEXT,
        status     TEXT    NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL DEFAULT (${now}),
        decided_at INTEGER,
        PRIMARY KEY (address, kind, name),
        CHECK (status IN ('pending', 'accepted', 'rejected')),
        CHECK (confidence >= 0 AND confidence <= 1)
      ) WITHOUT ROWID;
      CREATE INDEX idx_candidates_status ON label_candidates(status, confidence DESC);

      CREATE TABLE address_clusters (
        address    TEXT    PRIMARY KEY,
        cluster_id TEXT    NOT NULL,
        size       INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX idx_clusters_id ON address_clusters(cluster_id);

      CREATE TABLE exchange_hops (
        buy_txid      TEXT    NOT NULL,
        buy_vout      INTEGER NOT NULL,
        sell_txid     TEXT    NOT NULL,
        sell_vout     INTEGER NOT NULL,
        address       TEXT    NOT NULL,
        from_exchange TEXT    NOT NULL,
        to_exchange   TEXT    NOT NULL,
        buy_sat       INTEGER NOT NULL,
        sell_sat      INTEGER NOT NULL,
        buy_height    INTEGER NOT NULL,
        sell_height   INTEGER NOT NULL,
        buy_time      INTEGER NOT NULL,
        sell_time     INTEGER NOT NULL,
        PRIMARY KEY (buy_txid, buy_vout)
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX idx_hops_sell ON exchange_hops(sell_txid, sell_vout);
      CREATE INDEX idx_hops_buy_time ON exchange_hops(buy_time);
      CREATE INDEX idx_hops_sell_time ON exchange_hops(sell_time);
      CREATE INDEX idx_hops_height ON exchange_hops(sell_height);

      CREATE TABLE relabel_queue (
        address   TEXT    PRIMARY KEY,
        reason    TEXT,
        queued_at INTEGER NOT NULL DEFAULT (${now})
      ) WITHOUT ROWID;
    `);

    // A hop whose leg is removed (reorg rollback, relabel re-derivation) no longer exists.
    // Retention keeps them, like the rollups: they are history, not raw data.
    db.exec(`
      CREATE TRIGGER flows_hop_cleanup AFTER DELETE ON flows
      WHEN NOT EXISTS (SELECT 1 FROM sync_state WHERE key = '${ROLLUP_RETAIN_KEY}')
      BEGIN
        DELETE FROM exchange_hops WHERE buy_txid = OLD.txid AND buy_vout = OLD.vout;
        DELETE FROM exchange_hops WHERE sell_txid = OLD.txid AND sell_vout = OLD.vout;
      END;
    `);

    // No extra index for re-derivation: a wallet's transfers are found through
    // tx_deltas(address, height), and one transaction's flows through the (txid, vout) key.

    db.exec(`
      INSERT OR IGNORE INTO relabel_queue (address, reason)
      SELECT DISTINCT address, 'migration 4' FROM address_labels;
    `);
  }
};

/** Every migration, in ascending version order. Append only — never edit a shipped one. */
export const MIGRATIONS: readonly Migration[] = [
  initialSchema,
  rollups,
  walletRollups,
  intelligence
];

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
