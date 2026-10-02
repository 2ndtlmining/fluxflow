/**
 * Blockbook adapter (`https://blockbook.runonflux.io`).
 *
 * Reports amounts in satoshis and returns a whole block with fully-populated
 * `vin`/`vout` in one request, so this is one HTTP call per block.
 */

import { httpJson, type HttpRequestOptions } from '../../http.js';
import {
  toSat,
  type DataSource,
  type NormalisedBlock,
  type NormalisedTx,
  type TransactionKind
} from './types.js';

/** FLUX blockbook reports `value` in satoshis. */
const VALUE_UNIT = 'sat' as const;

interface BlockbookVin {
  addresses?: string[];
  value?: number | string;
  vout?: { n: number };
  isAddress?: boolean;
  coinbase?: string;
}

interface BlockbookVout {
  value?: number | string;
  n: number;
  addresses?: string[];
  isAddress?: boolean;
  spentTxid?: string;
  /** An empty `hex` marks an OP_RETURN output. */
  hex?: string | null;
  scriptSig?: { asm?: string };
}

interface BlockbookTx {
  txid: string;
  vin?: BlockbookVin[];
  vout?: BlockbookVout[];
  blocktime?: number;
  blockheight?: number;
  confirmations?: number;
}

interface BlockbookBlock {
  page?: number;
  totalPages?: number;
  itemsOnPage?: number;
  hash: string;
  previousBlockHash?: string;
  height: number;
  confirmations?: number;
  size?: number;
  time: number;
  version?: number;
  merkleRoot?: string;
  nonce?: string;
  bits?: string;
  difficulty?: number;
  txCount?: number;
  txs?: BlockbookTx[];
}

export interface BlockbookOptions {
  readonly baseUrl: string;
  readonly http?: Omit<HttpRequestOptions, 'limiter'>;
}

export class BlockbookDataSource implements DataSource {
  readonly id = 'blockbook';
  readonly description: string;

  constructor(private readonly options: BlockbookOptions) {
    this.description = `Blockbook (${options.baseUrl})`;
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}/api/v2${path}`;
  }

  async getTip(): Promise<number> {
    const info = await httpJson<{ blockbook?: { bestHeight?: number } }>(
      this.url(''),
      this.options.http
    );

    const height = info.blockbook?.bestHeight;
    if (typeof height !== 'number') {
      throw new Error(`Blockbook response has no blockbook.bestHeight: ${JSON.stringify(info)}`);
    }

    return height;
  }

  async getBlock(height: number): Promise<NormalisedBlock> {
    const block = await httpJson<BlockbookBlock>(this.url(`/block/${height}`), this.options.http);

    // Blockbook paginates very large blocks. Following the pages keeps #15 fixed: no
    // transaction is ever silently dropped.
    const blocks = await this.followPagination(block);
    const raw = blocks.at(-1) ?? block;

    return {
      height: raw.height,
      hash: raw.hash,
      prevHash: raw.previousBlockHash ?? null,
      time: raw.time,
      txCount: raw.txCount ?? raw.txs?.length ?? 0,
      transactions: (raw.txs ?? []).map(normaliseTx)
    };
  }

  /**
   * Fetch any remaining pages of a large block.
   *
   * Guarded by a page cap: a misbehaving `totalPages` must not become an unbounded fetch
   * loop, and a real FLUX block is nowhere near this large.
   */
  private async followPagination(first: BlockbookBlock): Promise<BlockbookBlock[]> {
    const totalPages = first.totalPages ?? 1;
    if (totalPages <= 1) return [first];

    const MAX_PAGES = 50;
    const pages: BlockbookBlock[] = [first];

    for (let page = 2; page <= Math.min(totalPages, MAX_PAGES); page++) {
      pages.push(
        await httpJson<BlockbookBlock>(
          this.url(`/block/${first.height}?page=${page}`),
          this.options.http
        )
      );
    }

    if (totalPages > MAX_PAGES) {
      throw new Error(
        `block ${first.height} reports ${totalPages} pages; refusing to truncate at ${MAX_PAGES}`
      );
    }

    return pages;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const info = await httpJson<{ blockbook?: { bestHeight?: number } }>(
        this.url(''),
        // A probe must not consume the retry budget of a real request.
        { ...this.options.http, retries: 0, timeoutMs: 5_000 }
      );
      return typeof info.blockbook?.bestHeight === 'number';
    } catch {
      return false;
    }
  }
}

/**
 * `isAddress: false` marks an output whose script cannot be spent to a known address.
 * Blockbook also reports OP_RETURN outputs that way, with an empty `hex`.
 */
function isSpendable(output: BlockbookVout): boolean {
  if (output.isAddress === false) return false;
  if (output.hex === '') return false;
  return Array.isArray(output.addresses) && output.addresses.length > 0;
}

function normaliseTx(tx: BlockbookTx): NormalisedTx {
  const isCoinbase = Boolean(tx.vin?.some((input) => input.coinbase));

  return {
    txid: tx.txid,
    kind: classifyKind(tx, isCoinbase),
    inputs: (tx.vin ?? []).map((input) => ({
      address: input.addresses?.[0] ?? null,
      sat: toSat(input.value, VALUE_UNIT),
      vout: input.vout?.n ?? null
    })),
    outputs: (tx.vout ?? []).map((output) => ({
      n: output.n,
      address: isSpendable(output) ? (output.addresses?.[0] ?? null) : null,
      sat: toSat(output.value, VALUE_UNIT),
      nulldata: !isSpendable(output)
    })),
    complete: true
  };
}

function classifyKind(tx: BlockbookTx, isCoinbase: boolean): TransactionKind {
  if (isCoinbase) return 'coinbase';

  // FLUX-specific tx kinds live in the non-standard fields blockbook echoes back.
  const raw = tx as unknown as Record<string, unknown>;
  const declared = raw.kind;

  if (declared === 'fluxnode_confirm' || declared === 'node_confirm') return 'node_confirm';
  if (declared === 'transfer') return 'transfer';

  return 'transfer';
}
