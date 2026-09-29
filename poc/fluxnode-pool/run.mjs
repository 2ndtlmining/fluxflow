#!/usr/bin/env node
// FluxNode pool proof of concept.
//
//   NODE_USE_ENV_PROXY=1 node poc/fluxnode-pool/run.mjs --blocks 2000
//
// Options (all optional):
//   --sources <url,url>   node list sources (default: api.runonflux.io + explorer)
//   --sample <n>          nodes to probe (default 400)
//   --pool <n>            max nodes used for fetching (default 40)
//   --inflight <n>        concurrent requests per node (default 2)
//   --blocks <n>          blocks to fetch in the main run (default 2000)
//   --confirmations <n>   stay this far below the tip (default 10)
//   --baseline <n>        blocks for the single-node baseline (default 60)
//   --scaling <list>      pool sizes for the scaling test (default 1,5,10,20,40)
//   --scaling-blocks <n>  blocks per scaling step (default 200)
//   --deep-blocks <n>     blocks sampled ~6 months back (default 500, 0 = skip)
//   --out <dir>           output dir (default poc/fluxnode-pool/out)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverNodes, probeNodes, fetchRange } from './lib/pool.mjs';
import { buildClassifier, validateBlocks } from './lib/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

const opts = {
  sources: arg('sources', [
    'https://api.runonflux.io/daemon/viewdeterministicfluxnodelist',
    'https://explorer.runonflux.io/api/status?q=getFluxNodes',
  ].join(',')).split(','),
  sample: Number(arg('sample', 400)),
  pool: Number(arg('pool', 40)),
  inflight: Number(arg('inflight', 2)),
  blocks: Number(arg('blocks', 2000)),
  confirmations: Number(arg('confirmations', 10)),
  baseline: Number(arg('baseline', 60)),
  scaling: arg('scaling', '1,5,10,20,40').split(',').map(Number).filter(Boolean),
  scalingBlocks: Number(arg('scaling-blocks', 200)),
  deepBlocks: Number(arg('deep-blocks', 500)),
  out: path.resolve(arg('out', path.join(here, 'out'))),
  label: arg('label', 'live FluxNode network'),
};

const logLines = [];
function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logLines.push(line);
  console.log(line);
}

function progress(label) {
  let last = 0;
  return (done, total) => {
    const pct = Math.floor((done / total) * 100);
    if (pct >= last + 10 || done === total) {
      last = pct;
      log(`${label}: ${done}/${total} blocks (${pct}%)`);
    }
  };
}

