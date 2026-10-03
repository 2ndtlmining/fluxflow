/**
 * Your own FluxNode, read over its FluxOS daemon API (`FLUX_NODE_URL`).
 *
 * The public pool (#35) exists because nobody can rely on one node they do not control. A
 * node you *do* control is the opposite case: it is trusted, it is usually on the LAN, and
 * it can take far more than the two requests in flight the pool allows a stranger's node.
 * So it is tried first, and the pool and Blockbook remain behind it as fallbacks.
 *
 * Two differences from a pool node, both deliberate:
 *  - **No address filtering.** Pool discovery rejects private and LAN addresses because the
 *    node list comes from a third party (SSRF). This URL comes from the operator's own
 *    configuration, so a `192.168.x.x` address is exactly what is expected.
 *  - **No spot checks.** Cross-checking a trusted node against strangers' nodes would make
 *    the less trustworthy source the arbiter.
 *
 * The spent index is still required — without it a spent input has no address, and a flow
 * with no sender cannot be attributed. A node without it reports itself unhealthy, so the
 * circuit breaker moves ingestion to the pool instead of retrying a source that cannot serve.
 */

import { httpJson, type HttpRequestOptions } from '../../http.js';
import {
  unwrap,
  type DaemonBlock,
  type DaemonBlockCount,
  type DaemonBlockDeltas,
  type DaemonBlockHash,
  type DaemonEnvelope
} from './daemon.js';
import { normaliseBlock, USER_AGENT } from './fluxnode.js';
import type { DataSource, NormalisedBlock } from './types.js';

export interface OwnNodeOptions {
  /** FluxOS API base URL, e.g. `http://192.168.40.155:16127`. */
  readonly baseUrl: string;
  readonly http?: Partial<HttpRequestOptions>;
}

export class OwnNodeDataSource implements DataSource {
  readonly id = 'own-node';
  readonly description: string;

  /** Learned once; a daemon does not gain or lose its spent index without a restart. */
  private spentIndex: boolean | null = null;

  constructor(private readonly options: OwnNodeOptions) {
    this.description = `Own FluxNode (${options.baseUrl})`;
  }

  async getTip(): Promise<number> {
    return this.get<DaemonBlockCount>('/daemon/getblockcount');
  }

  async getBlockHash(height: number): Promise<string> {
    return this.get<DaemonBlockHash>(`/daemon/getblockhash/${height}`);
  }

  async getBlock(height: number): Promise<NormalisedBlock> {
    if (!(await this.hasSpentIndex())) {
      throw new Error(
        `${this.options.baseUrl} has no spent index (insightexplorer=1), so transaction ` +
          'senders cannot be read from it'
      );
    }

    const raw = await this.get<DaemonBlock>(`/daemon/getblock/${height}`);

    // Storing block N-1's transactions under height N would corrupt the chain we keep.
    if (raw.height !== height) {
      throw new Error(`asked ${this.options.baseUrl} for block ${height}, got ${raw.height}`);
    }

    return normaliseBlock(raw);
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.getTip();
      return await this.hasSpentIndex();
    } catch {
      return false;
    }
  }

  /**
   * `getblockdeltas` answers only with the spent index enabled, and answers on any block —
   * including the quiet ones with no transfers, which made "look for a resolved input" an
   * unreliable probe in the pool (#43).
   */
  private async hasSpentIndex(): Promise<boolean> {
    if (this.spentIndex !== null) return this.spentIndex;

    const tip = await this.getTip();
    const hash = await this.getBlockHash(tip);

    try {
      await this.get<DaemonBlockDeltas>(`/daemon/getblockdeltas/${hash}`);
      this.spentIndex = true;
    } catch (error) {
      // Only a definite "disabled" answer is remembered; a timeout says nothing either way.
      if (error instanceof Error && /disabled|spent|insight/i.test(error.message)) {
        this.spentIndex = false;
      } else {
        throw error;
      }
    }

    return this.spentIndex;
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}${path}`;
    const envelope = await httpJson<DaemonEnvelope<T>>(url, {
      ...this.options.http,
      headers: { 'user-agent': USER_AGENT, ...this.options.http?.headers }
    });

    return unwrap(url, envelope);
  }
}
