import { describe, expect, it, vi } from 'vitest';
import { HttpError, type HttpRequestOptions } from '../../http.js';
import { BlockbookDataSource } from './blockbook';
import { checkConservation } from './types';

/**
 * A trimmed-down but structurally faithful Blockbook `/api/v2/block/{height}` response.
 *
 * Values are in satoshis, as blockbook documents for FLUX. The transaction spends two
 * outputs of one exchange address, pays a wallet and an OP_RETURN, and keeps a fee.
 */
const BLOCK_FIXTURE = {
  page: 1,
  totalPages: 1,
  itemsOnPage: 2,
  hash: '0000008a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6',
  previousBlockHash: '00000079f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccdde',
  height: 1_234_567,
  confirmations: 3,
  size: 412,
  time: 1_756_000_000,
  version: 2_000_000,
  merkleRoot: 'aa',
  nonce: 'bb',
  bits: '1d00ffff',
  difficulty: 1,
  txCount: 2,
  txs: [
    {
      txid: 'aa11',
      vin: [
        {
          addresses: ['t1bLYKTWBMUSAhrU2ezDEzC2BXYbafz5L9e'],
          value: '600000000',
          vout: { n: 0 },
          isAddress: true
        },
        {
          addresses: ['t1bLYKTWBMUSAhrU2ezDEzC2BXYbafz5L9e'],
          value: '400000000',
          vout: { n: 1 },
          isAddress: true
        }
      ],
      vout: [
        {
          value: '999990000',
          n: 0,
          addresses: ['t1YvimnGBmVA7xDiPnqwbKsvujmSJz4X5m2'],
          isAddress: true,
          spentTxid: 'unused',
          hex: '76a9140000'
        },
        {
          value: '10000',
          n: 1,
          addresses: [],
          isAddress: false,
          hex: ''
        }
      ],
      blocktime: 1_756_000_000,
      blockheight: 1_234_567,
      confirmations: 3
    },
    {
      txid: 'bb22',
      vin: [{ coinbase: 'aa11', value: '5000000000' }],
      vout: [{ value: '5000000000', n: 0, addresses: ['t1miner'], isAddress: true, hex: '00' }],
      blocktime: 1_756_000_000,
      blockheight: 1_234_567,
      confirmations: 3
    }
  ]
};

function stubFetch(responses: { status?: number; body?: unknown; headers?: HeadersInit }[]) {
  const calls: string[] = [];
  let index = 0;

  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    const response = responses[Math.min(index, responses.length - 1)];
    index++;
    return new Response(JSON.stringify(response?.body ?? {}), {
      status: response?.status ?? 200,
      headers: { 'content-type': 'application/json', ...response?.headers }
    });
  });

  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function noSleepOptions(overrides: Partial<HttpRequestOptions> = {}): Partial<HttpRequestOptions> {
  return { sleep: async () => {}, retries: 0, timeoutMs: 1_000, ...overrides };
}

function source(fetchImpl: typeof fetch, baseUrl = 'https://blockbook.example') {
  return new BlockbookDataSource({ baseUrl, http: noSleepOptions({ fetchImpl }) });
}

