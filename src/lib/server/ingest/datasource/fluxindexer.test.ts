import { describe, expect, it, vi } from 'vitest';
import { createLimiter, type HttpRequestOptions } from '../../http.js';
import { FluxIndexerDataSource } from './fluxindexer';
import { checkConservation } from './types';

/**
 * A trimmed but structurally faithful FluxIndexer block response.
 *
 * Note the shape that broke v1: the block lists transaction **ids** in `tx` and summaries
 * in `txDetails`, but no `vin`/`vout` — so each transfer needs a second request. It also
 * shows three of the address shapes that appear in practice: `addresses` on the input,
 * `scriptPubKey.addresses` on the output, and a bare `address`.
 */
const BLOCK_FIXTURE = {
  height: 987_654,
  hash: '000000abc',
  previousblockhash: '000000abb',
  time: 1_756_100_000,
  size: 3_120,
  txCount: 4,
  tx: ['tx-transfer-1', 'tx-transfer-2', 'tx-coinbase', 'tx-confirm'],
  txDetails: [
    { txid: 'tx-transfer-1', kind: 'transfer' },
    { txid: 'tx-transfer-2', kind: 'transfer' },
    { txid: 'tx-coinbase', kind: 'coinbase' },
    { txid: 'tx-confirm', kind: 'fluxnode_confirm' }
  ]
};

const TRANSFER_FIXTURES: Record<string, unknown> = {
  'tx-transfer-1': {
    txid: 'tx-transfer-1',
    vin: [{ addresses: ['t1bLYKTWBMUSAhrU2ezDEzC2BXYbafz5L9e'], valueSat: 1_000_000_000 }],
    vout: [
      {
        valueSat: 999_990_000,
        scriptPubKey: { addresses: ['t1YvimnGBmVA7xDiPnqwbKsvujmSJz4X5m2'], hex: '76a9' }
      }
    ]
  },
  'tx-transfer-2': {
    txid: 'tx-transfer-2',
    inputs: [{ address: 't1wallet', value: 250_000_000 }],
    outputs: [
      { address: 't1g7QCktktwReoHgwWtAgNBVvzzboQVZy19', value: 249_000_000 },
      { address: undefined, value: 1_000_000 }
    ]
  }
};

interface StubOptions {
  /** Serve this instead of the default block fixture. */
  block?: unknown;
  /** Merge these per-txid responses over the defaults. */
  transactions?: Record<string, unknown>;
  /** Serve no transaction at all, so every enrichment 404s. */
  noTransactions?: boolean;
  /** Status code for block requests. */
  blockStatus?: number;
}

