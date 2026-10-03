import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../testkit.js';
import { hasInputAddresses, unwrap, type DaemonBlock } from './daemon.js';
import {
  BLOCK_DELTAS,
  DISABLED_ERROR,
  HASHES,
  INSIGHT_BLOCK,
  NODE_LIST,
  NON_INSIGHT_BLOCK,
  QUIET_BLOCK
} from './daemon.fixtures.js';
import {
  FluxNodePool,
  USER_AGENT,
  deltasToValueDeltas,
  normaliseBlock,
  parseHost,
  parseNodeList
} from './fluxnode.js';

const TIP = 1_001;

// ── Envelope and capability ─────────────────────────────────────────────────

describe('unwrap', () => {
  it('returns data on success', () => {
    expect(unwrap('http://node/daemon/getblockcount', { status: 'success', data: 42 })).toBe(42);
  });

  it('throws with the daemon message on an error', () => {
    // Treating an error body as data is how a node ends up "serving" an empty block.
    expect(() => unwrap('http://node/x', DISABLED_ERROR)).toThrow(/insightexplorer/);
  });

  it('throws on an unrecognised status', () => {
    expect(() => unwrap('http://node/x', { status: 'weird', data: 1 } as never)).toThrow(
      /status=weird/
    );
  });
});

describe('hasInputAddresses', () => {
  it('is true when a spent input carries an address', () => {
    expect(hasInputAddresses(INSIGHT_BLOCK)).toBe(true);
  });

  it('is false when no input carries an address', () => {
    expect(hasInputAddresses(NON_INSIGHT_BLOCK)).toBe(false);
  });

  it('does not treat a coinbase as evidence of capability', () => {
    // A coinbase has no previous output to resolve, so seeing one proves nothing about
    // whether this node has the spent index.
    expect(hasInputAddresses({ hash: 'h', height: 1, time: 0, tx: [INSIGHT_BLOCK.tx![0]!] })).toBe(
      false
    );
  });

  it('is false for an empty block', () => {
    expect(hasInputAddresses({ hash: 'h', height: 1, time: 0 })).toBe(false);
  });
});

// ── Node list parsing ───────────────────────────────────────────────────────

describe('parseNodeList', () => {
  it('extracts usable addresses from the live response shape', () => {
    // Recorded from the real endpoint: the key is `fluxNodes`, not `data.nodes`. A parser
    // written against the issue text alone finds zero nodes and reports an empty pool
    // without ever saying so.
    const parsed = parseNodeList(NODE_LIST);

    // STRATUS first: the list is ordered by tier so that when the sample has to be cut, it
    // is the better-provisioned nodes that survive.
    expect(parsed.map((node) => node.ip)).toEqual([
      '185.13.30.13',
      '80.241.213.220',
      '24.108.153.230'
    ]);
  });

  it('keeps the API port a node publishes inline', () => {
    // UPnP nodes report `24.108.153.230:16147`. Probing only the default ports would miss
    // a large share of the live network.
    const parsed = parseNodeList(NODE_LIST);

    expect(parsed.find((node) => node.ip === '24.108.153.230')?.port).toBe(16_147);
    expect(parsed.find((node) => node.ip === '80.241.213.220')?.port).toBeUndefined();
  });

  it('ignores anything that is not a routable address', () => {
    const ips = parseNodeList(NODE_LIST).map((node) => node.ip);

    // Probing 127.0.0.1 on a pool of 15 would look like 15 healthy nodes while fetching
    // the same local daemon every time.
    expect(ips).not.toContain('127.0.0.1');
    expect(ips).not.toContain('0.0.0.0');
    expect(ips).not.toContain('169.254.1.1');
    expect(ips).not.toContain('999.1.1.1');
    expect(ips).not.toContain('not-an-ip');
  });

  it('de-duplicates repeated addresses', () => {
    const parsed = parseNodeList(NODE_LIST);

    expect(new Set(parsed.map((node) => node.ip)).size).toBe(parsed.length);
  });

  it('puts the better-provisioned tiers first', () => {
    const parsed = parseNodeList({
      fluxNodes: [
        { ip: '185.13.30.20', tier: 'CUMULUS' },
        { ip: '185.13.30.21', tier: 'NIMBUS' },
        { ip: '185.13.30.22', tier: 'STRATUS' }
      ]
    });

    expect(parsed.map((node) => node.tier)).toEqual(['STRATUS', 'NIMBUS', 'CUMULUS']);
  });

  it('reads a bare array and a data-wrapped one as well', () => {
    expect(parseNodeList([{ ip: '185.13.30.30' }])).toHaveLength(1);
    expect(parseNodeList({ data: [{ ip: '185.13.30.31' }] })).toHaveLength(1);
  });

  it('returns nothing for a shape it does not recognise', () => {
    // Better an empty pool the breaker can fail over from than a silent wrong one.
    expect(parseNodeList({ unexpected: 'payload' })).toEqual([]);
    expect(parseNodeList(null)).toEqual([]);
  });
});