async function main() {
  fs.mkdirSync(opts.out, { recursive: true });
  log(`FluxNode pool PoC against ${opts.label}`);

  // 1. Discovery
  const discovery = await discoverNodes(opts.sources, log);

  // 2. Probe
  const probe = await probeNodes(discovery.nodes, { sample: opts.sample, log });
  const tiers = {};
  for (const n of probe.insightNodes) tiers[n.tier] = (tiers[n.tier] || 0) + 1;
  log(`insight-capable (input addresses available): ${probe.insightNodes.length}/${probe.inSync.length} in-sync nodes`);
  if (probe.insightNodes.length === 0) throw new Error('no insight-capable nodes found');

  const ranked = [...probe.insightNodes].sort((a, b) => a.latencyMs - b.latencyMs);
  const verifyNodes = probe.inSync;
  const top = probe.tip - opts.confirmations;

  // 3. Single-node sequential baseline: a node with typical (median) latency,
  // one request at a time, no hedging - roughly what depending on a single
  // API endpoint gives you.
  const baseFrom = top - opts.baseline + 1;
  const typical = ranked[Math.floor(ranked.length / 2)];
  log(`baseline: 1 typical node (${Math.round(typical.latencyMs)}ms probe latency), 1 request at a time, blocks ${baseFrom}-${top}`);
  const baseline = await fetchRange({
    nodes: [typical], verifyNodes, from: baseFrom, to: top, perNodeInflight: 1, crossCheckEvery: 0, hedge: false, log,
  });
  const baselineBps = baseline.blocks.size / (baseline.fetchMs / 1000);
  log(`baseline: ${baselineBps.toFixed(2)} blocks/s (latency p50 ${baseline.latency?.p50}ms)`);

  // 4. Scaling test on disjoint ranges
  const scaling = [];
  let cursor = baseFrom - 1;
  for (const size of opts.scaling) {
    const nodes = ranked.slice(0, size);
    if (nodes.length < size) break;
    const to = cursor;
    const from = to - opts.scalingBlocks + 1;
    cursor = from - 1;
    const r = await fetchRange({ nodes, verifyNodes, from, to, perNodeInflight: opts.inflight, crossCheckEvery: 0, log });
    const bps = r.blocks.size / (r.fetchMs / 1000);
    scaling.push({ nodes: size, blocks: r.blocks.size, seconds: r.fetchMs / 1000, blocksPerSec: bps, hedges: r.hedges, latency: r.latency });
    log(`scaling: ${size} nodes -> ${bps.toFixed(1)} blocks/s (hedges ${r.hedges.fired}/${r.hedges.won} fired/won)`);
  }

  // 5. Main parallel run
  const poolNodes = ranked.slice(0, opts.pool);
  const mainTo = cursor;
  const mainFrom = mainTo - opts.blocks + 1;
  log(`main run: ${opts.blocks} blocks (${mainFrom}-${mainTo}) across ${poolNodes.length} nodes x ${opts.inflight} in flight`);
  const main = await fetchRange({
    nodes: poolNodes, verifyNodes, from: mainFrom, to: mainTo,
    perNodeInflight: opts.inflight, crossCheckEvery: 20, onBlock: progress('main run'), log,
  });
  const mainBps = main.blocks.size / (main.fetchMs / 1000);
  log(`main run: ${main.blocks.size} blocks in ${(main.fetchMs / 1000).toFixed(1)}s = ${mainBps.toFixed(1)} blocks/s (latency p50 ${main.latency?.p50}ms p99 ${main.latency?.p99}ms, hedges fired ${main.hedges.fired}, won ${main.hedges.won})`);
  log(`integrity: missing=${main.integrity.missing.length} brokenLinks=${main.integrity.brokenLinks.length} anchor agree=${main.integrity.anchorVotes.agree}/${main.integrity.anchorVotes.agree + main.integrity.anchorVotes.disagree} evictions=${main.evictions.length}`);

  // 6. Deep history: FluxFlow needs ~6 months back, so check that old heights
  // come back complete too (spent index present for old inputs).
  let deep = null;
  if (opts.deepBlocks > 0) {
    const deepTo = probe.tip - FLUX_BLOCKS_6M;
    const deepFrom = deepTo - opts.deepBlocks + 1;
    log(`deep history: ${opts.deepBlocks} blocks around 6 months back (${deepFrom}-${deepTo})`);
    const d = await fetchRange({ nodes: poolNodes, verifyNodes, from: deepFrom, to: deepTo, perNodeInflight: opts.inflight, crossCheckEvery: 20, log });
    const classifierDeep = buildClassifier(discovery.raw, repoRoot);
    const dv = await validateBlocks([...d.blocks.values()], classifierDeep);
    deep = {
      from: deepFrom, to: deepTo, blocks: d.blocks.size, seconds: d.fetchMs / 1000, blocksPerSec: d.blocks.size / (d.fetchMs / 1000),
      integrity: d.integrity, blockTypes: dv.blockTypes, txKinds: dv.txKinds, transfers: dv.transfers,
      transfersWithFullInputs: dv.transfersWithFullInputs, conservationChecked: dv.conservationChecked,
      conservationFailures: dv.conservationFailures.length, flowByType: dv.flowByType,
      firstBlockTime: d.blocks.get(deepFrom)?.time,
    };
    log(`deep history: ${d.blocks.size} blocks at ${deep.blocksPerSec.toFixed(1)} blocks/s, ${dv.transfersWithFullInputs}/${dv.transfers} transfers with full inputs, ${deep.conservationFailures} conservation failures, block types ${JSON.stringify(dv.blockTypes)}`);
  }

  // 7. Data validation through FluxFlow's own code
  const classifier = buildClassifier(discovery.raw, repoRoot);
  const validation = await validateBlocks([...main.blocks.values()], classifier);
  log(`validation: ${validation.transfers} transfers, ${validation.transfersWithFullInputs} with full input data, ${validation.conservationFailures.length} value-conservation failures, ${validation.flowEvents} flow events from FluxFlow's processTransaction()`);

  const sixMonths = FLUX_BLOCKS_6M;
  const report = {
    generatedAt: new Date().toISOString(),
    label: opts.label,
    options: { ...opts, out: undefined },
    discovery: { source: discovery.source, nodes: discovery.nodes.length },
    probe: {
      sampled: probe.probes.length,
      responsive: probe.probes.filter((p) => p.ok).length,
      inSync: probe.inSync.length,
      insight: probe.insightNodes.length,
      tip: probe.tip,
      refHeight: probe.refHeight,
      refHash: probe.refHash,
      failureKinds: probe.failureKinds,
      insightTiers: tiers,
      durationMs: probe.durationMs,
      latencies: probe.probes.filter((p) => p.ok).map((p) => Math.round(p.latencyMs)),
      heightSpread: spread(probe.probes.filter((p) => p.ok).map((p) => p.height - probe.tip)),
    },
    baseline: { blocks: baseline.blocks.size, seconds: baseline.fetchMs / 1000, blocksPerSec: baselineBps, probeLatencyMs: Math.round(typical.latencyMs), latency: baseline.latency },
    scaling,
    main: {
      from: mainFrom, to: mainTo, nodes: poolNodes.length, inflight: opts.inflight,
      blocks: main.blocks.size, seconds: main.fetchMs / 1000, blocksPerSec: mainBps,
      speedup: mainBps / baselineBps,
      errors: main.errors.length,
      hedges: main.hedges,
      latency: main.latency,
      errorKinds: countBy(main.errors, (e) => e.kind),
      evictions: main.evictions,
      integrity: main.integrity,
      nodeStats: main.nodeStats.sort((a, b) => b.served - a.served),
      timeline: main.events.map((e) => [Math.round(e.t), e.node]),
      bytes: main.nodeStats.reduce((s, n) => s + n.bytes, 0),
    },
    projection: {
      sixMonthBlocks: sixMonths,
      hoursAtMainRate: sixMonths / mainBps / 3600,
      hoursAtBaselineRate: sixMonths / baselineBps / 3600,
    },
    validation,
    deep,
    log: logLines,
  };

  fs.writeFileSync(path.join(opts.out, 'report.json'), JSON.stringify(report, null, 2));
  const tpl = fs.readFileSync(path.join(here, 'report.html'), 'utf8');
  fs.writeFileSync(path.join(opts.out, 'report.html'), tpl.replace('/*__REPORT__*/null', JSON.stringify(report)));
  // Keep one raw sample block for inspection.
  const sample = main.blocks.get(mainTo);
  if (sample) fs.writeFileSync(path.join(opts.out, `sample-block-${mainTo}.json`), JSON.stringify(sample, null, 2));
  log(`wrote ${path.join(opts.out, 'report.html')}`);
}

const FLUX_BLOCKS_6M = (180 * 24 * 3600) / 30;

function countBy(arr, fn) {
  const o = {};
  for (const x of arr) { const k = fn(x); o[k] = (o[k] || 0) + 1; }
  return o;
}

function spread(deltas) {
  return countBy(deltas, (d) => (d < -5 ? '< -5' : d > 5 ? '> +5' : String(d)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
