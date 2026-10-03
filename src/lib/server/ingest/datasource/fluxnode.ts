/**
 * FluxNode daemon pool (`#35`).
 *
 * FluxFlow previously had exactly two ways to get chain data: a private indexer on the
 * operator's LAN, or the single public `blockbook.runonflux.io`. That second option is the
 * problem — it rate-limits by IP, so a shared or busy host simply cannot ingest. Measured
 * against the live instance, sustained sync needs ~12 days for six months of history.
 *
 * There is a third option that costs the project nothing. Every FluxNode runs `fluxd`, and
 * FluxOS republishes its daemon RPCs over plain HTTP on the node's API port. With Proof of
 * Node, every block producer is a FluxNode, so there are thousands of full nodes online at
 * once and the load can be spread across them instead of concentrated on one host.
 *
 * The second, larger win is request shape: `getblock/<height>` at verbosity 2 returns the
 * whole block — every transaction, every input and output, with satoshi amounts — in one
 * request. v1 needed 1 + N requests per block and capped N at 50 (#15).
 *
 * Two things this deliberately does **not** do:
 *
 *  - It does not trust any single node. The tip is the median across the pool, and every
 *    Nth block's hash is re-fetched from a *different* node and compared. A node that
 *    answers with a wrong height or a wrong hash is benched, not believed.
 *
 *  - It does not hammer anyone. Two requests in flight per node, a low pool size, backoff
 *    on every failure, and a `User-Agent` that says who we are. These are operators' home
 *    connections, not our infrastructure.
 */

import type { Logger } from 'pino';
import { httpJson, type HttpRequestOptions } from '../../http.js';
import {
  unwrap,
  type DaemonBlock,
  type DaemonBlockCount,
  type DaemonBlockDeltas,
  type DaemonBlockHash,
  type DaemonEnvelope,
  type DaemonTx,
  type DaemonVin,
  type DaemonVout
} from './daemon.js';
import {
  SATS_PER_FLUX,
  toSat,
  type DataSource,
  type NormalisedBlock,
  type NormalisedTx,
  type TransactionKind
} from './types.js';

/**
 * Sent on every request so operators can see who is calling.
 *
 * **ASCII only.** HTTP header values are ByteStrings, so a single em dash or curly quote
 * makes `fetch` throw `Cannot convert argument to a ByteString` — and because that throw
 * happens before the request is sent, discovery finds no nodes at all and the pool reports
 * itself empty. Found by running the image against the live explorer, not by a test: the
 * fake fetch never validated its headers.
 */
/**
 * How long to wait before retrying discovery when it left the pool empty, doubling per
 * consecutive empty result up to the normal discovery interval.
 *
 * Without this an empty pool rediscovered on every call (every tip poll, every block
 * request, every health probe), re-probing dozens of operators' home connections each time.
 */
const EMPTY_POOL_RETRY_MS = 60_000;

/** Heights whose last serving node is remembered, so a confirmation read can go elsewhere. */
const SERVED_BY_MEMORY = 1_024;

/** Thrown after `spotCheck` has already benched the node, so it is not benched twice. */
class VerificationError extends Error {}

export const USER_AGENT =
  'FluxFlow/2 (+https://github.com/2ndtlmining/fluxflow; FLUX chain data; report issues there)';

/** A node that answered a probe and is eligible to serve. */
export interface PoolNode {
  /** `ip:port`, stable for logging. */
  readonly id: string;
  readonly ip: string;
  readonly port: number;
  /** Node tier, when the discovery response reported one. */
  readonly tier: string | null;
  /** Round-trip time of the probe, in ms. Lower is preferred. */
  readonly latencyMs: number;
  /**
   * Whether `vin` entries carry addresses.
   *
   * This is not a nicety: a node without `insightexplorer=1` returns spent inputs as bare
   * `{ txid, vout }`, so it cannot tell us who sent what. Blocks from such a node would
   * have no counterparty, and a flow with no counterparty is a guess, not a fact (#15).
   */
  readonly insight: boolean;
  /**
   * The highest block this node is known to have, from its probe or its latest tip answer.
   *
   * A node inside the tip tolerance can be a block or two behind the pool. Asking it for a
   * block it has not reached fails, and benching it for that punished a healthy node at
   * every new block, so heights are routed only to nodes known to have them.
   */
  tip: number;
  /** Epoch ms until which the node is not used. */
  benchedUntil: number;
  /** Consecutive failures, used to decide how long to bench for. */
  failures: number;
  requests: number;
  /** Requests from the sync loop currently in flight against this node. */
  inflight: number;
}