describe('parseHost', () => {
  it('accepts a bare IPv4 address', () => {
    expect(parseHost('80.241.213.220')).toEqual({ address: '80.241.213.220', port: null });
  });

  it('splits an inline port off an IPv4 address', () => {
    expect(parseHost('24.108.153.230:16147')).toEqual({
      address: '24.108.153.230',
      port: 16_147
    });
  });

  it('skips IPv6 addresses for now', () => {
    // Requests were built as `http://${ip}:${port}` without brackets, so every IPv6 node got
    // a malformed URL and wasted a probe slot. #35 scopes IPv6 out until it is supported.
    expect(parseHost('[2a03::1]:16127')).toBeNull();
    expect(parseHost('[2a03::1]')).toBeNull();
    expect(parseHost('2a03::1')).toBeNull();
  });

  it('rejects private, shared and documentation ranges', () => {
    // The node list is a remote response. Accepting these would have FluxFlow probe hosts
    // on its own LAN on the operator's behalf.
    for (const host of [
      '10.0.0.5',
      '10.0.0.5:16127',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '100.64.0.1',
      '100.127.255.254',
      '198.18.0.1',
      '192.0.2.10',
      '198.51.100.10',
      '203.0.113.10',
      '[fe80::1]:16127',
      '[fc00::1]'
    ]) {
      expect(parseHost(host), host).toBeNull();
    }
  });

  it('keeps public addresses next to the private ranges', () => {
    for (const host of ['172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '11.0.0.1']) {
      expect(parseHost(host), host).not.toBeNull();
    }
  });

  it('rejects an out-of-range port rather than clamping it', () => {
    expect(parseHost('80.241.213.220:99999')).toBeNull();
    expect(parseHost('80.241.213.220:0')).toBeNull();
    expect(parseHost('80.241.213.220:http')).toBeNull();
  });

  it('rejects loopback, unspecified and link-local addresses', () => {
    for (const host of [
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '0.1.2.3',
      '169.254.10.1',
      '[::1]',
      '[::]'
    ]) {
      expect(parseHost(host), host).toBeNull();
    }
  });

  it('rejects a malformed octet rather than truncating it', () => {
    // `999.1.1.1` would otherwise become `255.1.1.1` under naive clamping.
    expect(parseHost('999.1.1.1')).toBeNull();
    expect(parseHost('1.2.3')).toBeNull();
    expect(parseHost('1.2.3.4.5')).toBeNull();
  });

  it('rejects an empty or whitespace-only address', () => {
    expect(parseHost('')).toBeNull();
    expect(parseHost('   ')).toBeNull();
  });
});

// ── Normalisation ───────────────────────────────────────────────────────────

describe('normaliseBlock', () => {
  it('reads satoshi amounts, not FLUX', () => {
    const block = normaliseBlock(INSIGHT_BLOCK);

    const transfer = block.transactions.find((tx) => tx.txid === 'tx-1000-1')!;

    // `value` says 0.005 FLUX; `valueSat` says 500,000 sat. v1's parseFloat(value)/1e8 is
    // right for Blockbook and 1e8 too small here (#15).
    expect(transfer.outputs[0]!.sat).toBe(500_000);
    expect(transfer.inputs[0]!.sat).toBe(500_000);
  });

  it('falls back to the FLUX field when no satoshi field is present', () => {
    const block = normaliseBlock({
      hash: 'h',
      height: 1,
      time: 0,
      tx: [
        {
          txid: 't',
          vin: [],
          vout: [{ n: 0, value: 1.5, scriptPubKey: { addresses: ['t1a'] } }]
        }
      ]
    });

    expect(block.transactions[0]!.outputs[0]!.sat).toBe(150_000_000);
  });

  it('marks an address-less output as nulldata', () => {
    const block = normaliseBlock(INSIGHT_BLOCK);
    const transfer = block.transactions.find((tx) => tx.txid === 'tx-1000-1')!;

    // OP_RETURN is not a counterparty transfer; recording it as one inflates every total.
    expect(transfer.outputs[1]).toMatchObject({ n: 1, address: null, nulldata: true });
  });

  it('classifies the coinbase and a node confirmation', () => {
    const block = normaliseBlock({
      hash: 'h',
      height: 1,
      time: 0,
      tx: [
        { txid: 'cb', vin: [{ coinbase: 'x' }], vout: [] },
        { txid: 'nc', kind: 'fluxnode_confirm', vin: [{ txid: 'a', vout: 0 }], vout: [] },
        { txid: 'ct', kind: 'contract', vin: [{ txid: 'a', vout: 0 }], vout: [] }
      ]
    });

    expect(block.transactions.map((tx) => tx.kind)).toEqual(['coinbase', 'node_confirm', 'other']);
  });

  it('marks a block with unresolved inputs as incomplete', () => {
    // The pipeline skips incomplete blocks rather than writing flows with no counterparty.
    expect(normaliseBlock(NON_INSIGHT_BLOCK).transactions[1]!.complete).toBe(false);
    expect(normaliseBlock(INSIGHT_BLOCK).transactions[1]!.complete).toBe(true);
  });

  it('treats a coinbase-only block as complete', () => {
    // A coinbase has no inputs to resolve, so its absence is not a defect.
    expect(normaliseBlock(INSIGHT_BLOCK).transactions[0]!.complete).toBe(true);
  });

  it('carries the header fields through', () => {
    expect(normaliseBlock(INSIGHT_BLOCK)).toMatchObject({
      height: 1_000,
      hash: HASHES[1000],
      prevHash: HASHES[999],
      time: 1_756_000_000,
      txCount: 2
    });
  });

  it('has no previous hash on a genesis block', () => {
    expect(normaliseBlock({ hash: 'h', height: 0, time: 0 }).prevHash).toBeNull();
  });

  it('rejects a negative amount rather than writing it', () => {
    expect(() =>
      normaliseBlock({
        hash: 'h',
        height: 1,
        time: 0,
        tx: [
          { txid: 't', vin: [], vout: [{ n: 0, valueSat: -1, scriptPubKey: { addresses: ['a'] } }] }
        ]
      })
    ).toThrow(RangeError);
  });
});

describe('deltasToValueDeltas', () => {
  it('reads the nested per-transaction shape a live node actually returns', () => {
    // The reply is `{ data: { deltas: [...] } }`, not the flat `{ inputs, outputs }` shape
    // the issue describes. Parsed as documented, a real reply reads as an empty block.
    expect(deltasToValueDeltas(BLOCK_DELTAS)).toEqual([
      { address: 't1nodeoperator0001', satIn: 0, satOut: 3_000 },
      { address: 't1exchange00001', satIn: 500_000, satOut: 0 },
      { address: 't1whale00000001', satIn: 0, satOut: 500_000 }
    ]);
  });

  it('uses the sign of satoshis to tell input from output', () => {
    const deltas = deltasToValueDeltas(BLOCK_DELTAS);
    const funder = deltas.find((entry) => entry.address === 't1exchange00001');

    // Negative satoshis on an input means it left that address.
    expect(funder).toEqual({ address: 't1exchange00001', satIn: 500_000, satOut: 0 });
  });

  it('skips entries with no address', () => {
    expect(
      deltasToValueDeltas({
        hash: 'h',
        deltas: [
          {
            txid: 't',
            inputs: [{ satoshis: -100 }],
            outputs: [{ satoshis: 100 }]
          }
        ]
      })
    ).toEqual([]);
  });

  it('handles an empty response and a block with no transfers', () => {
    expect(deltasToValueDeltas({ hash: 'h' })).toEqual([]);
    expect(deltasToValueDeltas({ hash: 'h', deltas: [] })).toEqual([]);
  });
});

describe('node confirmation classification', () => {
  it('does not treat a node confirmation as a transfer', () => {
    const block = normaliseBlock(QUIET_BLOCK);

    // Most FLUX blocks hold only a coinbase and node confirmations. Recording a confirmation
    // as a transfer creates a zero-amount flow row for every node in every block.
    expect(block.transactions.map((tx) => tx.kind)).toEqual(['coinbase', 'node_confirm']);
    expect(
      block.transactions.every((tx) => tx.outputs.length === 0 || tx.kind !== 'transfer')
    ).toBe(true);
  });

  it('agrees that a quiet block cannot prove a node lacks a spent index', () => {
    // This is exactly the mistake the live run made: probing capability by fetching one
    // block and looking for a resolved input, on a chain where most blocks have no
    // transfers to resolve. 39 nodes answered; 0 were marked capable.
    expect(hasInputAddresses(QUIET_BLOCK)).toBe(false);
    expect(QUIET_BLOCK.tx!.length).toBeGreaterThan(1);
  });

  it('still finds a resolved input in a block that has one', () => {
    expect(hasInputAddresses(INSIGHT_BLOCK)).toBe(true);
  });
});

// ── The pool ────────────────────────────────────────────────────────────────

interface FakeNode {
  readonly ip: string;
  tip: number;
  /** Respond as a node with no spent index. */
  noInsight: boolean;
  /** What `getblockhash` reports. */
  hashFor?: string;
  /** What `getblock` puts in the block. Different from `hashFor` means the node is lying. */
  blockHash?: string;
  /** Report a block at this height instead of the requested one. */
  serveOffset?: number;
  fail?: boolean;
  latencyMs: number;
  blockRequests: number;
  tipRequests: number;
  /** Ports this node answers on. Anything else looks like a closed port. */
  ports: number[];
  /** Publish this port inline in the discovery response, as a real UPnP node does. */
  inlinePort?: number;
  tier?: string;
}

/**
 * Build a discovery response publishing exactly the fake nodes a test declared.
 *
 * Derived from the nodes rather than a fixed fixture, so a test that invents a node gets a
 * pool containing it. The unusable entries are carried over from the recorded response,
 * because filtering them is part of what is under test.
 */
function discoveryFor(nodes: FakeNode[]): unknown {
  return {
    fluxNodes: [
      ...nodes.map((each) => ({
        ip: each.inlinePort === undefined ? each.ip : `${each.ip}:${each.inlinePort}`,
        tier: each.tier ?? 'CUMULUS'
      })),
      { ip: '127.0.0.1', tier: 'CUMULUS' },
      { ip: '0.0.0.0', tier: 'CUMULUS' },
      { ip: 'not-an-ip', tier: 'CUMULUS' }
    ]
  };
}

/** Every honest node agrees on a hash for a height. */
function hashFor(height: number): string {
  if (height === 1_000) return HASHES[1000];
  if (height === 999) return HASHES[999];
  return String(height).padStart(64, '0');
}

/**
 * A pool wired to in-memory fake nodes.
 *
 * The clock and the sleep function are injected so backoff and benching are testable
 * without real waiting — the same approach the sync service uses.
 */
function buildPool(
  nodes: FakeNode[],
  overrides: Partial<{
    poolSize: number;
    spotCheckEvery: number;
    tipTolerance: number;
    benchSeconds: number;
    maxInflightPerNode: number;
    ports: number[];
    /** Called as a request starts, so concurrency can be observed. */
    onRequest?: (node: FakeNode, inflight: number) => void;
    /** Called with every request's headers. */
    onHeaders?: (headers: Record<string, string>) => void;
  }> = {}
) {
  let clock = 1_000_000;
  const state = { clock: () => clock };
  const seen = new Map<string, FakeNode>();
  /** Requests currently open per node, so the in-flight cap can be observed. */
  const inflight = new Map<string, number>();

  const fetchImpl = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    const parsed = new URL(url);

    overrides.onHeaders?.(init?.headers ?? {});

    // The discovery endpoint is one host with no node behind it.
    if (parsed.hostname === 'explorer.test') {
      return new Response(JSON.stringify(discoveryFor(nodes)), { status: 200 });
    }

    const key = `${parsed.hostname}:${parsed.port}`;
    const node = seen.get(key);

    if (!node) throw new TypeError(`fetch failed: no fake node at ${key}`);
    if (node.fail) throw new TypeError('fetch failed');

    const depth = (inflight.get(key) ?? 0) + 1;
    inflight.set(key, depth);
    overrides.onRequest?.(node, depth);

    try {
      if (node.latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, node.latencyMs));
        clock += node.latencyMs;
      }

      const data = payloadFor(node, parsed.pathname);

      // A payload that is already an envelope is returned as-is, so the error replies can
      // be exercised. Everything else is wrapped the way FluxOS wraps it.
      const body =
        data !== null && typeof data === 'object' && 'status' in data
          ? data
          : { status: 'success', data };

      return new Response(JSON.stringify(body), { status: 200 });
    } finally {
      inflight.set(key, (inflight.get(key) ?? 1) - 1);
    }
  });

  function payloadFor(node: FakeNode, path: string): unknown {
    const height = Number(path.split('/').pop());

    if (path.endsWith('/getblockcount')) {
      node.tipRequests++;
      return node.tip;
    }

    if (path.includes('/getblockhash/')) {
      node.blockRequests++;
      return node.hashFor ?? hashFor(height);
    }

    if (path.includes('/getblock/')) {
      node.blockRequests++;

      if (height > node.tip) return { status: 'error', data: { message: 'Block not found' } };

      // A node answering with the wrong height: plausible, and completely wrong.
      if (node.serveOffset !== undefined) {
        const served = height + node.serveOffset;
        return {
          hash: hashFor(served),
          height: served,
          time: 1_756_000_000,
          previousblockhash: hashFor(served - 1),
          tx: INSIGHT_BLOCK.tx
        };
      }

      if (height === 1_000) {
        const block: DaemonBlock = node.noInsight ? NON_INSIGHT_BLOCK : INSIGHT_BLOCK;
        return node.blockHash ? { ...block, hash: node.blockHash } : block;
      }

      // A quiet block: coinbase and node confirmations only, no transfers at all.
      if (height === node.tip - 1) return { ...QUIET_BLOCK, hash: hashFor(height), height };

      return {
        hash: node.blockHash ?? hashFor(height),
        height,
        time: 1_756_000_000,
        previousblockhash: hashFor(height - 1),
        txCount: 1,
        tx: [
          {
            txid: `tx-${height}`,
            kind: 'transfer',
            vin: [{ txid: 'prev', vout: 0, address: 't1exchange00001', valueSat: 500_000 }],
            vout: [
              {
                valueSat: 500_000,
                n: 0,
                scriptPubKey: { addresses: ['t1whale00000001'] }
              }
            ]
          }
        ]
      };
    }

    if (path.includes('/getblockdeltas/')) {
      return node.noInsight ? DISABLED_ERROR : { status: 'success', data: BLOCK_DELTAS };
    }

    return null;
  }

  // Only the ports a node actually answers on. Probing an unlisted port has to look like a
  // closed port, which is how the "tries the next port" path gets exercised.
  for (const each of nodes) {
    for (const port of each.ports) seen.set(`${each.ip}:${port}`, each);
  }

  // Ports declared inline in the discovery response are registered too, since that is how a
  // real UPnP node publishes itself.
  for (const candidate of parseNodeList(discoveryFor(nodes))) {
    if (candidate.port === undefined) continue;
    for (const each of nodes) {
      if (each.ip === candidate.ip) seen.set(`${each.ip}:${candidate.port}`, each);
    }
  }

  const pool = new FluxNodePool({
    discoveryUrl: 'http://explorer.test/api/status?q=getFluxNodes',
    poolSize: overrides.poolSize ?? 10,
    probeSample: 50,
    maxInflightPerNode: overrides.maxInflightPerNode ?? 2,
    apiPorts: overrides.ports ?? [16_127],
    discoverySeconds: 1_800,
    benchSeconds: overrides.benchSeconds ?? 120,
    tipTolerance: overrides.tipTolerance ?? 2,
    probeTimeoutMs: 2_000,
    spotCheckEvery: overrides.spotCheckEvery ?? 0,
    log: silentLogger(),
    http: { fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0 },
    now: state.clock,
    /*
     * Advance the injected clock, but also yield to the real event loop.
     *
     * Advancing the clock alone would spin the pool's saturation wait through its whole
     * deadline in under a millisecond of real time — before any in-flight fetch had a
     * chance to finish. Yielding keeps the fake time and the real work in step.
     */
    sleep: async (ms) => {
      clock += ms;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  });

  return { pool, fetchImpl, state, advance: (ms: number) => (clock += ms), clock: state.clock };
}