describe('BlockbookDataSource', () => {
  describe('getTip', () => {
    it('reads blockbook.bestHeight', async () => {
      const { fetchImpl, calls } = stubFetch([{ body: { blockbook: { bestHeight: 3_002_560 } } }]);

      await expect(source(fetchImpl).getTip()).resolves.toBe(3_002_560);
      expect(calls[0]).toBe('https://blockbook.example/api/v2');
    });

    it('fails loudly when the height is missing', async () => {
      const { fetchImpl } = stubFetch([{ body: { blockbook: {} } }]);

      await expect(source(fetchImpl).getTip()).rejects.toThrow(/no blockbook.bestHeight/);
    });
  });

  describe('getBlockHash', () => {
    it('reads the hash from block-index without downloading the block', async () => {
      const { fetchImpl, calls } = stubFetch([{ body: { blockHash: '000000abc' } }]);

      await expect(source(fetchImpl).getBlockHash(1_234_567)).resolves.toBe('000000abc');
      expect(calls).toEqual(['https://blockbook.example/api/v2/block-index/1234567']);
    });

    it('fails loudly when the hash is missing', async () => {
      const { fetchImpl } = stubFetch([{ body: {} }]);

      await expect(source(fetchImpl).getBlockHash(1)).rejects.toThrow(/no blockHash/);
    });
  });

  describe('getBlock', () => {
    it('requests one URL per block', async () => {
      const { fetchImpl, calls } = stubFetch([{ body: BLOCK_FIXTURE }]);

      await source(fetchImpl).getBlock(1_234_567);

      expect(calls).toEqual(['https://blockbook.example/api/v2/block/1234567']);
    });

    it('normalises the block header', async () => {
      const { fetchImpl } = stubFetch([{ body: BLOCK_FIXTURE }]);

      const block = await source(fetchImpl).getBlock(1_234_567);

      expect(block).toMatchObject({
        height: 1_234_567,
        hash: BLOCK_FIXTURE.hash,
        prevHash: BLOCK_FIXTURE.previousBlockHash,
        time: 1_756_000_000,
        txCount: 2
      });
    });

    it('returns every transaction, with no per-block transfer cap', async () => {
      const { fetchImpl } = stubFetch([{ body: BLOCK_FIXTURE }]);

      const block = await source(fetchImpl).getBlock(1_234_567);

      // #15 was `TRANSACTION_FETCH_LIMIT: 20` silently dropping everything past it.
      expect(block.transactions).toHaveLength(BLOCK_FIXTURE.txs.length);
    });

    it('keeps values as satoshis', async () => {
      const { fetchImpl } = stubFetch([{ body: BLOCK_FIXTURE }]);

      const block = await source(fetchImpl).getBlock(1_234_567);
      const transfer = block.transactions[0]!;

      expect(transfer.inputs.map((input) => input.sat)).toEqual([600_000_000, 400_000_000]);
      expect(transfer.outputs[0]!.sat).toBe(999_990_000);
      // If these were FLUX the total would be ~1e10 sat, so conservation would fail loudly.
      expect(checkConservation(transfer)).toBeNull();
    });

    it('preserves the previous-output index on inputs, for hop tracing', async () => {
      const { fetchImpl } = stubFetch([{ body: BLOCK_FIXTURE }]);

      const block = await source(fetchImpl).getBlock(1_234_567);

      expect(block.transactions[0]!.inputs.map((input) => input.vout)).toEqual([0, 1]);
    });

    it('marks OP_RETURN outputs as nulldata rather than dropping them silently', async () => {
      const { fetchImpl } = stubFetch([{ body: BLOCK_FIXTURE }]);

      const block = await source(fetchImpl).getBlock(1_234_567);
      const [, opReturn] = block.transactions[0]!.outputs;

      expect(opReturn).toEqual({ n: 1, address: null, sat: 10_000, nulldata: true });
    });

    it('classifies the coinbase transaction', async () => {
      const { fetchImpl } = stubFetch([{ body: BLOCK_FIXTURE }]);

      const block = await source(fetchImpl).getBlock(1_234_567);

      expect(block.transactions.map((tx) => tx.kind)).toEqual(['transfer', 'coinbase']);
    });

    it('marks every normalised transaction complete', async () => {
      const { fetchImpl } = stubFetch([{ body: BLOCK_FIXTURE }]);

      const block = await source(fetchImpl).getBlock(1_234_567);

      expect(block.transactions.every((tx) => tx.complete)).toBe(true);
    });

    it('tolerates a missing previousBlockHash', async () => {
      const { fetchImpl } = stubFetch([
        { body: { ...BLOCK_FIXTURE, previousBlockHash: undefined } }
      ]);

      const block = await source(fetchImpl).getBlock(1);

      expect(block.prevHash).toBeNull();
    });

    it('falls back to the transaction count when txCount is absent', async () => {
      const { fetchImpl } = stubFetch([{ body: { ...BLOCK_FIXTURE, txCount: undefined } }]);

      const block = await source(fetchImpl).getBlock(1);

      expect(block.txCount).toBe(2);
    });

    it('surfaces an HTTP failure so the height is recorded as missing', async () => {
      const { fetchImpl } = stubFetch([{ status: 500, body: 'upstream error' }]);

      await expect(source(fetchImpl).getBlock(1)).rejects.toBeInstanceOf(HttpError);
    });

    it('does not double up slashes when the base URL has a trailing one', async () => {
      const { fetchImpl, calls } = stubFetch([{ body: BLOCK_FIXTURE }]);

      await source(fetchImpl, 'https://blockbook.example/').getBlock(1);

      expect(calls[0]).toBe('https://blockbook.example/api/v2/block/1');
    });
  });

  describe('pagination', () => {
    it('follows every page of a large block so no transfer is dropped', async () => {
      const page1 = { ...BLOCK_FIXTURE, totalPages: 3, itemsOnPage: 1 };
      const page2 = { ...BLOCK_FIXTURE, totalPages: 3, itemsOnPage: 1, page: 2 };
      const page3 = { ...BLOCK_FIXTURE, totalPages: 3, itemsOnPage: 1, page: 3 };

      const { fetchImpl, calls } = stubFetch([{ body: page1 }, { body: page2 }, { body: page3 }]);

      const block = await source(fetchImpl).getBlock(1_234_567);

      expect(calls).toHaveLength(3);
      expect(block.transactions).toHaveLength(2);
      expect(block.height).toBe(1_234_567);
    });

    it('refuses to silently truncate an implausible page count', async () => {
      const huge = { ...BLOCK_FIXTURE, totalPages: 5_000 };

      const { fetchImpl } = stubFetch([{ body: huge }]);

      await expect(source(fetchImpl).getBlock(1)).rejects.toThrow(/refusing to truncate/);
    });
  });

  describe('isHealthy', () => {
    it('is true when the API answers with a height', async () => {
      const { fetchImpl } = stubFetch([{ body: { blockbook: { bestHeight: 10 } } }]);

      await expect(source(fetchImpl).isHealthy()).resolves.toBe(true);
    });

    it('is false, not throwing, when the API is down', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;

      await expect(source(fetchImpl).isHealthy()).resolves.toBe(false);
    });

    it('is false when the API answers with an unexpected shape', async () => {
      const { fetchImpl } = stubFetch([{ body: { unexpected: true } }]);

      await expect(source(fetchImpl).isHealthy()).resolves.toBe(false);
    });

    it('does not consume the retry budget of a real request', async () => {
      const fetchImpl = vi.fn(
        async () => new Response('nope', { status: 503 })
      ) as unknown as typeof fetch;

      const dataSource = new BlockbookDataSource({
        baseUrl: 'https://blockbook.example',
        http: noSleepOptions({ fetchImpl, retries: 5 })
      });

      await expect(dataSource.isHealthy()).resolves.toBe(false);
      expect(fetchImpl).toHaveBeenCalledOnce();
    });
  });
});