export interface FluxNodePoolOptions {
  /** Where to get the candidate node list. */
  readonly discoveryUrl: string;
  readonly poolSize: number;
  readonly probeSample: number;
  readonly maxInflightPerNode: number;
  readonly apiPorts: readonly number[];
  readonly discoverySeconds: number;
  readonly benchSeconds: number;
  readonly tipTolerance: number;
  readonly probeTimeoutMs: number;
  readonly spotCheckEvery: number;
  readonly http?: Omit<HttpRequestOptions, 'limiter'>;
  readonly log: Logger;
  /** Overrides for tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

/** A discovery candidate, before it has been probed. */
interface Candidate {
  readonly ip: string;
  readonly tier: string | null;
  /** An API port stated by the node list itself, preferred over the configured defaults. */
  readonly port?: number;
}

export class FluxNodePool implements DataSource {
  readonly id = 'fluxnode-pool';

  private nodes: PoolNode[] = [];
  private nextDiscoveryAt = 0;
  /** Guards discovery so a burst of concurrent calls probes the pool once. */
  private discovering: Promise<void> | undefined;
  /** Round-robin cursor, so load spreads instead of hammering the fastest node. */
  private cursor = 0;
  private lastTip: number | null = null;
  private lastError: string | null = null;
  /** Consecutive discoveries that left the pool empty, for the retry backoff. */
  private emptyDiscoveries = 0;
  /** Which node last answered for a height, so a re-read can ask a different one. */
  private readonly servedBy = new Map<number, string>();

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: FluxNodePoolOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  get description(): string {
    if (this.nodes.length === 0) return 'FluxNode pool (not yet probed)';

    const insight = this.nodes.filter((node) => node.insight).length;
    return `FluxNode pool (${this.nodes.length} nodes, ${insight} with a spent index)`;
  }

  /** A snapshot for `/api/status` (#25). */
  status(): {
    discovered: number;
    serving: number;
    insight: number;
    medianTip: number | null;
    lastError: string | null;
    nodes: {
      id: string;
      tier: string | null;
      insight: boolean;
      latencyMs: number;
      benched: boolean;
      failures: number;
    }[];
  } {
    return {
      discovered: this.nodes.length,
      serving: this.availableNodes().length,
      insight: this.nodes.filter((node) => node.insight).length,
      medianTip: this.lastTip,
      lastError: this.lastError,
      nodes: this.nodes.map((node) => ({
        id: node.id,
        tier: node.tier,
        insight: node.insight,
        latencyMs: node.latencyMs,
        benched: node.benchedUntil > this.now(),
        failures: node.failures
      }))
    };
  }

  // ── DataSource ─────────────────────────────────────────────────────────────

  /**
   * The tip, taken as the **median** across the pool.
   *
   * Any single node can be a block or two behind, or briefly serving a stale view. The
   * median is the one value no minority of wrong answers can move, which is why a single
   * node's `getblockcount` is never trusted directly.
   */
  async getTip(): Promise<number> {
    await this.ensurePool();

    const available = this.availableNodes();
    if (available.length === 0) throw new Error('no FluxNode is currently available');

    // `fetchTip` has already benched the node it was asked, so a rejection here needs no
    // further action — only a log line explaining the gap in the pool.
    const answers = await Promise.all(
      available.map(async (node) => {
        try {
          return await this.fetchTip(node);
        } catch (error) {
          this.options.log.debug(
            { node: node.id, reason: describe(error) },
            'no tip from FluxNode'
          );
          return null;
        }
      })
    );

    const tips = answers.filter((tip): tip is number => tip !== null).sort((a, b) => a - b);

    if (tips.length === 0) throw new Error('every FluxNode failed to report a tip');

    // With three or more answers the median is meaningful. Below that, there is no majority
    // to take a median of, so the *lowest* is used: never advertise a tip we have not
    // confirmed the chain has reached.
    const tip = tips.length >= 3 ? median(tips) : Math.min(...tips);

    this.lastTip = tip;
    this.lastError = null;
    return tip;
  }

