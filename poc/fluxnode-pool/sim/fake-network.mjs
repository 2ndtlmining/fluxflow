#!/usr/bin/env node
// Simulated FluxNode network for testing the pool client offline.
//
// Starts one HTTP server per simulated node on 127.0.0.1, each emulating the
// FluxOS routes the PoC uses, returning fluxd-shaped JSON (see
// RunOnFlux/fluxd src/rpc/blockchain.cpp blockToJSON / rawtransaction.cpp
// TxToJSON and RunOnFlux/flux ZelBack/src/routes.js). A seed server serves
// /daemon/viewdeterministicfluxnodelist.
//
// Node behaviours: healthy, offline, lagging, flaky (5xx), hanging, non-insight
// (no input addresses, getblockdeltas disabled) and liar (tampered amounts).
//
//   node sim/fake-network.mjs --nodes 300 --seed-port 18000

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const NODE_COUNT = Number(arg('nodes', 300));
const SEED_PORT = Number(arg('seed-port', 18000));
const TIP = Number(arg('tip', 2_150_000));
const CHAIN_DEPTH = Number(arg("depth", 530000));

// Deterministic PRNG
function rng(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6d2b79f5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function fakeAddr(seed) { const r = rng(seed); let s = 't1'; for (let i = 0; i < 33; i++) s += B58[Math.floor(r() * 58)]; return s; }

const labels = JSON.parse(fs.readFileSync(path.join(here, '../../../src/lib/data/exchanges.json'), 'utf8'));
const exchangeAddrs = labels.exchanges.flatMap((e) => e.addresses);
const foundationAddrs = labels.foundation.addresses;

// --- Node set -----------------------------------------------------------------
const r0 = rng(42);
const tiers = ['CUMULUS', 'CUMULUS', 'CUMULUS', 'NIMBUS', 'STRATUS'];
const nodes = [];
for (let i = 0; i < NODE_COUNT; i++) {
  const x = r0();
  let behaviour = 'healthy';
  if (x < 0.10) behaviour = 'offline';
  else if (x < 0.14) behaviour = 'lagging';
  else if (x < 0.18) behaviour = 'flaky';
  else if (x < 0.20) behaviour = 'hanging';
  else if (x < 0.45) behaviour = 'noinsight';
  if (i === 7 || i === 23) behaviour = 'liar';
  const liar = behaviour === 'liar';
  nodes.push({
    port: SEED_PORT + 1 + i,
    tier: tiers[Math.floor(r0() * tiers.length)],
    paymentAddress: fakeAddr(1000 + (i % Math.floor(NODE_COUNT * 0.6))), // some operators run several nodes
    behaviour,
    latency: liar ? 70 : 60 + Math.floor(-Math.log(1 - r0()) * 180), // exponential-ish, 60ms floor
    maxConcurrent: 4,
    active: 0,
    waiting: [],
  });
}
const operatorAddrs = [...new Set(nodes.map((n) => n.paymentAddress))];

// --- Chain ----------------------------------------------------------------------
const blockCache = new Map();
function blockHash(h) { return sha(`block-${h}`); }

function makeBlock(h) {
  if (blockCache.has(h)) return blockCache.get(h);
  const r = rng(h * 7919);
  const txs = [];
  // Coinbase: PoN rewards to 3 node operators (+ small foundation share)
  const cbOut = [0, 1, 2].map((k) => operatorAddrs[Math.floor(r() * operatorAddrs.length)]);
  txs.push({
    txid: sha(`cb-${h}`), version: 4, overwintered: true, locktime: 0,
    vin: [{ coinbase: '03' + h.toString(16), sequence: 4294967295 }],
    vout: [...cbOut.map((a, n) => ({ a, v: [375000000, 225000000, 75000000][n] })), { a: foundationAddrs[0], v: 37500000 }]
      .map((o, n) => ({ value: o.v / 1e8, valueZat: o.v, valueSat: o.v, n, scriptPubKey: { type: 'pubkeyhash', addresses: [o.a] } })),
  });
  // Fluxnode confirmations (no vin/vout)
  const confirms = 5 + Math.floor(r() * 20);
  for (let i = 0; i < confirms; i++) {
    txs.push({ txid: sha(`fn-${h}-${i}`), version: 5, type: 'Confirming a fluxnode', collateral: `COutPoint(${sha(i)}, 0)`, ip: '1.2.3.4', update_type: 1, benchmark_tier: 'CUMULUS' });
  }
  // Transfers, some touching exchanges / foundation / node operators
  const transfers = Math.floor(r() * 6);
  for (let i = 0; i < transfers; i++) {
    const pick = r();
    let from = fakeAddr(h * 100 + i), to = fakeAddr(h * 100 + i + 50);
    if (pick < 0.15) to = exchangeAddrs[Math.floor(r() * exchangeAddrs.length)]; // sell
    else if (pick < 0.30) from = exchangeAddrs[Math.floor(r() * exchangeAddrs.length)]; // buy
    else if (pick < 0.40) from = operatorAddrs[Math.floor(r() * operatorAddrs.length)];
    else if (pick < 0.42) from = foundationAddrs[Math.floor(r() * foundationAddrs.length)];
    const nIn = 1 + Math.floor(r() * 3);
    const ins = Array.from({ length: nIn }, (_, k) => Math.floor((10 + r() * 20000) * 1e8 / nIn));
    const inSum = ins.reduce((a, b) => a + b, 0);
    const fee = 1000 + Math.floor(r() * 9000);
    const pay = Math.floor((inSum - fee) * (0.3 + r() * 0.7));
    const change = inSum - fee - pay;
    txs.push({
      txid: sha(`tx-${h}-${i}`), version: 4, overwintered: true, locktime: 0,
      vin: ins.map((v, k) => ({ txid: sha(`prev-${h}-${i}-${k}`), vout: k, scriptSig: { asm: '', hex: '' }, value: v / 1e8, valueSat: v, address: from, sequence: 4294967295 })),
      vout: [[to, pay], [from, change]].filter(([, v]) => v > 0).map(([a, v], n) => ({ value: v / 1e8, valueZat: v, valueSat: v, n, scriptPubKey: { type: 'pubkeyhash', addresses: [a] } })),
      vJoinSplit: [], valueBalance: 0, vShieldedSpend: [], vShieldedOutput: [],
    });
  }
  const block = {
    hash: blockHash(h), confirmations: TIP - h + 1, size: 2000 + txs.length * 400, height: h, version: 4,
    merkleroot: sha(`mr-${h}`), tx: txs, time: 1759000000 + (h - TIP) * 30, type: 'PON', collateral: 'COutPoint(x, 0)',
    bits: '1f07ffff', difficulty: 1, previousblockhash: blockHash(h - 1),
  };
  if (blockCache.size > 20000) blockCache.clear();
  blockCache.set(h, block);
  return block;
}

function stripInsight(block) {
  return { ...block, tx: block.tx.map((t) => (t.vin ? { ...t, vin: t.vin.map(({ address, value, valueSat, ...rest }) => rest) } : t)) };
}

function tamper(block) {
  return { ...block, tx: block.tx.map((t) => (t.vout && t.vin?.[0]?.address ? { ...t, vout: t.vout.map((o) => ({ ...o, valueSat: o.valueSat * 10, value: o.value * 10 })) } : t)) };
}

function deltas(block) {
  return {
    hash: block.hash, height: block.height, time: block.time,
    deltas: block.tx.filter((t) => t.vin).map((t, index) => ({
      txid: t.txid, index,
      inputs: t.vin.filter((i) => !i.coinbase).map((i, k) => ({ address: i.address, satoshis: -i.valueSat, index: k, prevtxid: i.txid, prevout: i.vout })),
      outputs: t.vout.map((o, k) => ({ address: o.scriptPubKey.addresses[0], satoshis: o.valueSat, index: k })),
    })),
  };
}

// --- HTTP -------------------------------------------------------------------------
const ok = (data) => JSON.stringify({ status: 'success', data });
const err = (message) => JSON.stringify({ status: 'error', data: { code: -8, name: 'Error', message } });

async function withCapacity(node, fn) {
  if (node.active >= node.maxConcurrent) await new Promise((r) => node.waiting.push(r));
  node.active++;
  try { return await fn(); } finally { node.active--; node.waiting.shift()?.(); }
}

function handle(node, req, res) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  withCapacity(node, async () => {
    if (node.behaviour === 'hanging') return; // never answers
    // ~1% of requests hit a slow tail (GC pause, busy disk, congested uplink)
    const jitter = node.latency * (0.7 + Math.random() * 0.6) + (Math.random() < 0.01 ? 4000 : 0);
    await sleep(jitter);
    if (node.behaviour === 'flaky' && Math.random() < 0.3) { res.writeHead(502).end('bad gateway'); return; }
    const tip = node.behaviour === 'lagging' ? TIP - 60 : TIP;
    const [, , route, a] = req.url.split('/');
    let body;
    if (route === 'getblockcount') body = ok(tip);
    else if (route === 'getblockhash') body = Number(a) <= tip ? ok(blockHash(Number(a))) : err('Block height out of range');
    else if (route === 'getblock') {
      const h = Number(a);
      if (h > tip || h < TIP - CHAIN_DEPTH) body = err('Block height out of range');
      else {
        let b = makeBlock(h);
        if (node.behaviour === 'noinsight') b = stripInsight(b);
        if (node.behaviour === 'liar') b = tamper(b);
        body = ok(b);
      }
    } else if (route === 'getblockdeltas') {
      if (node.behaviour === 'noinsight') body = err('Error: getblockdeltas is disabled. Run \'./flux-cli help getblockdeltas\' for instructions on how to enable this feature.');
      else {
        const h = [...Array(200).keys()].map((k) => TIP - k).find((x) => blockHash(x) === a);
        body = h ? ok(deltas(makeBlock(h))) : err('Block not found');
      }
    } else body = err('unknown route');
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
  }).catch(() => res.destroy());
}

