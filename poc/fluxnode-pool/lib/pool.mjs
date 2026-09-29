// FluxNode pool: discover nodes, probe them, and fetch a block range in
// parallel across many nodes with integrity checks.

import { fluxos, getJson } from './http.mjs';

const DEFAULT_API_PORT = 16127;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export function nodeBaseUrl(ip) {
  if (!ip || typeof ip !== 'string') return null;
  if (ip.startsWith('http://') || ip.startsWith('https://')) return ip.replace(/\/$/, '');
  const trimmed = ip.trim();
  // Skip IPv6 (rare on Flux, would need brackets)
  if ((trimmed.match(/:/g) || []).length > 1) return null;
  const [host, port] = trimmed.split(':');
  return `http://${host}:${port || DEFAULT_API_PORT}`;
}

function extractNodeArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return payload.fluxNodes || payload.FluxNodes || payload.data || payload.nodes || [];
}

/**
 * Fetch the deterministic node list. Tries each source in order.
 * Returns [{ baseUrl, ip, tier, paymentAddress, lastPaidHeight }]
 */
export async function discoverNodes(sources, log = () => {}) {
  for (const src of sources) {
    try {
      const payload = src.startsWith('http') && src.includes('/daemon/')
        ? await fluxos(src.replace(/\/daemon\/.*$/, ''), src.slice(src.indexOf('/daemon/')), { timeoutMs: 30000 })
        : await getJson(src, { timeoutMs: 30000 });
      const arr = extractNodeArray(payload);
      const nodes = [];
      const seen = new Set();
      for (const n of arr) {
        const baseUrl = nodeBaseUrl(n.ip);
        if (!baseUrl || seen.has(baseUrl)) continue;
        seen.add(baseUrl);
        nodes.push({
          baseUrl,
          ip: n.ip,
          tier: n.tier,
          paymentAddress: n.payment_address,
          lastPaidHeight: n.last_paid_height,
        });
      }
      if (nodes.length > 0) {
        log(`discovered ${nodes.length} nodes from ${src}`);
        return { nodes, source: src, raw: arr };
      }
      log(`no nodes in response from ${src}`);
    } catch (err) {
      log(`discovery source failed ${src}: ${err.message}`);
    }
  }
  throw new Error('all discovery sources failed');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

function shuffle(arr, rnd = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/**
 * Probe candidates: height + latency, then consensus tip, then insight check.
 */
export async function probeNodes(candidates, { sample = 300, concurrency = 64, timeoutMs = 5000, log = () => {} } = {}) {
  const picked = shuffle(candidates).slice(0, sample);
  const started = Date.now();

  const probes = await mapLimit(picked, concurrency, async (node) => {
    const t0 = performance.now();
    try {
      const height = await fluxos(node.baseUrl, '/daemon/getblockcount', { timeoutMs });
      return { ...node, height: Number(height), latencyMs: performance.now() - t0, ok: Number.isFinite(Number(height)) };
    } catch (err) {
      return { ...node, ok: false, error: err.kind || err.message, latencyMs: performance.now() - t0 };
    }
  });

  const responsive = probes.filter((p) => p.ok);
  const tip = median(responsive.map((p) => p.height));
  const inSync = responsive.filter((p) => Math.abs(p.height - tip) <= 2);
  log(`probed ${picked.length} nodes in ${((Date.now() - started) / 1000).toFixed(1)}s: ${responsive.length} responsive, ${inSync.length} in sync (tip ${tip})`);

  // Reference block (well confirmed) whose hash the majority agrees on.
  const refHeight = tip - 20;
  const hashVotes = new Map();
  await mapLimit(inSync.slice(0, 7), 7, async (node) => {
    try {
      const h = await fluxos(node.baseUrl, `/daemon/getblockhash/${refHeight}`, { timeoutMs });
      hashVotes.set(h, (hashVotes.get(h) || 0) + 1);
    } catch { /* ignore */ }
  });
  const refHash = [...hashVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  // Insight check: getblockdeltas only works with insightexplorer=1
  // (spent index), which is what gives us input addresses + values.
  await mapLimit(inSync, concurrency, async (node) => {
    if (!refHash) return;
    try {
      const d = await fluxos(node.baseUrl, `/daemon/getblockdeltas/${refHash}`, { timeoutMs });
      node.insight = Array.isArray(d?.deltas);
    } catch (err) {
      node.insight = false;
      node.insightError = err.message;
    }
  });

  const failureKinds = {};
  for (const p of probes.filter((x) => !x.ok)) failureKinds[p.error] = (failureKinds[p.error] || 0) + 1;

  return {
    probes,
    tip,
    refHeight,
    refHash,
    inSync,
    insightNodes: inSync.filter((n) => n.insight),
    failureKinds,
    durationMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Parallel range fetch
// ---------------------------------------------------------------------------

/**
 * Fetch every block in [from, to] using a shared work queue.
 * Each node runs `perNodeInflight` workers; faster nodes take more work.
 *
 * Integrity:
 *  - the response must be the requested height and contain full tx objects
 *  - each node's first `probationBlocks` blocks, then a random 1 in
 *    `crossCheckEvery`, are re-read from a different node (hash, tx count and
 *    total output value must match); a mismatch evicts the node and
 *    re-queues every block it served
 *  - after the fetch, the prev-hash chain is verified end to end and the
 *    top block hash is confirmed by several nodes
 */
export async function fetchRange({
  nodes,
  verifyNodes = nodes,
  from,
  to,
  perNodeInflight = 2,
  timeoutMs = 15000,
  maxAttempts = 6,
  maxNodeFailures = 3,
  crossCheckEvery = 20,
  probationBlocks = 3,
  onBlock = () => {},
  log = () => {},
}) {
  const queue = [];
  for (let h = to; h >= from; h--) queue.push(h);
  const attempts = new Map();
  const blocks = new Map(); // height -> block
  const servedBy = new Map(); // height -> baseUrl
  const events = []; // { t, node, height, ms, bytes } for charts
  const errors = [];
  const evictions = [];
  const t0 = performance.now();

  const stats = new Map(
    nodes.map((n) => [n.baseUrl, { node: n, served: 0, verified: 0, errors: 0, consecutiveErrors: 0, totalMs: 0, bytes: 0, evicted: false }]),
  );

  const banned = new Set(); // any node (fetcher or verifier) caught misbehaving
  function evict(baseUrl, reason) {
    if (banned.has(baseUrl)) return;
    banned.add(baseUrl);
    const s = stats.get(baseUrl);
    if (!s) {
      evictions.push({ baseUrl, reason, t: performance.now() - t0 });
      log(`banned verifier ${baseUrl}: ${reason}`);
      return;
    }
    s.evicted = true;
    s.evictReason = reason;
    evictions.push({ baseUrl, reason, t: performance.now() - t0 });
    log(`evicted ${baseUrl}: ${reason}`);
    if (reason.startsWith('mismatch')) {
      // Anything this node served is untrusted: fetch it again elsewhere.
      for (const [h, by] of servedBy) {
        if (by === baseUrl) {
          blocks.delete(h);
          servedBy.delete(h);
          queue.push(h);
        }
      }
    }
  }

  function pickVerifier(exclude) {
    const pool = verifyNodes.filter((n) => !exclude.includes(n.baseUrl) && !banned.has(n.baseUrl));
    return pool[Math.floor(Math.random() * pool.length)];
  }

  async function fingerprintFrom(node, height) {
    try {
      const b = await fluxos(node.baseUrl, `/daemon/getblock/${height}/2`, { timeoutMs });
      return fingerprint(b);
    } catch {
      return null; // unavailable: not evidence either way
    }
  }

  // Majority of three. Returns 'ok' | 'source-bad' | 'inconclusive'.
  // A single verifier can itself be lying, so a disagreement is settled by a
  // third node and whichever side is outvoted gets evicted.
  async function crossCheck(height, block, fromNode) {
    const mine = fingerprint(block);
    const v1 = pickVerifier([fromNode]);
    if (!v1) return 'ok';
    const f1 = await fingerprintFrom(v1, height);
    if (f1 === null || f1 === mine) return 'ok';
    const v2 = pickVerifier([fromNode, v1.baseUrl]);
    const f2 = v2 ? await fingerprintFrom(v2, height) : null;
    if (f2 === mine) {
      evict(v1.baseUrl, `mismatch as verifier at height ${height} (outvoted 2:1)`);
      return 'ok';
    }
    if (f2 === f1) return 'source-bad';
    return 'inconclusive';
  }

  async function worker(baseUrl) {
    const s = stats.get(baseUrl);
    while (!s.evicted) {
      const height = queue.shift();
      if (height === undefined) {
        // Queue may refill after an eviction; wait briefly while others work.
        if (inFlight === 0) return;
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      inFlight++;
      const start = performance.now();
      try {
        const block = await fluxos(baseUrl, `/daemon/getblock/${height}/2`, { timeoutMs });
        if (!block || block.height !== height || !Array.isArray(block.tx) || typeof block.tx[0] !== 'object') {
          throw Object.assign(new Error('malformed block'), { kind: 'parse' });
        }
        const ms = performance.now() - start;
        // Probation: a node's first blocks are always verified, then a random sample.
        const verify = crossCheckEvery > 0 && (s.served < probationBlocks || Math.random() < 1 / crossCheckEvery);
        if (verify) {
          s.verified++;
          const verdict = await crossCheck(height, block, baseUrl);
          if (verdict === 'source-bad') {
            queue.unshift(height);
            evict(baseUrl, `mismatch at height ${height} (outvoted 2:1)`);
            continue;
          }
          if (verdict === 'inconclusive') {
            throw Object.assign(new Error('cross-check inconclusive'), { kind: 'verify' });
          }
        }
        blocks.set(height, block);
        servedBy.set(height, baseUrl);
        s.served++;
        s.consecutiveErrors = 0;
        s.totalMs += ms;
        const bytes = JSON.stringify(block).length;
        s.bytes += bytes;
        events.push({ t: performance.now() - t0, node: baseUrl, height, ms, bytes });
        onBlock(blocks.size, to - from + 1);
      } catch (err) {
        s.errors++;
        s.consecutiveErrors++;
        errors.push({ baseUrl, height, kind: err.kind || 'error', message: err.message });
        const a = (attempts.get(height) || 0) + 1;
        attempts.set(height, a);
        if (a < maxAttempts) queue.push(height);
        if (s.consecutiveErrors >= maxNodeFailures) evict(baseUrl, `${s.consecutiveErrors} consecutive errors (${err.kind || err.message})`);
      } finally {
        inFlight--;
      }
    }
  }

  let inFlight = 0;
  const workers = [];
  for (const n of nodes) {
    for (let i = 0; i < perNodeInflight; i++) workers.push(worker(n.baseUrl));
  }
  await Promise.all(workers);
  const fetchMs = performance.now() - t0;

  // --- Chain continuity + anchor ------------------------------------------
  const missing = [];
  const brokenLinks = [];
  for (let h = from; h <= to; h++) {
    const b = blocks.get(h);
    if (!b) { missing.push(h); continue; }
    const prev = blocks.get(h - 1);
    if (prev && b.previousblockhash !== prev.hash) brokenLinks.push(h);
  }
  const top = blocks.get(to);
  const anchorVotes = { agree: 0, disagree: 0 };
  if (top) {
    const voters = verifyNodes.filter((n) => !banned.has(n.baseUrl)).slice(0, 5);
    await mapLimit(voters, 5, async (n) => {
      try {
        const h = await fluxos(n.baseUrl, `/daemon/getblockhash/${to}`, { timeoutMs });
        if (h === top.hash) anchorVotes.agree++; else anchorVotes.disagree++;
      } catch { /* ignore */ }
    });
  }

  return {
    blocks,
    servedBy,
    events,
    errors,
    evictions,
    nodeStats: [...stats.values()].map((s) => ({
      baseUrl: s.node.baseUrl,
      tier: s.node.tier,
      served: s.served,
      verified: s.verified,
      errors: s.errors,
      avgMs: s.served ? s.totalMs / s.served : null,
      bytes: s.bytes,
      evicted: s.evicted,
      evictReason: s.evictReason || null,
    })),
    fetchMs,
    integrity: { missing, brokenLinks, anchorVotes },
  };
}

export function fingerprint(block) {
  return `${block.hash}:${block.tx.length}:${totalOut(block)}`;
}

export function totalOut(block) {
  let sat = 0;
  for (const tx of block.tx || []) for (const o of tx.vout || []) sat += Number(o.valueSat ?? Math.round(o.value * 1e8));
  return sat;
}
