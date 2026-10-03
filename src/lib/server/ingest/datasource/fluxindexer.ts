/**
 * FluxIndexer adapter — the project's own indexer (`FLUX_INDEXER_URL`).
 *
 * The indexer's block response lists transaction ids plus a `txDetails` summary but **not**
 * `vin`/`vout`, so enrichment costs one extra request per transfer transaction. That is
 * the "1 + N calls per block" cost #5 and #35 measure, and the reason the FluxNode pool is
 * preferred when it is available.
 *
 * The important fix here is what v1 got wrong: it capped enrichment at
 * `TRANSACTION_FETCH_LIMIT` (50 for this source) and **silently dropped every transfer
 * past that point**. There is no cap now — a per-source limiter bounds concurrency instead,
 * which throttles without discarding data (#15).
 */

import { createLimiter, httpJson, type HttpRequestOptions, type Limiter } from '../../http.js';
import {
  toSat,
  type DataSource,
  type NormalisedBlock,
  type NormalisedTx,
  type TransactionKind,
  type ValueUnit
} from './types.js';

/**
 * Which unit the indexer reports amounts in.
 *
 * v1 read `input.value || input.valueSat` with no conversion and stored `value / 1e8`,
 * so a response in FLUX would have been recorded 1e8× too large with nothing to catch it.
 * The unit is therefore declared explicitly here and asserted by the conservation check.
 * Flip this constant if the indexer's contract changes — the tests pin the behaviour.
 */
const VALUE_UNIT: ValueUnit = 'sat';

interface IndexerTxDetail {
  txid?: string;
  hash?: string;
  kind?: string;
}

interface IndexerBlock {
  height?: number;
  hash?: string;
  previousblockhash?: string;
  previousBlockHash?: string;
  time?: number;
  size?: number;
  txCount?: number;
  txcount?: number;
  /** Transaction ids. */
  tx?: unknown[];
  /** Summaries, including the `kind` needed to skip coinbase and node confirms. */
  txDetails?: IndexerTxDetail[];
  txs?: unknown[];
}

interface IndexerInput {
  address?: string;
  addresses?: string[];
  value?: number | string;
  valueSat?: number | string;
  vout?: number;
}

interface IndexerOutput {
  address?: string;
  addresses?: string[];
  value?: number | string;
  valueSat?: number | string;
  n?: number;
  script?: string;
  scriptPubKey?: { addresses?: string[]; hex?: string };
}

interface IndexerTx {
  txid?: string;
  hash?: string;
  vin?: IndexerInput[];
  vout?: IndexerOutput[];
  inputs?: IndexerInput[];
  outputs?: IndexerOutput[];
  kind?: string;
  blockHeight?: number;
  blockheight?: number;
  blockTime?: number;
  blocktime?: number;
}

export interface FluxIndexerOptions {
  readonly baseUrl: string;
  /**
   * Transaction lookups in flight per block.
   *
   * Deliberately its own limit rather than the service's shared limiter.
   * `FailoverDataSource` already runs `getBlock` inside a slot of that limiter, so taking a
   * second slot here for each lookup deadlocks: once every slot is held by an outer
   * `getBlock`, no lookup can ever start and every sync cycle hangs.
   */
  readonly enrichConcurrency?: number;
  readonly http?: Omit<HttpRequestOptions, 'limiter'>;
  /** Refuse a block that would need more enrichments than this, rather than truncating. */
  readonly maxTransactionsPerBlock?: number;
}

const DEFAULT_MAX_TRANSACTIONS_PER_BLOCK = 5_000;
const DEFAULT_ENRICH_CONCURRENCY = 8;

export class FluxIndexerDataSource implements DataSource {
  readonly id = 'flux-indexer';
  readonly description: string;
  private readonly enrichLimiter: Limiter;

  constructor(private readonly options: FluxIndexerOptions) {
    this.description = `FluxIndexer (${options.baseUrl})`;
    this.enrichLimiter = createLimiter(options.enrichConcurrency ?? DEFAULT_ENRICH_CONCURRENCY);
  }

  async getTip(): Promise<number> {
    const status = await httpJson<Record<string, unknown>>(
      `${this.options.baseUrl.replace(/\/+$/, '')}/api/v1/status`,
      this.options.http
    );

    return readHeight(status);
  }

  async getBlock(height: number): Promise<NormalisedBlock> {
    const base = this.options.baseUrl.replace(/\/+$/, '');

    const block = await httpJson<IndexerBlock>(
      `${base}/api/v1/blocks/${height}`,
      this.options.http
    );

    const txids = readTxIds(block);
    const summaries = block.txDetails ?? [];
    const cap = this.options.maxTransactionsPerBlock ?? DEFAULT_MAX_TRANSACTIONS_PER_BLOCK;

    // Enrich only transfers. Coinbase and node confirmations carry no counterparties, so
    // fetching them is pure waste — this is the only reason the N+1 exists at all.
    const wanted = txids.filter((txid) => {
      const summary = summaries.find((detail) => (detail.txid ?? detail.hash) === txid);
      return normaliseKind(summary?.kind) === 'transfer';
    });

    if (wanted.length > cap) {
      throw new Error(
        `block ${height} has ${wanted.length} transfer transactions, above the ${cap} cap; ` +
          'raise FLUX_INDEXER_MAX_TXS_PER_BLOCK rather than silently dropping transfers'
      );
    }

    const transactions = await this.enrichAll(wanted);

    return {
      height: block.height ?? height,
      hash: block.hash ?? '',
      prevHash: block.previousblockhash ?? block.previousBlockHash ?? null,
      time: block.time ?? 0,
      txCount: block.txCount ?? block.txcount ?? txids.length,
      transactions
    };
  }

