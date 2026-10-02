/**
 * Database entry point: open the connection, verify the schema, return a handle.
 */

import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { closeDatabase, openDatabase, type Db } from './database.js';
import { detectLegacyDatabase, migrate } from './migrations.js';

export { closeDatabase, openDatabase, type Db } from './database.js';
export {
  LATEST_SCHEMA_VERSION,
  detectLegacyDatabase,
  migrate,
  getSchemaVersion
} from './migrations.js';

export interface DatabaseOptions {
  config: Config;
  log: Logger;
  /** Skip migrations. Used by tests that manage their own schema. */
  skipMigrate?: boolean;
  inMemory?: boolean;
}

export interface Database {
  readonly db: Db;
  close(): void;
}

/**
 * Open the database and make sure its schema is current.
 *
 * @throws if the file holds a legacy v1 database, rather than migrating it into a state
 * that mixes both schemas.
 */
export function initDatabase({
  config,
  log,
  skipMigrate = false,
  inMemory = false
}: DatabaseOptions): Database {
  const db = openDatabase({ config, log, inMemory });

  if (!skipMigrate) {
    const legacy = detectLegacyDatabase(db);
    if (legacy) {
      db.close();
      throw new Error(`Refusing to open database: ${legacy}`);
    }

    const result = migrate(db, log);
    if (result.applied.length > 0) {
      log.info({ from: result.from, to: result.to }, 'schema migrated');
    }
  }

  return {
    db,
    close: () => closeDatabase(db, log)
  };
}