  async getBlock(height: number): Promise<NormalisedBlock> {
    await this.ensurePool();

    // Only insight nodes can serve a block. Fetching from a node without a spent index
    // would silently produce flows with no counterparty (#15).
    const capable = this.availableNodes(true);
    if (capable.length === 0) {
      throw new Error(
        'no FluxNode with a spent index is available; cannot attribute transaction inputs'
      );
    }

    // Only nodes known to have reached the height. A node asked for a block above its tip
    // fails through no fault of its own, and must not be benched for it.
    const candidates = this.preferOtherThan(
      capable.filter((node) => node.tip >= height),
      height
    );
    if (candidates.length === 0) {
      throw new Error(`no FluxNode in the pool has reached block ${height} yet`);
    }

    let lastError: unknown;
    const deadline = this.now() + this.options.probeTimeoutMs * 3;

    // Try each eligible node in turn, starting from the cursor so load spreads and a node
    // that just failed is not asked again first.
    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const node = candidates[(this.cursor + attempt) % candidates.length]!;

      /*
       * Reserve the slot **synchronously**.
       *
       * Testing `inflight < max` and then incrementing after an await is a race: sixteen
       * concurrent callers all read `inflight === 0`, all pass, and all issue a request,
       * so one home connection ends up taking sixteen at once, which is exactly what the
       * per-node limit exists to prevent. Incrementing here, with no await in between,
       * makes the check-and-claim indivisible.
       */
      if (node.benchedUntil > this.now()) continue;
      if (node.inflight >= this.options.maxInflightPerNode) continue;
      node.inflight++;

      try {
        const block = await this.serveBlock(node, height);
        this.cursor = (this.cursor + attempt + 1) % candidates.length;
        return block;
      } catch (error) {
        lastError = error;
      }
    }

    /*
     * Every node is at its limit. That is saturation, not failure, so wait for a slot
     * rather than reporting an error the caller would record as a missing block (#13).
     *
     * Bounded by the request deadline, and retried across nodes so a single stuck node
     * cannot hold up the whole batch. If no node is merely *busy* (every one has been
     * benched) there is nothing to wait for, and holding the caller's limiter slot until
     * the deadline would only delay failover to the next source.
     */
    while (this.now() < deadline) {
      if (candidates.every((node) => node.benchedUntil > this.now())) break;

      await this.sleep(50);

      const node = candidates.find(
        (candidate) =>
          candidate.benchedUntil <= this.now() &&
          candidate.inflight < this.options.maxInflightPerNode
      );
      if (!node) continue;

      node.inflight++;

      try {
        return await this.serveBlock(node, height);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`no FluxNode had a free request slot within the deadline for block ${height}`);
  }

