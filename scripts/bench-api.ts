/**
 * Benchmark the dashboard's read path on a full-size, synthetic 6-month database (#2, #4).
 *
 *   npx tsx scripts/bench-api.ts [flows=1500000]
 *
 * Builds a throwaway database in the OS temp directory: 518,400 blocks (6 months at 30 s)
 * and ~1.5M flows written through the real schema and triggers, so the rollups are built
 * the way production builds them. Then times each query the API runs, cold and warm.
 */

/* eslint-disable no-console -- a CLI whose output is the result */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDatabase } from '../src/lib/server/db/database.js';
import { migrate } from '../src/lib/server/db/migrations.js';
import { createTestConfig } from '../src/lib/server/testkit.js';
import {
  listFlowEvents,
  resolvePeriod,
  summariseDatabase,
  summariseFlow,
  topCounterparties
} from '../src/lib/server/api/queries.js';

const BLOCKS = 518_400;
const FLOWS = Number(process.argv[2] ?? 1_500_000);
const START = 1_740_000_000;
const EXCHANGES = ['Kucoin', 'Coinex', 'GateIO', 'NonKYC', 'Binance', 'MEXC', 'HTX'];
const KINDS = ['unknown', 'node_operator', 'foundation'];

const dir = mkdtempSync(join(tmpdir(), 'fluxflow-bench-'));
const db = openDatabase({
  config: createTestConfig({ DATABASE_PATH: join(dir, 'bench.db') }),
  log: { debug: () => {}, info: () => {}, error: () => {} } as never
});
migrate(db);

let seed = 42;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

console.log(`building ${BLOCKS.toLocaleString()} blocks, ${FLOWS.toLocaleString()} flows...`);
let started = performance.now();

const insertBlock = db.prepare(
  `INSERT INTO blocks (height, hash, time, tx_count, source) VALUES (?, ?, ?, 1, 'bench')`
);
const insertFlow = db.prepare(
  `INSERT INTO flows (txid, vout, height, time, from_address, from_kind, to_address, to_kind,
                      exchange, flow_type, sat)
   VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

const perBlock = FLOWS / BLOCKS;
const CHUNK = 20_000;

for (let from = 1; from <= BLOCKS; from += CHUNK) {
  db.transaction(() => {
    for (let height = from; height < Math.min(from + CHUNK, BLOCKS + 1); height++) {
      const time = START + height * 30;
      insertBlock.run(height, `h${height}`, time);

      // A Poisson-ish count around the average, so some blocks carry many flows.
      const n = Math.floor(perBlock * 2 * random() + (random() < perBlock % 1 ? 1 : 0));
      for (let i = 0; i < n; i++) {
        const flowType = random() < 0.45 ? 'buying' : random() < 0.8 ? 'selling' : 'p2p';
        const exchange = flowType === 'p2p' ? null : pick(EXCHANGES);
        insertFlow.run(
          `${height}-${i}`,
          height,
          time,
          `t1from${Math.floor(random() * 50_000)}`,
          flowType === 'buying' ? 'exchange' : pick(KINDS),
          `t1to${Math.floor(random() * 50_000)}`,
          flowType === 'selling' ? 'exchange' : pick(KINDS),
          exchange,
          flowType,
          Math.floor(random() * 5_000 * 1e8)
        );
      }
    }
  })();
}

const stats = summariseDatabase(db);
const rollupRows = db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM rollup_hourly`).get()!;
console.log(
  `built in ${((performance.now() - started) / 1000).toFixed(1)}s: ` +
    `${stats.flows.toLocaleString()} flows, ${rollupRows.n.toLocaleString()} rollup rows, ` +
    `${(stats.dbSizeBytes / 1e6).toFixed(0)} MB`
);

const PERIODS: Record<string, number> = {
  '24H': 86_400,
  '7D': 7 * 86_400,
  '30D': 30 * 86_400,
  '6M': 180 * 86_400
};

function time<T>(label: string, fn: () => T, runs = 5): void {
  started = performance.now();
  fn();
  const cold = performance.now() - started;

  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);

  console.log(
    `${label.padEnd(34)} cold ${cold.toFixed(1).padStart(8)} ms   warm p50 ${samples[Math.floor(runs / 2)]!.toFixed(1).padStart(8)} ms`
  );
}

console.log('');
for (const [period, seconds] of Object.entries(PERIODS)) {
  const window = resolvePeriod(db, stats.maxTime - seconds);

  time(`summary (buy+sell) ${period}`, () => {
    summariseFlow(db, window, 'buying');
    summariseFlow(db, window, 'selling');
  });
  time(`events page 1 ${period}`, () => listFlowEvents(db, window, { limit: 50 }));
  time(`top sellers ${period}`, () => topCounterparties(db, window, 'selling', 10), 2);
}
time('database summary (status)', () => summariseDatabase(db), 2);

db.close();
rmSync(dir, { recursive: true, force: true });