function stubFetch(options: StubOptions = {}) {
  const calls: string[] = [];
  const transactions = options.noTransactions
    ? {}
    : { ...TRANSFER_FIXTURES, ...options.transactions };

  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);

    if (url.includes('/api/v1/blocks/')) {
      if (options.blockStatus && options.blockStatus !== 200) {
        return new Response('indexer down', { status: options.blockStatus });
      }
      return new Response(JSON.stringify(options.block ?? BLOCK_FIXTURE), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    if (url.includes('/api/v1/transactions/')) {
      const txid = url.split('/api/v1/transactions/')[1]!;
      const body = transactions[txid];
      if (body === undefined) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    if (url.includes('/api/v1/status')) {
      return new Response(JSON.stringify({ indexer: { currentHeight: 3_002_560 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });

  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function http(overrides: Partial<HttpRequestOptions> = {}): Partial<HttpRequestOptions> {
  return { sleep: async () => {}, retries: 0, timeoutMs: 1_000, ...overrides };
}

function source(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new FluxIndexerDataSource({
    baseUrl: 'http://indexer.local:42067',
    http: http({ fetchImpl }),
    ...overrides
  });
}

describe('FluxIndexerDataSource', () => {
  describe('getTip', () => {
    it('reads indexer.currentHeight', async () => {
      const { fetchImpl } = stubFetch();

      await expect(source(fetchImpl).getTip()).resolves.toBe(3_002_560);
    });

    it('falls back to daemon.blocks', async () => {
      const dataSource = new FluxIndexerDataSource({
        baseUrl: 'http://indexer.local:42067',
        http: http({
          fetchImpl: (async () =>
            new Response(JSON.stringify({ daemon: { blocks: 42 } }), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })) as unknown as typeof fetch
        })
      });

      await expect(dataSource.getTip()).resolves.toBe(42);
    });

    it('fails loudly when no height can be determined', async () => {
      const dataSource = new FluxIndexerDataSource({
        baseUrl: 'http://indexer.local:42067',
        http: http({
          fetchImpl: (async () =>
            new Response(JSON.stringify({ unexpected: true }), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })) as unknown as typeof fetch
        })
      });

      await expect(dataSource.getTip()).rejects.toThrow(/could not determine chain height/);
    });
  });

  describe('getBlock', () => {
    it('normalises the block header', async () => {
      const { fetchImpl } = stubFetch();

      const block = await source(fetchImpl).getBlock(987_654);

      expect(block).toMatchObject({
        height: 987_654,
        hash: '000000abc',
        prevHash: '000000abb',
        time: 1_756_100_000,
        txCount: 4
      });
    });

    it('enriches only transfer transactions, skipping coinbase and node confirms', async () => {
      const { fetchImpl, calls } = stubFetch();

      await source(fetchImpl).getBlock(987_654);

      const txCalls = calls.filter((url) => url.includes('/api/v1/transactions/'));
      expect(txCalls).toHaveLength(2);
      expect(txCalls.some((url) => url.includes('tx-coinbase'))).toBe(false);
      expect(txCalls.some((url) => url.includes('tx-confirm'))).toBe(false);
    });

    it('fetches every transfer, with no TRANSACTION_FETCH_LIMIT truncation', async () => {
      // #15: the indexer path capped enrichment at 50 transactions per block and silently
      // dropped the rest. Build a block with 60 transfers and prove all 60 arrive.
      const many = Array.from({ length: 60 }, (_, index) => `tx-${index}`);
      const { fetchImpl } = stubFetch({
        block: {
          ...BLOCK_FIXTURE,
          tx: many,
          txDetails: many.map((txid) => ({ txid, kind: 'transfer' }))
        },
        transactions: Object.fromEntries(
          many.map((txid) => [
            txid,
            {
              txid,
              vin: [{ addresses: ['t1exchange'], valueSat: 1_000_000 }],
              vout: [{ valueSat: 999_000, scriptPubKey: { addresses: ['t1wallet'] } }]
            }
          ])
        )
      });

      const block = await source(fetchImpl).getBlock(987_654);

      expect(block.transactions).toHaveLength(60);
      expect(block.transactions.every((tx) => tx.complete)).toBe(true);
    });

    it('refuses an implausibly large block rather than silently truncating it', async () => {
      const many = Array.from({ length: 10 }, (_, index) => `tx-${index}`);
      const { fetchImpl } = stubFetch({
        block: {
          ...BLOCK_FIXTURE,
          tx: many,
          txDetails: many.map((txid) => ({ txid, kind: 'transfer' }))
        }
      });

      const dataSource = source(fetchImpl, { maxTransactionsPerBlock: 5 });

      await expect(dataSource.getBlock(987_654)).rejects.toThrow(/above the 5 cap/);
    });

    it('reads addresses from all three shapes the indexer emits', async () => {
      const { fetchImpl } = stubFetch();

      const block = await source(fetchImpl).getBlock(987_654);
      const [first, second] = block.transactions;

      // vin[].addresses
      expect(first!.inputs[0]!.address).toBe('t1bLYKTWBMUSAhrU2ezDEzC2BXYbafz5L9e');
      // vout[].scriptPubKey.addresses
      expect(first!.outputs[0]!.address).toBe('t1YvimnGBmVA7xDiPnqwbKsvujmSJz4X5m2');
      // inputs[].address and outputs[].address
      expect(second!.inputs[0]!.address).toBe('t1wallet');
      expect(second!.outputs[0]!.address).toBe('t1g7QCktktwReoHgwWtAgNBVvzzboQVZy19');
    });

    it('keeps values as satoshis', async () => {
      const { fetchImpl } = stubFetch();

      const block = await source(fetchImpl).getBlock(987_654);

      expect(block.transactions[0]!.inputs[0]!.sat).toBe(1_000_000_000);
      expect(block.transactions[0]!.outputs[0]!.sat).toBe(999_990_000);
      expect(checkConservation(block.transactions[0]!)).toBeNull();
    });

    it('marks an output with no resolvable address as nulldata', async () => {
      const { fetchImpl } = stubFetch();

      const block = await source(fetchImpl).getBlock(987_654);

      expect(block.transactions[1]!.outputs[1]).toMatchObject({ address: null, nulldata: true });
    });

    it('preserves the output index', async () => {
      const { fetchImpl } = stubFetch();

      const block = await source(fetchImpl).getBlock(987_654);

      expect(block.transactions[1]!.outputs.map((output) => output.n)).toEqual([0, 1]);
    });

    it('marks a transfer the indexer could not detail as incomplete', async () => {
      const { fetchImpl } = stubFetch({
        transactions: {
          'tx-transfer-1': { txid: 'tx-transfer-1', vin: [], vout: [] },
          'tx-transfer-2': TRANSFER_FIXTURES['tx-transfer-2']
        }
      });

      const block = await source(fetchImpl).getBlock(987_654);
      const incomplete = block.transactions.filter((tx) => !tx.complete);

      // The pipeline must treat an incomplete block as failed and retry it, not write
      // half a block and move on (#14).
      expect(incomplete).toHaveLength(1);
      expect(incomplete[0]!.txid).toBe('tx-transfer-1');
    });

    it('does not let one failed enrichment lose the rest of the block', async () => {
      const { fetchImpl } = stubFetch({ noTransactions: true });

      const block = await source(fetchImpl).getBlock(987_654);

      expect(block.transactions).toHaveLength(2);
      expect(block.transactions.every((tx) => !tx.complete)).toBe(true);
    });

    it('reads transaction ids given as objects', async () => {
      const { fetchImpl } = stubFetch({
        block: {
          ...BLOCK_FIXTURE,
          tx: [{ txid: 'tx-transfer-1' }, { txid: 'tx-transfer-2' }],
          txDetails: [
            { txid: 'tx-transfer-1', kind: 'transfer' },
            { txid: 'tx-transfer-2', kind: 'transfer' }
          ]
        }
      });

      const block = await source(fetchImpl).getBlock(987_654);

      expect(block.transactions).toHaveLength(2);
    });

    it('enriches nothing when the block has no txDetails', async () => {
      const { fetchImpl, calls } = stubFetch({
        block: { ...BLOCK_FIXTURE, txDetails: undefined }
      });

      const block = await source(fetchImpl).getBlock(987_654);

      expect(block.transactions).toHaveLength(0);
      expect(calls.filter((url) => url.includes('/transactions/'))).toHaveLength(0);
    });

    it('surfaces a block fetch failure so the height is recorded as missing', async () => {
      const { fetchImpl } = stubFetch({ blockStatus: 503 });

      await expect(source(fetchImpl).getBlock(1)).rejects.toMatchObject({ status: 503 });
    });
  });

  describe('concurrency', () => {
    it('bounds in-flight enrichment requests with the shared limiter', async () => {
      const count = 20;
      const ids = Array.from({ length: count }, (_, index) => `tx-${index}`);

      let inFlight = 0;
      let peak = 0;

      const { fetchImpl } = stubFetch({
        block: {
          ...BLOCK_FIXTURE,
          tx: ids,
          txDetails: ids.map((txid) => ({ txid, kind: 'transfer' }))
        }
      });

      const countingFetch = vi.fn(async (url: string) => {
        if (url.includes('/api/v1/transactions/')) {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 2));
          inFlight--;
          return new Response(
            JSON.stringify({
              txid: url.split('/').pop(),
              vin: [{ addresses: ['t1a'], valueSat: 1 }],
              vout: [{ valueSat: 1, scriptPubKey: { addresses: ['t1b'] } }]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            ...BLOCK_FIXTURE,
            tx: ids,
            txDetails: ids.map((txid) => ({ txid, kind: 'transfer' }))
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      });

      const dataSource = new FluxIndexerDataSource({
        baseUrl: 'http://indexer.local:42067',
        http: http({ fetchImpl: countingFetch as unknown as typeof fetch }),
        limiter: createLimiter(4)
      });

      const block = await dataSource.getBlock(987_654);

      expect(block.transactions).toHaveLength(count);
      expect(peak).toBeLessThanOrEqual(4);
      expect(fetchImpl).toBeDefined();
    });
  });

  describe('isHealthy', () => {
    it('is true when the health endpoint answers 2xx', async () => {
      const fetchImpl = (async () =>
        new Response('{}', { status: 200 })) as unknown as typeof fetch;

      await expect(source(fetchImpl).isHealthy()).resolves.toBe(true);
    });

    it('is false, not throwing, when the indexer is down', async () => {
      const fetchImpl = (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;

      await expect(source(fetchImpl).isHealthy()).resolves.toBe(false);
    });

    it('is false on a 5xx health response', async () => {
      const fetchImpl = (async () =>
        new Response('{}', { status: 503 })) as unknown as typeof fetch;

      await expect(source(fetchImpl).isHealthy()).resolves.toBe(false);
    });
  });
});