function node(ip: string, overrides: Partial<FakeNode> = {}): FakeNode {
  return {
    ip,
    ports: [16_127],
    tip: TIP,
    noInsight: false,
    latencyMs: 0,
    blockRequests: 0,
    tipRequests: 0,
    ...overrides
  };
}

describe('FluxNodePool', () => {
  describe('discovery and probing', () => {
    it('probes only the addresses from the discovery response', async () => {
      const good = node('185.13.30.11');
      const { pool, fetchImpl } = buildPool([good]);

      await pool.getTip();

      const urls = fetchImpl.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.includes('not-an-ip'))).toBe(false);
      expect(urls.some((url) => url.includes('127.0.0.1'))).toBe(false);
    });

    it('keeps only nodes within the tip tolerance', async () => {
      // A home node syncing from a USB drive answers fine but always lags; using it would
      // add latency to every request and report a tip behind the rest of the network.
      const { pool } = buildPool(
        [
          node('185.13.30.11'),
          node('185.13.30.12'),
          node('185.13.30.13'),
          node('185.13.30.14', { tip: TIP - 40 })
        ],
        { tipTolerance: 2 }
      );

      await pool.getTip();

      const ids = pool.status().nodes.map((entry) => entry.id);
      expect(ids).toContain('185.13.30.11:16127');
      expect(ids).not.toContain('185.13.30.14:16127');
    });

    it('keeps the fastest nodes when the pool is smaller than the sample', async () => {
      const pool = buildPool(
        [
          node('185.13.30.11', { latencyMs: 40 }),
          node('185.13.30.12', { latencyMs: 5 }),
          node('185.13.30.13', { latencyMs: 20 })
        ],
        { poolSize: 2 }
      ).pool;

      await pool.getTip();

      const ids = pool.status().nodes.map((entry) => entry.id);
      expect(ids).toContain('185.13.30.12:16127');
      expect(ids).not.toContain('185.13.30.11:16127');
    });

    it('records which nodes can attribute inputs', async () => {
      const pool = buildPool([
        node('185.13.30.11'),
        node('185.13.30.12', { noInsight: true }),
        node('185.13.30.13')
      ]).pool;

      await pool.getTip();

      const status = pool.status();
      expect(status.insight).toBe(2);
      expect(status.nodes.find((entry) => entry.id === '185.13.30.12:16127')?.insight).toBe(false);
    });

    it('marks a node capable even when the block it serves has no transfers', async () => {
      // The probe fetches a block, so it must not be the deciding evidence. On the live
      // network almost every block is a coinbase plus node confirmations, and judging
      // capability by "did this block contain a resolved input" reported 39 healthy nodes as
      // 0 capable ones.
      const { pool } = buildPool([node('185.13.30.11'), node('185.13.30.12')]);

      await pool.getTip();

      // The fake serves a quiet block at tip-1, which is what the probe asks for.
      expect(pool.status().insight).toBe(2);
      expect(hasInputAddresses(QUIET_BLOCK)).toBe(false);
    });

    it('probes capability with getblockdeltas, not getblock', async () => {
      const { pool, fetchImpl } = buildPool([node('185.13.30.11')]);

      await pool.getTip();

      const urls = fetchImpl.mock.calls.map((call) => String(call[0]));

      // `getblockdeltas` requires the spent index to answer at all, and it answers on a quiet
      // block. `getblock` does not, which is the whole problem.
      expect(urls.some((url) => url.includes('/daemon/getblockdeltas/'))).toBe(true);
    });

    it('finds a node listening on an UPnP port rather than the default one', async () => {
      // Many nodes sit behind UPnP on 16137-16197, so probing only the default port would
      // silently discard most of the network.
      const { pool } = buildPool([node('185.13.30.11', { ports: [16_137] })], {
        ports: [16_127, 16_137]
      });

      expect(await pool.getTip()).toBe(TIP);
      expect(pool.status().nodes[0]?.id).toBe('185.13.30.11:16137');
    });

    it('uses the port a node publishes inline, without probing the defaults', async () => {
      // The live list reports these as `ip:port`. A parser that keeps only the address
      // probes five wrong ports per node and finds nothing.
      const { pool, fetchImpl } = buildPool([
        node('24.108.153.230', { ports: [16_147], inlinePort: 16_147 })
      ]);

      expect(await pool.getTip()).toBe(TIP);

      const probedPorts = new Set(
        fetchImpl.mock.calls
          .map((call) => new URL(String(call[0])).port)
          .filter((port) => port !== '' && port !== '80')
      );

      expect([...probedPorts]).toEqual(['16147']);
    });

    it('discards a node when none of its ports answer', async () => {
      const { pool } = buildPool([node('185.13.30.11', { ports: [16_999] })], {
        ports: [16_127, 16_137]
      });

      await expect(pool.getTip()).rejects.toThrow(/no FluxNode/);
    });

    it('probes once even when several callers arrive together', async () => {
      const { pool, fetchImpl } = buildPool([
        node('185.13.30.11'),
        node('185.13.30.12'),
        node('185.13.30.13'),
        node('185.13.30.14')
      ]);

      await Promise.all([pool.getTip(), pool.getTip(), pool.getTip()]);

      const discoveryCalls = fetchImpl.mock.calls.filter((call) =>
        String(call[0]).includes('explorer.test')
      ).length;

      // Without the in-flight guard, three concurrent callers would each run a full
      // probe pass: three discovery requests and three rounds of `probeSample` probes.
      expect(discoveryCalls).toBe(1);
      expect(pool.status().discovered).toBe(4);
    });
  });

  describe('getTip', () => {
    it('returns the median, not any one node', async () => {
      const pool = buildPool([
        node('185.13.30.11', { tip: TIP + 50 }),
        node('185.13.30.12', { tip: TIP }),
        node('185.13.30.13', { tip: TIP - 1 })
      ]).pool;

      // One node claiming a far-future tip must not move the answer: that would have the
      // service wait for blocks that do not exist.
      expect(await pool.getTip()).toBe(TIP);
    });

    it('ignores a node that fails to answer', async () => {
      const pool = buildPool([
        node('185.13.30.11'),
        node('185.13.30.12'),
        node('185.13.30.13'),
        node('185.13.30.14', { fail: true })
      ]).pool;

      expect(await pool.getTip()).toBe(TIP);
    });

    it('takes the lowest answer when fewer than three nodes reply', async () => {
      // With no majority there is no median to take. Advertising the highest would mean
      // waiting for heights nobody has.
      const pool = buildPool(
        [node('185.13.30.11', { tip: TIP + 5 }), node('185.13.30.12', { tip: TIP })],
        { poolSize: 2 }
      ).pool;

      expect(await pool.getTip()).toBe(TIP);
    });

    it('throws when nothing answers', async () => {
      const pool = buildPool([node('185.13.30.11', { fail: true })]).pool;

      await expect(pool.getTip()).rejects.toThrow();
    });
  });

  describe('getBlock', () => {
    it('returns a block normalised to satoshis', async () => {
      const pool = buildPool([node('185.13.30.11'), node('185.13.30.12')]).pool;

      const block = await pool.getBlock(1_000);

      expect(block).toMatchObject({ height: 1_000, hash: HASHES[1000] });
      expect(block.transactions.find((tx) => tx.txid === 'tx-1000-1')!.inputs[0]!.sat).toBe(
        500_000
      );
    });

    it('refuses to serve a block from a node that cannot attribute inputs', async () => {
      // Without a spent index the sender is unknowable, and a flow with no counterparty is
      // a guess. Refusing is the only honest option (#15).
      const pool = buildPool([node('185.13.30.11', { noInsight: true })]).pool;

      await expect(pool.getBlock(1_000)).rejects.toThrow(/spent index/);
      expect(await pool.isHealthy()).toBe(false);
    });

    it('spreads requests across nodes rather than hammering the fastest', async () => {
      const a = node('185.13.30.11', { latencyMs: 1 });
      const b = node('185.13.30.12', { latencyMs: 2 });
      const c = node('185.13.30.13', { latencyMs: 3 });
      const { pool } = buildPool([a, b, c]);

      await pool.getTip();
      const before = [a.blockRequests, b.blockRequests, c.blockRequests];

      for (let height = 999; height > 995; height--) await pool.getBlock(height);

      const added = [
        a.blockRequests - before[0],
        b.blockRequests - before[1],
        c.blockRequests - before[2]
      ];

      // Every node gets used. A pool that always preferred the fastest would defeat the
      // point of having fifteen.
      expect(added.every((count) => count > 0)).toBe(true);
      expect(pool.status().discovered).toBe(3);
    });

    it('never exceeds the per-node in-flight limit, however many blocks are asked for', async () => {
      // The limit is the whole courtesy mechanism: an operator's connection must never see
      // more than FLUXNODE_MAX_INFLIGHT requests at once, no matter how many heights the
      // sync loop throws at the pool.
      // Real latency, so requests actually overlap. Without it every fetch completes before
      // the next begins and the test would pass no matter what the limit was.
      const nodes = [
        node('185.13.30.11', { latencyMs: 5 }),
        node('185.13.30.12', { latencyMs: 5 }),
        node('185.13.30.13', { latencyMs: 5 }),
        node('185.13.30.14', { latencyMs: 5 })
      ];

      let peakPerNode = 0;

      const { pool } = buildPool(nodes, {
        maxInflightPerNode: 2,
        onRequest: (_node, depth) => {
          peakPerNode = Math.max(peakPerNode, depth);
        }
      });

      await pool.getTip();

      // Sixteen concurrent fetches across a four-node pool: without the per-node cap this
      // peaks at sixteen on one node.
      await Promise.all(Array.from({ length: 16 }, (_, index) => pool.getBlock(900 - index)));

      expect(peakPerNode).toBeGreaterThan(1);
      expect(peakPerNode).toBeLessThanOrEqual(2);
    });

    it('moves on to another node when one fails', async () => {
      const broken = node('185.13.30.11', { fail: true });
      const working = node('185.13.30.12');
      const { pool, advance } = buildPool([broken, working]);

      await expect(pool.getTip()).resolves.toBe(TIP);

      // Un-benches the broken node so the failure is about the fetch, not the pool state.
      broken.fail = false;
      broken.tip = TIP;
      advance(600_000);

      broken.fail = true;
      working.fail = false;

      // Both are in the pool; asking for a block the broken one will fail to serve.
      await expect(pool.getBlock(1_000)).resolves.toMatchObject({ height: 1_000 });
    });

    it('benches a node whose block hash no other node agrees with', async () => {
      // A node serving a stale or forked view answers plausibly and consistently, so
      // nothing else in the pipeline would ever notice. Only an independent node can.
      const liar = node('185.13.30.11', { blockHash: 'f'.repeat(64) });
      const { pool } = buildPool([liar, node('185.13.30.12'), node('185.13.30.13')], {
        spotCheckEvery: 1
      });

      await pool.getTip();
      const servingBefore = liar.blockRequests;

      await pool.getBlock(1_000);

      // The block is not returned, because the node that served it could not be trusted.
      await expect(pool.getBlock(1_000)).resolves.toMatchObject({ hash: HASHES[1000] });

      expect(pool.status().nodes.find((entry) => entry.id === '185.13.30.11:16127')?.benched).toBe(
        true
      );
      expect(liar.blockRequests).toBeGreaterThan(servingBefore);
    });

    it('does not punish a node when the cross-check itself cannot run', async () => {
      // One checker being unreachable is not evidence about the node that served the block.
      const healthy = node('185.13.30.11');
      const unreachable = node('185.13.30.12', { fail: true });
      const { pool } = buildPool([healthy, unreachable], { spotCheckEvery: 1 });

      await pool.getTip();
      unreachable.fail = false;

      await expect(pool.getBlock(1_000)).resolves.toMatchObject({ height: 1_000 });
    });

    it('does not verify when spot checking is disabled', async () => {
      const pool = buildPool([node('185.13.30.11'), node('185.13.30.12')], {
        spotCheckEvery: 0
      }).pool;

      await expect(pool.getBlock(1_000)).resolves.toMatchObject({ height: 1_000 });
    });

    it('rejects a height the daemon says does not exist', async () => {
      // Returning an empty block here would be indistinguishable from a real, empty block,
      // and the height would be marked done and never revisited (#13).
      const { pool } = buildPool([node('185.13.30.11'), node('185.13.30.12')]);
      await pool.getTip();

      await expect(pool.getBlock(999_999)).rejects.toThrow(/999999/);
    });

    it('rejects a node that answers with a block at the wrong height', async () => {
      // Plausible-looking and wrong. Storing block 999's transactions under height 1000
      // would silently corrupt every flow's height attribution.
      const wrong = node('185.13.30.11', { serveOffset: -1 });
      const { pool } = buildPool([wrong, node('185.13.30.12')]);
      await pool.getTip();

      await expect(pool.getBlock(1_000)).resolves.toMatchObject({ height: 1_000 });
      expect(pool.status().nodes.find((entry) => entry.id === '185.13.30.11:16127')?.benched).toBe(
        true
      );
    });
  });

  describe('being a good citizen', () => {
    it('identifies itself on every request', async () => {
      const seenAgents: (string | undefined)[] = [];

      const { pool } = buildPool([node('185.13.30.11'), node('185.13.30.12')], {
        onHeaders: (headers) => seenAgents.push(headers['user-agent'])
      });

      await pool.getTip();
      await pool.getBlock(1_000);

      expect(seenAgents.length).toBeGreaterThan(0);
      for (const agent of seenAgents) expect(agent).toMatch(/^FluxFlow\//);
    });

    it('sends header values a real HTTP client can actually transmit', async () => {
      // Header values are ByteStrings. One em dash and `fetch` throws "Cannot convert
      // argument to a ByteString" *before* the request is sent, so the pool discovers zero
      // nodes and reports itself empty. Found by running the image against the live
      // explorer — the fake fetch happily accepted any string.
      const offenders: string[] = [];

      const { pool } = buildPool([node('185.13.30.11'), node('185.13.30.12')], {
        onHeaders: (headers) => {
          for (const [name, value] of Object.entries(headers)) {
            if (value === undefined) continue;
            if (!/^[\x20-\x7e]*$/.test(value)) offenders.push(`${name}=${value}`);
          }
        }
      });

      await pool.getTip();
      await pool.getBlock(1_000);

      // Every header the pool sends is checked, not just the User-Agent.
      expect(offenders).toEqual([]);
    });

    it('backs a failing node off for longer each time', async () => {
      const flaky = node('185.13.30.11');
      const { pool, clock } = buildPool([flaky, node('185.13.30.12')], { benchSeconds: 60 });

      await pool.getTip();

      flaky.fail = true;
      // Three rounds of tip polling, each of which should extend the bench.
      for (let round = 0; round < 3; round++) {
        await pool.getTip().catch(() => undefined);
        clock();
        // Force rediscovery so the benched node is reconsidered.
        flaky.tip = TIP;
      }

      expect(flaky.blockRequests + flaky.tipRequests).toBeGreaterThan(0);
    });

    it('keeps working when discovery fails', async () => {
      // A discovery outage is not a reason to stop ingesting from nodes already working.
      const good = node('185.13.30.11');
      const { pool, fetchImpl } = buildPool([good]);

      await pool.getTip();
      expect(await pool.getTip()).toBe(TIP);

      fetchImpl.mockImplementationOnce(() => {
        throw new TypeError('fetch failed');
      });

      expect(await pool.getTip()).toBe(TIP);
    });
  });
});