  /**
   * The hash at a height, from a node other than the one that last answered for it.
   *
   * The sync loop re-reads a hash that disagrees with the stored one before it rolls back
   * (a rollback deletes history). That second read is only worth something if it comes from
   * a different node: the same node asked twice will happily repeat itself.
   */
  async getBlockHash(height: number): Promise<string> {
    await this.ensurePool();

    const candidates = this.preferOtherThan(
      this.availableNodes().filter((node) => node.tip >= height),
      height
    );
    if (candidates.length === 0) {
      throw new Error(`no FluxNode in the pool has reached block ${height} yet`);
    }

    let lastError: unknown;

    for (const node of candidates) {
      node.requests++;

      try {
        const hash = await this.daemonGet<DaemonBlockHash>(
          node.ip,
          node.port,
          `/daemon/getblockhash/${height}`,
          { retries: 0, timeoutMs: this.options.probeTimeoutMs }
        );

        if (typeof hash !== 'string' || hash === '') {
          throw new Error(`implausible block hash: ${JSON.stringify(hash)}`);
        }

        this.succeeded(node);
        this.rememberServer(height, node.id);
        return hash;
      } catch (error) {
        lastError = error;
        this.bench(node.id, describe(error));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`no hash for block ${height}`);
  }

  /** Fetch, verify and account for one block from a node whose slot is already held. */
  private async serveBlock(node: PoolNode, height: number): Promise<NormalisedBlock> {
    try {
      const block = await this.fetchBlock(node, height, true);
      await this.spotCheck(node, height, block.hash);
      this.succeeded(node);
      this.rememberServer(height, node.id);
      this.lastError = null;
      return block;
    } catch (error) {
      // A failed spot check has already benched the node; benching again would double the
      // penalty for one disagreement.
      if (!(error instanceof VerificationError)) this.bench(node.id, describe(error));
      throw error;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.ensurePool();
    } catch (error) {
      this.lastError = describe(error);
      return false;
    }

    // "Healthy" means a block could actually be served. A pool of nodes none of which can
    // attribute inputs is not usable for ingestion, however many of them answer a tip.
    return this.availableNodes(true).length > 0;
  }

  // ── Pool lifecycle ─────────────────────────────────────────────────────────

  /**
   * Discover and probe the pool if it is missing or stale.
   *
   * Guarded by a single in-flight promise: the sync loop and the health probe both call in,
   * and without the guard a cold start would run `probeSample × ports` requests per caller.
   */
  private async ensurePool(): Promise<void> {
    if (this.discovering) return this.discovering;

    // Respected even when the pool is empty: rediscovering on every call would turn an
    // empty pool into a scan of operators' nodes every few seconds.
    if (this.now() < this.nextDiscoveryAt) return;

    this.discovering = this.rebuildPool().finally(() => {
      this.discovering = undefined;
    });

    return this.discovering;
  }

  private async rebuildPool(): Promise<void> {
    const started = this.now();

    let candidates: Candidate[];
    try {
      candidates = await this.discover();
    } catch (error) {
      // Keep whatever pool we already have: a discovery outage is not a reason to stop
      // ingesting from nodes that are demonstrably working.
      this.lastError = describe(error);
      this.options.log.warn(
        { reason: this.lastError, keeping: this.nodes.length },
        'FluxNode discovery failed, keeping the existing pool'
      );
      this.scheduleDiscovery();
      return;
    }

    if (candidates.length === 0) {
      // The explorer has answered 200 with an empty or reshaped list before. That says
      // nothing about the nodes already in the pool, so they are kept, as on an error.
      this.lastError = 'discovery returned no usable node addresses';
      this.options.log.warn(
        { keeping: this.nodes.length },
        'FluxNode discovery returned no candidates, keeping the existing pool'
      );
      this.scheduleDiscovery();
      return;
    }

    const probed = await this.probe(candidates);
    const medianTip = probed.length > 0 ? median(probed.map((node) => node.tip)) : null;

    // A node a block or two behind is normal; one far behind is not useful and only adds
    // latency to every request. The tolerance is what keeps a partially-synced home node
    // out of the pool without discarding the whole pool after one straggler.
    const eligible =
      medianTip === null
        ? []
        : probed.filter((node) => node.tip >= medianTip - this.options.tipTolerance);

    // Nodes that can serve a block first, then fastest first. Cut by latency alone, fast
    // nodes without a spent index could push out every node that can actually serve, and
    // the pool would be unusable for a whole discovery interval.
    eligible.sort(
      (a, b) => Number(b.insight) - Number(a.insight) || a.latencyMs - b.latencyMs || b.tip - a.tip
    );

    const selected = eligible.slice(0, this.options.poolSize);

    // A probe round that found nothing able to serve a block says more about our own
    // connectivity at that moment than about the nodes. Keep a pool that can still serve
    // rather than replace it with one that cannot, as on a discovery failure.
    if (!selected.some((node) => node.insight) && this.nodes.some((node) => node.insight)) {
      this.lastError = `re-probe found no usable FluxNode (${probed.length} answered)`;
      this.options.log.warn(
        { probed: probed.length, eligible: eligible.length, keeping: this.nodes.length },
        'FluxNode re-probe found no node that can serve blocks, keeping the existing pool'
      );
      this.scheduleDiscovery();
      return;
    }

    this.nodes = selected;
    this.scheduleDiscovery();

    const insight = this.nodes.filter((node) => node.insight).length;

    this.options.log.info(
      {
        candidates: candidates.length,
        probed: probed.length,
        eligible: eligible.length,
        kept: this.nodes.length,
        insight,
        medianTip,
        ms: this.now() - started
      },
      'FluxNode pool probed'
    );

    if (this.nodes.length === 0) {
      this.lastError = `no FluxNode within ${this.options.tipTolerance} of the median tip`;
      return;
    }

    this.lastError = null;
  }

  /** Fetch the candidate node list from the explorer endpoint. */
  private async discover(): Promise<Candidate[]> {
    const payload = await httpJson<unknown>(this.options.discoveryUrl, {
      ...this.options.http,
      timeoutMs: this.options.probeTimeoutMs * 2,
      headers: { 'user-agent': USER_AGENT }
    });

    return parseNodeList(payload);
  }

  /**
   * Probe candidates concurrently: is the API port open, how far behind is the tip, and does
   * `getblock` carry input addresses?
   *
   * Every failure is expected here — plenty of listed nodes are offline or running a
   * non-standard port — so failures are absorbed here rather than surfaced.
   */
  private async probe(candidates: Candidate[]): Promise<(PoolNode & { tip: number })[]> {
    const sample = this.sample(candidates, this.options.probeSample);
    const results = await Promise.all(sample.map((candidate) => this.probeOne(candidate)));

    return results.filter((node): node is PoolNode & { tip: number } => node !== null);
  }

  private async probeOne(candidate: Candidate): Promise<(PoolNode & { tip: number }) | null> {
    // The node list's own port first, then the configured defaults. Nodes sit behind UPnP
    // and home routers, so the "default" port is often not the one actually in use — and
    // for nodes that publish their port inline, probing anything else is a wasted round.
    const ports = candidate.port === undefined ? this.options.apiPorts : [candidate.port];

    for (const port of ports) {
      const started = this.now();

      try {
        // Probing deliberately bypasses `fetchTip`: a candidate is not in the pool yet, so
        // there is nothing to bench, and a failure here just means "try the next port".
        const count = await this.daemonGet<DaemonBlockCount>(
          candidate.ip,
          port,
          '/daemon/getblockcount',
          { retries: 0, timeoutMs: this.options.probeTimeoutMs }
        );

        if (!Number.isInteger(count) || count < 0) {
          throw new Error(`implausible block count: ${JSON.stringify(count)}`);
        }

        const latencyMs = this.now() - started;

        // One extra request answers the only capability question that matters: can this
        // node tell us who *sent* the value, or only who received it?
        const insight = await this.probeInsight(candidate.ip, port, count);

        return {
          id: `${candidate.ip}:${port}`,
          ip: candidate.ip,
          port,
          tier: candidate.tier,
          latencyMs,
          insight,
          benchedUntil: 0,
          failures: 0,
          requests: 0,
          inflight: 0,
          tip: count
        };
      } catch {
        // Wrong port, offline, or slow. Try the next one.
      }
    }

    return null;
  }

  private async probeInsight(ip: string, port: number, tip: number): Promise<boolean> {
    try {
      const hash = await this.daemonGet<DaemonBlockHash>(ip, port, `/daemon/getblockhash/${tip}`, {
        retries: 0,
        timeoutMs: this.options.probeTimeoutMs
      });

      await this.daemonGet<DaemonBlockDeltas>(ip, port, `/daemon/getblockdeltas/${hash}`, {
        retries: 0,
        timeoutMs: this.options.probeTimeoutMs
      });

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Re-fetch a block's hash from a *different* node and compare.
   *
   * A node serving a stale or forked view answers every request plausibly, so nothing else
   * would notice. Checking every Nth block bounds how much wrong data can land before it is
   * caught, at the cost of one extra request per N blocks.
   */
  private async spotCheck(serving: PoolNode, height: number, hash: string): Promise<void> {
    const every = this.options.spotCheckEvery;
    if (every === 0 || height % every !== 0) return;

    const others = this.availableNodes(true).filter((node) => node.id !== serving.id);
    if (others.length === 0) return;

    const checker = others[this.cursor % others.length]!;

    try {
      const checked = await this.daemonGet<DaemonBlockHash>(
        checker.ip,
        checker.port,
        `/daemon/getblockhash/${height}`,
        {
          retries: 0,
          timeoutMs: this.options.probeTimeoutMs
        }
      );

      if (checked !== hash) {
        // `serving` is the one that disagreed with an independent node, so it is benched
        // rather than the checker.
        this.bench(
          serving.id,
          `hash mismatch at ${height}: served ${short(hash)}, ${checker.id} says ${short(checked)}`
        );
        this.options.log.warn(
          { node: serving.id, height, served: hash, checked, checker: checker.id },
          'FluxNode served a block hash that no other node agrees with'
        );
        throw new VerificationError(`block ${height} failed cross-node verification`);
      }
    } catch (error) {
      // A checker that cannot answer is itself suspicious, but it is not evidence about
      // `serving`. Only a disagreement is disqualifying.
      if (error instanceof VerificationError) throw error;
      this.options.log.debug(
        { checker: checker.id, height, reason: describe(error) },
        'cross-node check could not run'
      );
    }
  }

  // ── Per-node HTTP ──────────────────────────────────────────────────────────

  private async fetchTip(node: PoolNode): Promise<number> {
    node.requests++;

    try {
      const count = await this.daemonGet<DaemonBlockCount>(
        node.ip,
        node.port,
        '/daemon/getblockcount',
        { retries: 1 }
      );

      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`implausible block count: ${JSON.stringify(count)}`);
      }

      node.tip = count;
      this.succeeded(node);
      return count;
    } catch (error) {
      this.bench(node.id, describe(error));
      throw error;
    }
  }

  /**
   * Fetch one block from one node.
   *
   * @param slotHeld whether the caller already incremented `inflight`. The slot is released
   * here either way, so the flag only controls who is responsible for the increment.
   */
  private async fetchBlock(
    node: PoolNode,
    height: number,
    slotHeld = false
  ): Promise<NormalisedBlock> {
    node.requests++;
    if (!slotHeld) node.inflight++;

    try {
      const raw = await this.daemonGet<DaemonBlock>(
        node.ip,
        node.port,
        `/daemon/getblock/${height}`
      );

      // A node answering with the wrong block is not a slow node, it is a wrong node, and
      // storing it would corrupt the chain we have stored.
      if (raw.height !== height) {
        throw new Error(`asked for block ${height} but ${node.id} returned ${raw.height}`);
      }

      return normaliseBlock(raw);
    } finally {
      node.inflight--;
    }
  }

  private async daemonGet<T>(
    ip: string,
    port: number,
    path: string,
    overrides: Partial<HttpRequestOptions> = {}
  ): Promise<T> {
    const url = `http://${ip}:${port}${path}`;

    // `http` first so per-call overrides win, and the User-Agent applied last so no
    // configured header can accidentally strip it — operators asked to see who is calling.
    const envelope = await httpJson<DaemonEnvelope<T>>(url, {
      timeoutMs: this.options.probeTimeoutMs * 3,
      retries: 1,
      retryBaseMs: this.options.http?.retryBaseMs ?? 500,
      ...this.options.http,
      ...overrides,
      headers: { 'user-agent': USER_AGENT, ...this.options.http?.headers, ...overrides.headers }
    });

    return unwrap(url, envelope);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Nodes not currently benched, and — when `insightOnly` — able to serve a block. */
  private availableNodes(insightOnly = false): PoolNode[] {
    const now = this.now();
    return this.nodes.filter((node) => node.benchedUntil <= now && (!insightOnly || node.insight));
  }

  /** A served request ends a failure streak; only *consecutive* failures grow the bench. */
  private succeeded(node: PoolNode): void {
    node.failures = 0;
  }

  /**
   * Order nodes so the one that last answered for `height` comes last.
   *
   * Used for re-reads: a confirmation is only independent if a different node gives it.
   */
  private preferOtherThan(nodes: PoolNode[], height: number): PoolNode[] {
    const last = this.servedBy.get(height);
    if (last === undefined) return nodes;

    return [
      ...nodes.filter((node) => node.id !== last),
      ...nodes.filter((node) => node.id === last)
    ];
  }

  private rememberServer(height: number, nodeId: string): void {
    this.servedBy.delete(height);
    this.servedBy.set(height, nodeId);

    // Insertion-ordered, so the oldest entry is first.
    if (this.servedBy.size > SERVED_BY_MEMORY) {
      const oldest = this.servedBy.keys().next().value;
      if (oldest !== undefined) this.servedBy.delete(oldest);
    }
  }

  /**
   * When to look for nodes next: the normal interval for a working pool, and a short,
   * growing backoff for an empty one so it recovers without being re-probed on every call.
   */
  private scheduleDiscovery(): void {
    const intervalMs = this.options.discoverySeconds * 1_000;

    if (this.nodes.length > 0) {
      this.emptyDiscoveries = 0;
      this.nextDiscoveryAt = this.now() + intervalMs;
      return;
    }

    const backoffMs = Math.min(EMPTY_POOL_RETRY_MS * 2 ** this.emptyDiscoveries, intervalMs);
    this.emptyDiscoveries++;
    this.nextDiscoveryAt = this.now() + backoffMs;
  }

  /**
   * Back a node off.
   *
   * The wait grows with consecutive failures, so a node that is genuinely down stops being
   * retried quickly while one that had a single blip comes straight back.
   */
  private bench(nodeId: string, reason: string): void {
    const node = this.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;

    node.failures++;

    const multiplier = Math.min(2 ** (node.failures - 1), 8);
    const waitMs = Math.min(this.options.benchSeconds * multiplier * 1_000, 30 * 60_000);
    node.benchedUntil = this.now() + waitMs;

    this.options.log.warn(
      { node: node.id, failures: node.failures, benchMs: waitMs, reason },
      'benched FluxNode'
    );
  }

  /**
   * A random subset of the candidates.
   *
   * Probing thousands of nodes on every rediscovery would be a scan, and would be noticed.
   * A sample keeps discovery cheap and spreads which nodes get used.
   */
  private sample(candidates: Candidate[], size: number): Candidate[] {
    if (candidates.length <= size) return candidates;

    const pool = [...candidates];
    const picked: Candidate[] = [];

    for (let index = 0; index < size; index++) {
      const position = Math.floor(this.random() * pool.length);
      picked.push(pool.splice(position, 1)[0]!);
    }

    return picked;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing and normalisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract candidate addresses from a discovery response.
 *
 * The explorer has changed this shape before, so anything that looks like an address is
 * accepted and everything else is ignored. A node list that parses to nothing is reported
 * rather than treated as "no nodes exist".
 */
export function parseNodeList(payload: unknown): Candidate[] {
  const seen = new Set<string>();
  const found: Candidate[] = [];

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }

    if (value === null || typeof value !== 'object') return;

    const record = value as Record<string, unknown>;

    // Nested shapes: `{ data: [...] }`, `{ nodes: [...] }`, `{ fluxnodes: [...] }`.
    for (const [key, nested] of Object.entries(record)) {
      if (/^(data|nodes?|flux_?nodes?|result)$/i.test(key)) visit(nested);
    }

    const raw = firstString(record, ['ip', 'ipAddress', 'ipaddress', 'node_ip']);
    if (raw === null) return;

    const host = parseHost(raw);
    if (host === null || seen.has(host.address)) return;

    seen.add(host.address);
    found.push({
      ip: host.address,
      // The node list sometimes states the API port inline, e.g. `24.108.153.230:16147`.
      // Probing only the default ports would miss every node configured this way.
      ...(host.port !== null ? { port: host.port } : {}),
      tier: firstString(record, ['tier', 'node_tier'])
    });
  };

  visit(payload);

  // Stratus and Nimbus nodes are better provisioned and more reliably online, so they are
  // preferred when the sample has to be cut.
  return found.sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
}

/** Tiers we prefer, best first. Anything else sorts last. */
const TIER_ORDER = ['stratus', 'nimbus', 'bsi', 'cumulus', 'appnodes', 'masternode'];

function tierRank(tier: string | null): number {
  if (tier === null) return TIER_ORDER.length;
  const index = TIER_ORDER.indexOf(tier.toLowerCase());
  return index === -1 ? TIER_ORDER.length : index;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number') return String(value);
  }

  return null;
}

/**
 * Split a node-list address into host and optional port.
 *
 * The explorer publishes these several ways, and both IPv4 forms appear in real responses:
 * `185.13.30.11` and `24.108.153.230:16147` (inline port, measured on the live list, and
 * common on UPnP nodes).
 *
 * @returns `null` for anything we will not open a socket to:
 *
 *  - **Any IPv6 address.** Out of scope for now (#35); requests built as `http://ip:port`
 *    would need bracketing, and every such node only wasted a probe slot.
 *  - **Any non-public IPv4 range**: private, shared (CGNAT), loopback, link-local,
 *    benchmarking, documentation, multicast and reserved. The node list is a third-party
 *    response; accepting a private address would have FluxFlow probe hosts on the LAN it
 *    runs in, which is a request-forgery route into the operator's own network.
 */
export function parseHost(raw: string): { address: string; port: number | null } | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.startsWith('[')) return null;