let started = 0;
for (const node of nodes) {
  if (node.behaviour === 'offline') continue; // nothing listening -> ECONNREFUSED
  http.createServer((req, res) => handle(node, req, res)).listen(node.port, '127.0.0.1');
  started++;
}

http.createServer((req, res) => {
  if (req.url.startsWith('/daemon/viewdeterministicfluxnodelist')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(ok(nodes.map((n) => ({
      collateral: `COutPoint(${sha(n.port)}, 0)`, txhash: sha(n.port), outidx: 0,
      ip: `127.0.0.1:${n.port}`, network: '', added_height: TIP - 100000, confirmed_height: TIP - 99990,
      last_confirmed_height: TIP - 5, last_paid_height: TIP - 800, tier: n.tier, payment_address: n.paymentAddress,
    }))));
  } else res.writeHead(404).end();
}).listen(SEED_PORT, '127.0.0.1');

const counts = nodes.reduce((o, n) => ((o[n.behaviour] = (o[n.behaviour] || 0) + 1), o), {});
console.log(`simulated network: ${NODE_COUNT} nodes (${started} listening) on 127.0.0.1:${SEED_PORT + 1}-${SEED_PORT + NODE_COUNT}, tip ${TIP}`);
console.log(`behaviours: ${JSON.stringify(counts)}`);
console.log(`seed: http://127.0.0.1:${SEED_PORT}/daemon/viewdeterministicfluxnodelist`);