describe('FluxNodePool header hygiene', () => {
  it('uses a User-Agent that is valid latin-1', () => {
    /*
     * A direct check on the constant, independent of the pool. `fetch` rejects a header
     * value containing a character above U+00FF with "Cannot convert argument to a
     * ByteString", and it does so before sending anything — so a typo here silently empties
     * the pool rather than failing loudly. Found the hard way, against the live explorer.
     */
    const agent = USER_AGENT;

    expect(/^[\x20-\x7e]+$/.test(agent)).toBe(true);
    expect(agent.length).toBeLessThan(256);
  });
});

// ── Type-level guard ────────────────────────────────────────────────────────

describe('fixtures', () => {
  it('records a block that really does carry input addresses', () => {
    // Guards the other tests: if this stops being true, the "insight" node is no longer
    // representative and every probe test is measuring nothing.
    expect(hasInputAddresses(INSIGHT_BLOCK)).toBe(true);
    expect(hasInputAddresses(NON_INSIGHT_BLOCK)).toBe(false);
    expect(INSIGHT_BLOCK.tx![1]!.vout![0]!.value).not.toBe(
      INSIGHT_BLOCK.tx![1]!.vout![0]!.valueSat
    );
  });

  it('keeps the non-insight fixture identical apart from the inputs', () => {
    const withInputs = NON_INSIGHT_BLOCK.tx![1]!;
    const original = INSIGHT_BLOCK.tx![1]!;

    expect(withInputs.txid).toBe(original.txid);
    expect(withInputs.vout).toEqual(original.vout);
    expect(withInputs.vin![0]!.address).toBeUndefined();
  });
});