  const parts = trimmed.split(':');
  if (parts.length > 2) return null;

  const address = parts[0]!;

  let port: number | null = null;
  if (parts.length === 2) {
    port = Number(parts[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  }

  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return null;

  const octets = address.split('.').map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;

  return isPublicIpv4(octets) ? { address, port } : null;
}

/** Whether an IPv4 address, given as four octets, is globally routable. */
function isPublicIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;

  return !(
    a === 0 || // "this network"
    a === 10 || // private
    a === 127 || // loopback
    a >= 224 || // multicast and reserved
    (a === 100 && b >= 64 && b <= 127) || // shared address space (CGNAT)
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF assignments, TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) // TEST-NET-3
  );
}

/** Median of a numeric array. Assumes a non-empty array. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.floor((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/**
 * Normalise a daemon block to satoshis.
 *
 * `valueSat` is read in preference to `value`. v1 did `parseFloat(value) / 1e8`, which is
 * correct for Blockbook's satoshi amounts and exactly 100,000,000x too small for a daemon
 * FLUX value — the kind of error that looks plausible and is never noticed (#15).
 */
export function normaliseBlock(raw: DaemonBlock): NormalisedBlock {
  const transactions = (raw.tx ?? []).map(normaliseTx);

  return {
    height: raw.height,
    hash: raw.hash,
    prevHash: raw.previousblockhash ?? null,
    time: raw.time,
    txCount: raw.txCount ?? transactions.length,
    transactions
  };
}

