import { describe, expect, it, vi } from 'vitest';
import { OwnNodeDataSource } from './ownnode.js';
import { BLOCK_DELTAS, DISABLED_ERROR, INSIGHT_BLOCK } from './daemon.fixtures.js';

const BASE = 'http://192.168.40.155:16127';
const TIP = INSIGHT_BLOCK.height;

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ status: 'success', data }), { status: 200 });
}

function node(options: { spentIndex?: boolean; wrongHeight?: boolean } = {}) {
  const fetchImpl = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;

    if (path === '/daemon/getblockcount') return envelope(TIP);
    if (path.startsWith('/daemon/getblockhash/')) return envelope(INSIGHT_BLOCK.hash);
    if (path.startsWith('/daemon/getblockdeltas/')) {
      return options.spentIndex === false
        ? new Response(JSON.stringify(DISABLED_ERROR), { status: 200 })
        : envelope(BLOCK_DELTAS);
    }
    if (path.startsWith('/daemon/getblock/')) {
      return envelope({
        ...INSIGHT_BLOCK,
        height: options.wrongHeight ? TIP - 1 : INSIGHT_BLOCK.height
      });
    }

    return new Response('not found', { status: 404 });
  });

  const source = new OwnNodeDataSource({
    baseUrl: BASE,
    http: { fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0, timeoutMs: 1_000 }
  });

  return { source, fetchImpl };
}

describe('OwnNodeDataSource', () => {
  it('reads the tip and whole blocks from a LAN address', async () => {
    const { source, fetchImpl } = node();

    await expect(source.getTip()).resolves.toBe(TIP);
    const block = await source.getBlock(TIP);

    expect(block.height).toBe(TIP);
    expect(block.hash).toBe(INSIGHT_BLOCK.hash);
    // The private address the pool would refuse is used as configured.
    expect(fetchImpl.mock.calls.every(([url]) => String(url).startsWith(BASE))).toBe(true);
  });

  it('serves a cheap hash for reorg checks', async () => {
    await expect(node().source.getBlockHash(TIP)).resolves.toBe(INSIGHT_BLOCK.hash);
  });

  it('is healthy only with a spent index, so failover moves to the pool otherwise', async () => {
    await expect(node().source.isHealthy()).resolves.toBe(true);
    await expect(node({ spentIndex: false }).source.isHealthy()).resolves.toBe(false);
  });

  it('refuses to serve blocks without a spent index', async () => {
    await expect(node({ spentIndex: false }).source.getBlock(TIP)).rejects.toThrow(/spent index/);
  });

  it('rejects a block for the wrong height', async () => {
    await expect(node({ wrongHeight: true }).source.getBlock(TIP)).rejects.toThrow(/asked/);
  });

  it('probes the spent index once, not on every block', async () => {
    const { source, fetchImpl } = node();

    await source.getBlock(TIP);
    await source.getBlock(TIP);

    const probes = fetchImpl.mock.calls.filter(([url]) => String(url).includes('getblockdeltas'));
    expect(probes).toHaveLength(1);
  });
});
