/**
 * SQLite connection management.
 *
 * One connection, opened once, shared by the API and the ingest worker. WAL mode lets
 * readers run while the single writer commits, which is what keeps `/api/*` responsive
 * during a backfill (#3, #5).
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Config } from '../config.js';

export type Db = Database.Database;

/** Pragmas applied to every connection, in order. */
function applyPragmas(db: Db, config: Config): void {
  // Incremental auto-vacuum, so retention can hand freed pages back to the OS a few at a
  // time instead of with a full VACUUM that rewrites the whole file while blocking the
  // event loop. Takes effect only on a database with no tables yet; an existing file
  // switches over on its next full VACUUM (see `BlockWriter.pruneBefore`).
  db.pragma('auto_vacuum = INCREMENTAL');
  // WAL: one writer, many concurrent readers.
  db.pragma('journal_mode = WAL');
  // NORMAL is the right trade-off under WAL: durable across process crashes, only at
  // risk from an OS-level crash, and an order of magnitude faster than FULL.
  db.pragma('synchronous = NORMAL');
  // ~32 MB of page cache, in KiB.
  db.pragma('cache_size = -32768');
  db.pragma(`busy_timeout = ${config.sqliteBusyTimeoutMs}`);
  // Bound WAL growth so a long backfill cannot fill the disk between checkpoints.
  db.pragma('wal_autocheckpoint = 2000');
  db.pragma('foreign_keys = ON');
  // Without this, the row an `INSERT OR REPLACE` deletes skips DELETE triggers, and the
  // rollups maintained by trigger (migration 2) would count the old row and the new one.
  db.pragma('recursive_triggers = ON');
  db.pragma('temp_store = MEMORY');
}

export interface OpenDatabaseOptions {
  config: Config;
  log: Logger;
  /** Open an in-memory database. Used by tests. */
  inMemory?: boolean;
}

/**
 * Open (creating if necessary) the SQLite database described by `config`.
 *
 * `DATABASE_PATH` is respected exactly as given, so a mounted volume such as
 * `/app/data/flux-flow.db` works. Parent directories are created as needed.
 */
export function openDatabase({ config, log, inMemory = false }: OpenDatabaseOptions): Db {
  const dbPath = inMemory ? ':memory:' : path.resolve(config.databasePath);

  if (!inMemory) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  // `verbose` is #6: it used to be on whenever NODE_ENV was not "production", which meant
  // `npm run server` and `npm run dev:all` printed every SQL statement — including all
  // ~500 inserts per sync batch. Now it requires an explicit DEBUG_SQL=1.
  const verbose = config.debugSql
    ? (message?: unknown, ...args: unknown[]) => log.debug({ sql: String(message), args }, 'sql')
    : undefined;

  const db = new Database(dbPath, {
    ...(verbose ? { verbose } : {}),
    timeout: config.sqliteBusyTimeoutMs
  });

  applyPragmas(db, config);

  log.info({ dbPath, inMemory }, 'database opened');

  return db;
}

/** Flush the WAL into the main database file and close the handle. */
export function closeDatabase(db: Db, log: Logger): void {
  try {
    // Fold the WAL back into the main file so a plain file copy of the .db is complete.
    if (db.open) db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    log.info('database closed');
  } catch (error) {
    log.error({ err: error }, 'failed to close database cleanly');
  }
}