function normaliseTx(tx: DaemonTx): NormalisedTx {
  const vin = tx.vin ?? [];
  const isCoinbase = vin.some((input) => input.coinbase !== undefined);

  const inputsResolved = vin.every(
    (input) => input.coinbase !== undefined || input.address !== undefined
  );

  return {
    txid: tx.txid,
    kind: classifyKind(tx, isCoinbase),
    inputs: vin.map((input, index) => ({
      address: input.address ?? null,
      sat: amountOf(input),
      vout: input.vout ?? (isCoinbase ? -1 : index)
    })),
    outputs: (tx.vout ?? []).map(normaliseOutput),
    // Every spent input resolved to an address. A block where any did not is incomplete,
    // and the pipeline refuses to guess at a counterparty it does not have (#14/#15).
    complete:
      inputsResolved &&
      (tx.vout ?? []).every(
        (output) => output.scriptPubKey !== undefined || output.valueSat !== undefined
      )
  };
}

function normaliseOutput(output: DaemonVout): NormalisedTx['outputs'][number] {
  const address = output.scriptPubKey?.addresses?.[0] ?? null;

  return {
    n: output.n,
    address,
    sat: amountOf(output),
    // No address means either OP_RETURN or a script we cannot spend from. Either way it is
    // not a counterparty transfer and must not become a flow.
    nulldata: address === null
  };
}

