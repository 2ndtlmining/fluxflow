/**
 * Run the whole intelligence pass on a database and print what it found (#19).
 *
 *   npm run precision -- <path/to/flux-flow.db> [--nodes <nodelist.json | url>] [--labels <labels.json>]
 *
 * Works on the file in place: migrates it to the latest schema, refreshes node-operator
 * labels, clusters, detects hops, re-derives every queued flow, then prints the precision
 * report and the counts. Run it on a COPY of a production database (e.g. one taken with the
 * pre-deploy backup in deploy/redeploy.sh), never on the live file.
 *
 * `--nodes` takes a saved `viewdeterministicfluxnodelist` reply or a URL; without it the
 * explorer's node list is fetched.
 */

/* eslint-disable no-console -- a CLI whose output is the result */

import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { openDatabase } from '../src/lib/server/db/database.js';
import { migrate } from '../src/lib/server/db/migrations.js';
import { createTestConfig, silentLogger } from '../src/lib/server/testkit.js';
import { loadLabels, replaceSourceLabels } from '../src/lib/server/labels.js';
import {
  computeNodeOperatorLabels,
  fetchNodeList,
  parseNodeList
} from '../src/lib/server/intel/nodes.js';
import { clusterAddresses, storeCandidates } from '../src/lib/server/intel/clusters.js';
import { detectHops, summariseHops } from '../src/lib/server/intel/hops.js';
import { Relabeler } from '../src/lib/server/intel/relabel.js';
import { precisionReport } from '../src/lib/server/intel/precision.js';
import { rollupMismatchCount } from '../src/lib/server/intel/consistency.js';

const args = process.argv.slice(2);
const dbPath = args.find(
  (arg) => !arg.startsWith('--') && !args[args.indexOf(arg) - 1]?.startsWith('--')
);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

if (!dbPath) {
  console.error('usage: npm run precision -- <db> [--nodes <file|url>] [--labels <labels.json>]');
  process.exit(2);
}

const config = createTestConfig({
  DATABASE_PATH: dbPath,
  LABELS_PATH: option('labels') ?? './config/labels.json'
});
const db = openDatabase({ config, log: silentLogger() });
const timings: Record<string, number> = {};
const time = <T>(label: string, work: () => T): T => {
  const started = performance.now();
  const result = work();
  timings[label] = Math.round(performance.now() - started);
  return result;
};

const migrated = time('migrate', () => migrate(db));
const labels = time('labels', () => loadLabels(db, config, silentLogger()));

const nodesArg = option('nodes');
const list = nodesArg
  ? /^https?:/.test(nodesArg)
    ? ((await fetchNodeList({ ownNodeUrl: nodesArg, explorerUrl: nodesArg }))?.list ?? null)
    : parseNodeList(JSON.parse(fs.readFileSync(nodesArg, 'utf8')))
  : ((await fetchNodeList({ explorerUrl: config.dataSources.fluxNodesApi }))?.list ?? null);

if (!list || list.size === 0) {
  console.error('could not load a node list');
  process.exit(1);
}

const exclude = new Set(
  [...labels.entries()].filter(([, label]) => label.kind !== 'node_operator').map(([a]) => a)
);
const operators = time('node operators', () => computeNodeOperatorLabels(db, list, exclude));
time('write labels', () => {
  replaceSourceLabels(db, 'node_list', operators.nodeList ?? []);
  replaceSourceLabels(db, 'node_rewards', operators.nodeRewards);
  replaceSourceLabels(db, 'forwarding', operators.forwarding);
});
const changed = time('refresh', () => labels.refresh('precision script'));

const clusters = time('cluster', () => clusterAddresses(db, labels));
const stored = time('store candidates', () => storeCandidates(db, clusters.candidates));
const hops = time('hops', () => detectHops(db, 0));

const relabeler = new Relabeler(db, labels, silentLogger());
const relabel = time('relabel', () => {
  let batches = 0;
  let txs = 0;
  let changedTxs = 0;
  let slowest = 0;
  while (relabeler.pending() > 0) {
    const result = relabeler.run({ budgetMs: 50 });
    batches++;
    txs += result.txs;
    changedTxs += result.changedTxs;
    slowest = Math.max(slowest, result.ms);
  }
  return { batches, txs, changedTxs, slowestBatchMs: slowest };
});

const configExchanges = new Map(
  [...labels.entries()]
    .filter(
      ([address, label]) =>
        label.kind === 'exchange' && labels.labelOf(address)?.source === 'config'
    )
    .map(([address, label]) => [address, label.name ?? ''])
);

const report = precisionReport(db, list, configExchanges);
const window = db
  .prepare<[], { from: number; to: number }>(
    `SELECT MIN(time) AS "from", MAX(time) AS "to" FROM blocks`
  )
  .get()!;

const forwardingLikely = operators.forwarding.filter((row) => row.confidence >= 0.7).length;

console.log(
  JSON.stringify(
    {
      database: dbPath,
      schema: migrated,
      blocks: db.prepare(`SELECT COUNT(*) AS n FROM blocks`).get(),
      nodeList: {
        paymentAddresses: list.size,
        nodes: [...list.values()].reduce((s, e) => s + e.nodes, 0)
      },
      labels: labels.stats(),
      nodeOperators: {
        onList: operators.nodeList?.length ?? 0,
        fromRewardsOnly: operators.nodeRewards.length,
        forwarding: {
          likely: forwardingLikely,
          possible: operators.forwarding.length - forwardingLikely
        },
        protocolPayouts: operators.protocolPayouts
      },
      clustering: {
        clusters: clusters.clusters,
        clusteredAddresses: clusters.clusteredAddresses,
        largest: clusters.largest,
        skippedCoinjoins: clusters.skippedCoinjoins,
        conflicts: clusters.conflicts,
        candidates: {
          total: clusters.candidates.length,
          commonInput: clusters.candidates.filter((c) => c.method === 'common_input').length,
          sweep: clusters.candidates.filter((c) => c.method === 'sweep').length,
          stored
        }
      },
      hops: { ...hops, window: summariseHops(db, window.from, window.to) },
      relabel: { changedAddresses: changed.length, ...relabel },
      rollupMismatches: rollupMismatchCount(db),
      byKind: db
        .prepare(
          `SELECT flow_type AS type, counterparty_kind AS kind, COUNT(*) AS buckets,
                  ROUND(SUM(sat) / 1e8, 2) AS flux
           FROM rollup_daily GROUP BY 1, 2 ORDER BY 1, 4 DESC`
        )
        .all(),
      precision: report,
      timingsMs: timings
    },
    null,
    2
  )
);

db.close();