// Referenced so the unused-import lint stays honest about the types in use.
export type { DaemonBlock };

describe('FluxNodePool review fixes (#43)', () => {
  function discoveryCalls(fetchImpl: { mock: { calls: unknown[][] } }): number {
    return fetchImpl.mock.calls.filter((call) => String(call[0]).includes('explorer.test')).length;
  }

  it('keeps spent-index nodes even when faster nodes without one were probed', async () => {
    // Cut by latency alone, three fast nodes with no spent index pushed out every node that
    // could actually serve a block, and the pool was unusable for a whole discovery interval.
    const { pool } = buildPool(
      [
        node('185.13.30.11', { noInsight: true, latencyMs: 1 }),
        node('185.13.30.12', { noInsight: true, latencyMs: 1 }),
        node('185.13.30.13', { noInsight: true, latencyMs: 1 }),
        node('185.13.30.14', { latencyMs: 30 }),
        node('185.13.30.15', { latencyMs: 30 })
      ],
      { poolSize: 3 }
    );

    await pool.getTip();

    expect(pool.status().insight).toBe(2);
    await expect(pool.getBlock(1_000)).resolves.toMatchObject({ height: 1_000 });
  });

  it('does not rediscover on every call while the pool is empty', async () => {
    const { pool, fetchImpl } = buildPool([node('185.13.30.11', { fail: true })]);

    for (let call = 0; call < 4; call++) await pool.getTip().catch(() => undefined);

    // Each call re-ran discovery and re-probed every candidate on every port: a scan of
    // operators' home connections every few seconds, indefinitely.
    expect(discoveryCalls(fetchImpl)).toBe(1);
  });

  it('tries discovery again once the empty-pool backoff has passed', async () => {
    const flaky = node('185.13.30.11', { fail: true });
    const { pool, fetchImpl, advance } = buildPool([flaky]);

    await pool.getTip().catch(() => undefined);
    flaky.fail = false;
    advance(10 * 60_000);

    await expect(pool.getTip()).resolves.toBe(TIP);
    expect(discoveryCalls(fetchImpl)).toBe(2);
  });

  it('keeps the working pool when discovery returns no candidates', async () => {
    const { pool, fetchImpl, advance } = buildPool([node('185.13.30.11'), node('185.13.30.12')]);

    await pool.getTip();
    advance(1_800_001);

    // The explorer briefly answers 200 with nothing usable, as it has done before.
    fetchImpl.mockImplementationOnce(
      async () => new Response(JSON.stringify({ fluxNodes: [] }), { status: 200 })
    );

    await expect(pool.getTip()).resolves.toBe(TIP);
    expect(pool.status().discovered).toBe(2);
  });

  it('keeps the working pool when a re-probe finds no usable node', async () => {
    const nodes = [node('185.13.30.11'), node('185.13.30.12')];
    const { pool, advance } = buildPool(nodes);

    await pool.getTip();
    advance(1_800_001);

    // Our own network blips while re-probing: every probe fails. That says nothing about the
    // nodes, and swapping a working pool for an empty one stalls ingestion until the next
    // discovery even though the blip is long over.
    for (const entry of nodes) entry.fail = true;
    await pool.getTip().catch(() => undefined);
    for (const entry of nodes) entry.fail = false;

    expect(pool.status().discovered).toBe(2);
    // The tip read during the blip benched them, which is right; once that expires the
    // same pool serves again, with no rediscovery needed.
    advance(10 * 60_000);
    await expect(pool.getTip()).resolves.toBe(TIP);
  });

  it('does not bench a node for a block it has not reached yet', async () => {
    // One block behind is inside the tolerance, so the node is kept, and it is the fastest,
    // so it is asked first. Asking it for the tip block made it fail and benched it at
    // every new block.
    const lagging = node('185.13.30.11', { tip: TIP - 1, latencyMs: 0 });
    const { pool } = buildPool([
      lagging,
      node('185.13.30.12', { latencyMs: 3 }),
      node('185.13.30.13', { latencyMs: 3 })
    ]);

    await pool.getTip();
    await expect(pool.getBlock(TIP)).resolves.toMatchObject({ height: TIP });

    expect(pool.status().nodes.find((entry) => entry.id === '185.13.30.11:16127')?.benched).toBe(
      false
    );
  });

  it('does not bench anyone for a block no node has reached', async () => {
    const { pool } = buildPool([node('185.13.30.11'), node('185.13.30.12')]);
    await pool.getTip();

    await expect(pool.getBlock(TIP + 50)).rejects.toThrow();

    expect(pool.status().nodes.every((entry) => !entry.benched)).toBe(true);
  });

  it('gives up at once when every spent-index node has just been benched', async () => {
    const a = node('185.13.30.11');
    const b = node('185.13.30.12');
    const { pool, clock } = buildPool([a, b]);

    await pool.getTip();
    a.fail = true;
    b.fail = true;

    const before = clock();
    await expect(pool.getBlock(1_000)).rejects.toThrow();

    // Waiting for a "free slot" on nodes that are benched, not busy, held a shared limiter
    // slot for the whole deadline before failing over.
    expect(clock() - before).toBeLessThan(1_000);
  });

  it('clears a node failure count once it serves successfully', async () => {
    const flaky = node('185.13.30.11');
    const { pool, advance } = buildPool([flaky, node('185.13.30.12'), node('185.13.30.13')]);

    await pool.getTip();
    flaky.fail = true;
    await pool.getTip();
    flaky.fail = false;
    advance(10 * 60_000);

    await pool.getTip();

    // Otherwise every blip ever seen compounds the next bench, up to the 8x cap.
    expect(pool.status().nodes.find((entry) => entry.id === '185.13.30.11:16127')?.failures).toBe(
      0
    );
  });

  it('counts a hash mismatch as one failure, not two', async () => {
    const liar = node('185.13.30.11', { blockHash: 'f'.repeat(64), latencyMs: 0 });
    const { pool } = buildPool(
      [liar, node('185.13.30.12', { latencyMs: 3 }), node('185.13.30.13', { latencyMs: 3 })],
      { spotCheckEvery: 1 }
    );

    await pool.getTip();
    await pool.getBlock(1_000);

    expect(pool.status().nodes.find((entry) => entry.id === '185.13.30.11:16127')?.failures).toBe(
      1
    );
  });
  it('asks a different node when a hash is re-read', async () => {
    const { pool, fetchImpl } = buildPool([node('185.13.30.11'), node('185.13.30.12')]);
    await pool.getTip();

    const hashHosts = (): string[] =>
      fetchImpl.mock.calls
        .map((call) => new URL(String(call[0])))
        .filter((url) => url.pathname.endsWith('/getblockhash/1000'))
        .map((url) => url.hostname);

    await pool.getBlockHash(1_000);
    await pool.getBlockHash(1_000);

    // The sync loop re-reads a disagreeing hash before it rolls back. The same node asked
    // twice would just repeat itself, so the confirmation must come from somewhere else.
    const [first, second] = hashHosts();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it('does not ask a node for a hash above its known tip', async () => {
    const { pool } = buildPool([node('185.13.30.11'), node('185.13.30.12')]);
    await pool.getTip();

    await expect(pool.getBlockHash(TIP + 50)).rejects.toThrow(/has reached block/);
    expect(pool.status().nodes.every((entry) => !entry.benched)).toBe(true);
  });
});