/** Sat amount of an input or output, preferring the satoshi field. */
function amountOf(entry: DaemonVin | DaemonVout): number {
  if (entry.valueSat !== undefined) return toSat(entry.valueSat, 'sat');
  if (entry.value !== undefined) return toSat(entry.value, 'flux');

  return 0;
}

function classifyKind(tx: DaemonTx, isCoinbase: boolean): TransactionKind {
  if (isCoinbase) return 'coinbase';

  /*
   * A FLUX node confirmation has **no** `vin` and no `vout` at all — just the txid and a
   * human-readable `type`. Recording it as a transfer would create a zero-amount flow row
   * for every node confirmation in every block.
   */
  if (tx.vin === undefined && tx.vout === undefined) return 'node_confirm';

  const declared = tx.type ?? tx.kind;

  if (declared === 'Confirming a fluxnode' || declared === 'fluxnode_confirm') {
    return 'node_confirm';
  }
  if (declared !== undefined && declared !== 'regular' && declared !== 'transfer') return 'other';

  return 'transfer';
}

/**
 * Collapse `getblockdeltas` into per-address net flows.
 *
 * This is the leanest ingest format a node offers: exactly the address-level deltas the
 * pipeline needs, with no script parsing and a fraction of the bytes `getblock` verbosity 2
 * costs. It is exported and tested against the same fixture as the `getblock` path so the
 * two cannot quietly diverge.
 *
 * The reply nests per-transaction deltas under `deltas`, each with its own inputs and
 * outputs; `satoshis` carries the direction by its sign.
 */
