/**
 * Test-only helpers.
 *
 * Not imported by any production code path — see the `testkit` usage in the `*.test.ts`
 * files. It lives in the source tree so it can reach the real modules without a second
 * package entry point.
 */

import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import { loadConfig, type Config } from './config.js';
import { openDatabase, migrate } from './db/index.js';
import type { Db } from './db/database.js';
import type { AddressKind, DataSource, FlowType } from './ingest/datasource/types.js';

export type { Db };

export const SATS = 100_000_000;

/** A config that never reads a real `.env` and never points at a real service. */
export function createTestConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    LABELS_PATH: './config/labels.json',
    LOG_LEVEL: 'silent',
    ...overrides
  });
}

/** An in-memory database with the current schema applied. */
export function createTestDb(): Db {
  const db = openDatabase({
    config: createTestConfig(),
    log: { debug: () => {}, info: () => {}, error: () => {} } as never,
    inMemory: true
  });

  migrate(db);
  return db;
}

export interface SeedFlow {
  readonly txid: string;
  readonly vout?: number;
  readonly height: number;
  readonly time: number;
  readonly fromAddress: string;
  readonly fromKind: AddressKind;
  readonly toAddress: string;
  readonly toKind: AddressKind;
  readonly flowType: FlowType;
  readonly exchange?: string | null;
  readonly amountFlux: number;
}

/** Insert flow rows so the read queries have something to aggregate. */
export function seedFlows(db: Db, flows: SeedFlow[]): void {
  const insertBlock = db.prepare(
    `INSERT OR REPLACE INTO blocks (height, hash, time, tx_count, source) VALUES (?, ?, ?, 1, 'test')`
  );
  const insertFlow = db.prepare(
    `INSERT OR REPLACE INTO flows
       (txid, vout, height, time, from_address, from_kind, to_address, to_kind,
        exchange, flow_type, sat)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const write = db.transaction(() => {
    for (const flow of flows) {
      insertBlock.run(flow.height, `hash-${flow.height}`, flow.time);
      insertFlow.run(
        flow.txid,
        flow.vout ?? 0,
        flow.height,
        flow.time,
        flow.fromAddress,
        flow.fromKind,
        flow.toAddress,
        flow.toKind,
        flow.exchange ?? null,
        flow.flowType,
        Math.round(flow.amountFlux * SATS)
      );
    }
  });

  write();
}

/** A fake data source that never touches the network. */
export function fakeDataSource(id = 'fake'): DataSource {
  return {
    id,
    description: `fake ${id}`,
    getTip: async () => 1_000,
    getBlock: async (height: number) => ({
      height,
      hash: `h${height}`,
      prevHash: null,
      time: 0,
      txCount: 0,
      transactions: []
    }),
    isHealthy: async () => true
  };
}

export interface TestServer {
  readonly url: string;
  close(): Promise<void>;
}

/** Start an Express app on an ephemeral port and return its base URL. */
export async function startTestServer(app: Express): Promise<TestServer> {
  const server: Server = await new Promise((resolve, reject) => {
    const created = createServer(app);
    created.once('error', reject);
    created.listen(0, '127.0.0.1', () => resolve(created));
  });

  const address = server.address();
  if (typeof address === 'string' || address === null) {
    throw new Error('server did not bind to a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

/** A pino-shaped logger that records nothing. */
export function silentLogger(): never {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => logger
  };

  return logger as never;
}
