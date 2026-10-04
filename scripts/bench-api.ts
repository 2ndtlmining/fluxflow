/**
 * Benchmark the dashboard's read path on a full-size, synthetic 6-month database (#2, #4).
 *
 *   npx tsx scripts/bench-api.ts [flows=1500000] [uniform]
 *
 * Builds a throwaway database in the OS temp directory: 518,400 blocks (6 months at 30 s)
 * and ~1.5M flows written through the real schema and triggers, so the rollups are built
 * the way production builds them. Then times each query the API runs, cold and warm.
 *
 * Wallets are drawn from a heavy-tailed pool by default — the same few thousand wallets
 * trade again and again, as on the real chain — with one kind per wallet, as a label gives.
 * `uniform` draws every flow's wallet from 50,000 at random instead: a pessimistic case in
 * which nearly every flow is a different wallet, so per-wallet rollups barely compress.
 *
 * Set `BENCH_DB=/path/bench.db` to keep the database and reuse it on the next run (the build
 * takes minutes); a reused database keeps whatever wallet distribution built it.
 */

/* eslint-disable no-console -- a CLI whose output is the result */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDatabase } from '../src/lib/server/db/database.js';
import { migrate } from '../src/lib/server/db/migrations.js';
import { createTestConfig } from '../src/lib/server/testkit.js';
import {
  flowSeries,
  listFlowEvents,
  openRange,
  resolvePeriod,
  summariseDatabase,
  summariseFlow
} from '../src/lib/server/api/queries.js';
import { leaderboard, walletProfile } from '../src/lib/server/api/wallets.js';

const BLOCKS = 518_400;
const FLOWS = Number(process.argv[2] ?? 1_500_000);
const UNIFORM = process.argv.includes('uniform');
const START = 1_740_000_000;
const EXCHANGES = ['Kucoin', 'Coinex', 'GateIO', 'NonKYC', 'Binance', 'MEXC', 'HTX'];
const KINDS = ['unknown', 'node_operator', 'foundation'];

const KEEP = process.env.BENCH_DB;
const REUSE = KEEP !== undefined && existsSync(KEEP);
const dir = KEEP ? undefined : mkdtempSync(join(tmpdir(), 'fluxflow-bench-'));
const db = openDatabase({
  config: createTestConfig({ DATABASE_PATH: KEEP ?? join(dir!, 'bench.db') }),
  log: { debug: () => {}, info: () => {}, error: () => {} } as never
});
migrate(db);

// mulberry32: a 32-bit generator in integer arithmetic. An LCG computed in floating point
// (seed * 1103515245 overflows 2^53) loses precision and cycles early, which quietly made a
// "uniform over 50,000 wallets" run draw far fewer distinct wallets.
let seed = 42;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

let started = performance.now();

const insertBlock = db.prepare(
  `INSERT INTO blocks (height, hash, time, tx_count, source) VALUES (?, ?, ?, 1, 'bench')`
);
const insertFlow = db.prepare(
  `INSERT INTO flows (txid, vout, height, time, from_address, from_kind, to_address, to_kind,
                      exchange, flow_type, sat)
   VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

/** A wallet and its (fixed) kind: heavy-tailed by default, uniform on request. */
function drawWallet(): { address: string; kind: string } {
  const index = UNIFORM ? Math.floor(random() * 50_000) : Math.floor(20_000 * random() ** 3);
  return { address: `t1wallet${index}`, kind: KINDS[index % KINDS.length]! };
}

const perBlock = FLOWS / BLOCKS;
const CHUNK = 20_000;

if (REUSE) console.log(`reusing ${KEEP}`);
else console.log(`building ${BLOCKS.toLocaleString()} blocks, ${FLOWS.toLocaleString()} flows...`);

for (let from = 1; !REUSE && from <= BLOCKS; from += CHUNK) {
  db.transaction(() => {
    for (let height = from; height < Math.min(from + CHUNK, BLOCKS + 1); height++) {
      const time = START + height * 30;
      insertBlock.run(height, `h${height}`, time);

      // A Poisson-ish count around the average, so some blocks carry many flows.
      const n = Math.floor(perBlock * 2 * random() + (random() < perBlock % 1 ? 1 : 0));
      for (let i = 0; i < n; i++) {
        const flowType = random() < 0.45 ? 'buying' : random() < 0.8 ? 'selling' : 'p2p';
        const exchange = flowType === 'p2p' ? null : pick(EXCHANGES);
        const wallet = drawWallet();
        const exchangeAddress = `t1exchange${exchange}`;

        if (flowType === 'p2p') {
          const other = drawWallet();
          insertFlow.run(
            `${height}-${i}`,
            height,
            time,
            wallet.address,
            wallet.kind,
            other.address,
            other.kind,
            null,
            flowType,
            Math.floor(random() * 5_000 * 1e8)
          );
        } else if (flowType === 'buying') {
          insertFlow.run(
            `${height}-${i}`,
            height,
            time,
            exchangeAddress,
            'exchange',
            wallet.address,
            wallet.kind,
            exchange,
            flowType,
            Math.floor(random() * 5_000 * 1e8)
          );
        } else {
          insertFlow.run(
            `${height}-${i}`,
            height,
            time,
            wallet.address,
            wallet.kind,
            exchangeAddress,
            'exchange',
            exchange,
            flowType,
            Math.floor(random() * 5_000 * 1e8)
          );
        }
      }
    }
  })();
}

const stats = summariseDatabase(db);
const rollupRows = db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM rollup_hourly`).get()!;
const walletRows = db
  .prepare<[], { daily: number; monthly: number }>(
    `SELECT (SELECT COUNT(*) FROM wallet_daily) AS daily,
            (SELECT COUNT(*) FROM wallet_monthly) AS monthly`
  )
  .get()!;
console.log(
  `wallets: ${REUSE ? 'as built' : UNIFORM ? 'uniform over 50,000' : 'heavy-tailed over 20,000'}; ` +
    `wallet_daily ${walletRows.daily.toLocaleString()} rows, ` +
    `wallet_monthly ${walletRows.monthly.toLocaleString()} rows`
);
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
  time(`top sellers ${period}`, () => leaderboard(db, openRange(window), 'selling', { limit: 10 }));
  time(`series ${period}`, () =>
    flowSeries(db, window, { bucketSeconds: seconds <= 7 * 86_400 ? 3_600 : 86_400 })
  );
}

const sixMonths = resolvePeriod(db, stats.maxTime - PERIODS['6M']!);
const whale = leaderboard(db, openRange(sixMonths), 'selling', { limit: 1 }).leaders[0];
if (whale) time('wallet profile (top seller)', () => walletProfile(db, whale.address));
time('database summary (status)', () => summariseDatabase(db), 2);

db.close();
if (dir) rmSync(dir, { recursive: true, force: true });