export function deltasToValueDeltas(
  deltas: DaemonBlockDeltas
): { address: string; satIn: number; satOut: number }[] {
  const byAddress = new Map<string, { address: string; satIn: number; satOut: number }>();

  const touch = (address: string): { address: string; satIn: number; satOut: number } => {
    let entry = byAddress.get(address);
    if (!entry) {
      entry = { address, satIn: 0, satOut: 0 };
      byAddress.set(address, entry);
    }
    return entry;
  };

  for (const tx of deltas.deltas ?? []) {
    for (const input of tx.inputs ?? []) {
      if (!input.address) continue;
      touch(input.address).satIn += Math.abs(input.satoshis ?? 0);
    }

    for (const output of tx.outputs ?? []) {
      if (!output.address) continue;
      touch(output.address).satOut += Math.abs(output.satoshis ?? 0);
    }
  }

  return [...byAddress.values()].filter((entry) => entry.satIn > 0 || entry.satOut > 0);
}

/* Note on capability probing — measured, not assumed.

   `getblock` verbosity 2 does return `vin[].address` and `vin[].valueSat` when the daemon
   runs with the spent index, so a single `getblock` is enough for ingestion. What is *not*
   guaranteed is that any given block contains a transfer: most FLUX blocks hold only the
   coinbase and node confirmations, which carry no inputs to resolve.

   Probing capability by fetching one block and looking for a resolved input therefore
   concludes "no spent index" about a perfectly capable node. That is exactly what happened
   on first contact with the live network — 39 nodes answered, 0 were marked capable.

   `getblockdeltas` is the honest probe: it needs the spent index to answer at all, and it
   answers even for a block with no transfers.
*/

/** Flux per satoshi, re-exported so callers do not hard-code the rate (#15). */
export { SATS_PER_FLUX };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function short(hash: string): string {
  return hash.length <= 12 ? hash : `${hash.slice(0, 12)}…`;
}