  /**
   * Fetch every wanted transaction, bounded by this source's own limiter.
   *
   * `Promise.allSettled` over the limiter keeps N requests in flight at all times, rather
   * than v1's chunk-of-10 barrier that waited for the slowest request in each group (#5).
   */
  private async enrichAll(txids: string[]): Promise<NormalisedTx[]> {
    const fetchOne = async (txid: string): Promise<NormalisedTx> => {
      const load = (): Promise<IndexerTx> =>
        httpJson<IndexerTx>(
          `${this.options.baseUrl.replace(/\/+$/, '')}/api/v1/transactions/${txid}`,
          this.options.http
        );

      // Without a limiter a 200-transfer block would fire 200 requests at once, which is
      // exactly how a source gets rate-limited into an outage.
      const raw = await this.enrichLimiter.run(load);

      return normaliseTx(raw);
    };

    const settled = await Promise.allSettled(txids.map(fetchOne));
    const results: NormalisedTx[] = [];

    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
        return;
      }

      // One failed enrichment must not lose the rest of the block; the pipeline treats
      // the block as incomplete and retries it (the fix for #14).
      results.push({
        txid: txids[index]!,
        kind: 'transfer',
        inputs: [],
        outputs: [],
        complete: false
      });
    });

    return results;
  }

  async isHealthy(): Promise<boolean> {
    try {
      await httpJson(`${this.options.baseUrl.replace(/\/+$/, '')}/health`, {
        ...this.options.http,
        retries: 0,
        timeoutMs: 5_000
      });
      return true;
    } catch {
      return false;
    }
  }
}

function readHeight(status: Record<string, unknown>): number {
  const indexer = status.indexer as Record<string, unknown> | undefined;
  const daemon = status.daemon as Record<string, unknown> | undefined;

  const candidates = [
    indexer?.currentHeight,
    indexer?.chainHeight,
    daemon?.blocks,
    status.height,
    status.chainHeight,
    status.blockHeight,
    status.bestHeight,
    status.currentHeight
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate;
  }

  throw new Error(
    `could not determine chain height from indexer status: ${JSON.stringify(status)}`
  );
}

/** The block response lists ids in `tx`; tolerate `txs` and object entries too. */
function readTxIds(block: IndexerBlock): string[] {
  const raw = Array.isArray(block.tx) ? block.tx : Array.isArray(block.txs) ? block.txs : [];

  return raw
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const id = record.txid ?? record.hash;
        return typeof id === 'string' ? id : null;
      }
      return null;
    })
    .filter((id): id is string => id !== null);
}

function normaliseKind(kind: string | undefined): TransactionKind {
  switch (kind) {
    case 'coinbase':
      return 'coinbase';
    case 'fluxnode_confirm':
    case 'node_confirm':
      return 'node_confirm';
    case 'transfer':
      return 'transfer';
    default:
      return 'other';
  }
}

/**
 * Whether the indexer actually returned spendable addresses.
 *
 * Uses the same readers as the normalisation below, so an output that ends up with an
 * address is never reported as incomplete. A transfer with no inputs *is* unusable, and
 * writing it as "a wallet sent nothing and received nothing" would quietly inflate the
 * unknown-wallet count.
 */
function hasAddressData(tx: IndexerTx): boolean {
  const inputs = tx.vin ?? tx.inputs ?? [];
  const outputs = tx.vout ?? tx.outputs ?? [];

  return (
    inputs.some((input) => readInputAddresses(input) !== null) &&
    outputs.some((output) => readOutputAddresses(output) !== null)
  );
}

/**
 * Flatten the indexer's several output shapes.
 *
 * `vout[].scriptPubKey.addresses` versus `outputs[].addresses` versus a bare
 * `outputs[].address` all appear in practice; v1 handled only the first.
 */
function readOutputAddresses(output: IndexerOutput): string | null {
  return output.address ?? output.addresses?.[0] ?? output.scriptPubKey?.addresses?.[0] ?? null;
}

function readInputAddresses(input: IndexerInput): string | null {
  return input.address ?? input.addresses?.[0] ?? null;
}

function normaliseTx(tx: IndexerTx): NormalisedTx {
  const inputs = tx.vin ?? tx.inputs ?? [];
  const outputs = tx.vout ?? tx.outputs ?? [];

  return {
    txid: tx.txid ?? tx.hash ?? '',
    kind: normaliseKind(tx.kind),
    inputs: inputs.map((input) => ({
      address: readInputAddresses(input),
      sat: toSat(input.value ?? input.valueSat, VALUE_UNIT),
      vout: input.vout ?? null
    })),
    outputs: outputs.map((output, index) => {
      const address = readOutputAddresses(output);
      // An output with no address is OP_RETURN or unspendable: not a counterparty.
      const nulldata = address === null;

      return {
        n: output.n ?? index,
        address,
        sat: toSat(output.value ?? output.valueSat, VALUE_UNIT),
        nulldata
      };
    }),
    complete: hasAddressData(tx)
  };
}
