/**
 * Circuit breaker and source failover.
 *
 * Fixes #12. v1's `switchToFallbackDataSource()` **toggled** a single global. Ten
 * concurrent `fetchBlock()` calls each called it after their third failure, so during an
 * outage the active source flipped Indexer → Blockbook → Indexer → … depending on whether
 * an even or odd number of fetches had failed. `reloadSettings()` also swapped
 * batch size and concurrency mid-batch, so Blockbook ended up receiving 500-block batches
 * at 10× concurrency and got rate-limited. One block that merely 404'd flipped the whole
 * service, and once on Blockbook it stayed there.
 *
 * Here each source has its own breaker:
 * - failures are counted **across all requests**, not per request
 * - the primary is probed on a timer and taken back once it is healthy
 * - transitions are guarded by a mutex, so exactly one switch happens per state change
 * - every transition is logged once, not once per in-flight request
 */

import type { Logger } from 'pino';
import { HttpError, type Limiter } from '../../http.js';
import type { Config } from '../../config.js';
import type { DataSource } from './types.js';

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  readonly name: string;
  /** Consecutive-ish failures inside the window that trip the breaker. */
  readonly failureThreshold?: number;
  /** Sliding window the failures are counted over. */
  readonly failureWindowMs?: number;
  /** How long the breaker stays open before allowing a probe. */
  readonly openMs?: number;
  /** Multiplier applied to `openMs` after each failed probe, capped at `maxOpenMs`. */
  readonly openBackoffFactor?: number;
  readonly maxOpenMs?: number;
  readonly log?: Logger;
  readonly now?: () => number;
}

/** Thrown instead of making a request when a source's breaker is open. */
export class CircuitOpenError extends Error {
  constructor(
    readonly source: string,
    readonly retryInMs: number
  ) {
    super(`circuit open for ${source}; retrying in ${Math.round(retryInMs / 1000)}s`);
    this.name = 'CircuitOpenError';
  }
}

export interface BreakerTransition {
  readonly from: BreakerState;
  readonly to: BreakerState;
  readonly reason: string;
}

/**
 * A single circuit breaker.
 *
 * Deliberately not a generic resilience library: the interesting behaviour here is the
 * interaction with a background health probe and with source priority, and that is easier
 * to reason about in 120 lines than through a library's options.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failureTimestamps: number[] = [];
  private openedAt = 0;
  private currentOpenMs: number;
  private probeInFlight = false;

  private readonly failureThreshold: number;
  private readonly failureWindowMs: number;
  private readonly baseOpenMs: number;
  private readonly openBackoffFactor: number;
  private readonly maxOpenMs: number;
  private readonly now: () => number;

  constructor(private readonly options: BreakerOptions) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.failureWindowMs = options.failureWindowMs ?? 60_000;
    this.baseOpenMs = options.openMs ?? 30_000;
    this.currentOpenMs = this.baseOpenMs;
    this.openBackoffFactor = options.openBackoffFactor ?? 2;
    this.maxOpenMs = options.maxOpenMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  get currentState(): BreakerState {
    // An open breaker whose cooldown has elapsed is half-open even before anyone asks:
    // this keeps `currentState` honest for the status endpoint.
    if (this.state === 'open' && this.now() - this.openedAt >= this.currentOpenMs) {
      return 'half-open';
    }

    return this.state;
  }

  get retryInMs(): number {
    return this.state === 'open'
      ? Math.max(0, this.currentOpenMs - (this.now() - this.openedAt))
      : 0;
  }

  /** Run `fn` through the breaker, recording success or failure. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState;

    if (state === 'open') {
      throw new CircuitOpenError(this.options.name, this.retryInMs);
    }

    // Only one probe at a time in half-open: a second concurrent call must not slip
    // through and be counted as a success.
    if (state === 'half-open') {
      if (this.probeInFlight) throw new CircuitOpenError(this.options.name, this.retryInMs);
      this.probeInFlight = true;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure(error);
      throw error;
    } finally {
      this.probeInFlight = false;
    }
  }

  /**
   * Run a health probe. Never throws and never counts as request traffic, so a source that
   * is merely idle does not accumulate failures.
   */
  async probe(fn: () => Promise<boolean>): Promise<boolean> {
    if (this.currentState === 'closed') return true;
    if (this.probeInFlight) return false;

    this.probeInFlight = true;

    try {
      const healthy = await fn();
      if (healthy) {
        this.transition('closed', 'health probe succeeded');
        this.reset();
      } else {
        this.reopen('health probe failed');
      }
      return healthy;
    } catch (error) {
      this.reopen(`health probe threw: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      this.probeInFlight = false;
    }
  }

  private recordSuccess(): void {
    if (this.state === 'half-open' || this.state === 'open') {
      this.transition('closed', 'request succeeded');
    }

    this.failureTimestamps = [];
  }

  private recordFailure(error: unknown): void {
    // A single bad block is a data problem, not an outage. Only failures that look like
    // the source being unwell should count towards the breaker.
    if (!isWorthyOfCounting(error)) {
      this.options.log?.debug(
        { source: this.options.name, reason: describeError(error) },
        'request failed but does not count towards the breaker'
      );
      return;
    }

    const now = this.now();
    this.failureTimestamps = this.failureTimestamps.filter(
      (timestamp) => now - timestamp < this.failureWindowMs
    );
    this.failureTimestamps.push(now);

    // A probe that failed means the source is still unwell: back the cooldown off so a
    // genuinely long outage does not get probed every 30 seconds forever.
    if (this.currentState === 'half-open') {
      this.reopen('probe request failed');
      return;
    }

    if (this.failureTimestamps.length >= this.failureThreshold) {
      this.trip(`${this.failureTimestamps.length} failures within ${this.failureWindowMs}ms`);
    }
  }

  /** First trip: use the base cooldown, without inflating it. */
  private trip(reason: string): void {
    this.currentOpenMs = this.baseOpenMs;
    this.failureTimestamps = [];
    this.transition('open', reason);
    this.openedAt = this.now();
  }

  /** Re-trip after a failed probe: lengthen the cooldown, up to `maxOpenMs`. */
  private reopen(reason: string): void {
    this.currentOpenMs = Math.min(this.currentOpenMs * this.openBackoffFactor, this.maxOpenMs);
    this.failureTimestamps = [];
    this.transition('open', reason);
    this.openedAt = this.now();
  }

  private transition(to: BreakerState, reason: string): void {
    const from = this.currentState;
    if (from === to) return;

    this.state = to;
    if (to === 'closed') this.currentOpenMs = this.baseOpenMs;

    // One line per transition, which is the whole point: v1 logged once per failing
    // request and the interleaving was unreadable.
    this.options.log?.warn(
      { source: this.options.name, from, to, reason },
      'circuit breaker transition'
    );
  }

  /** Clear failure history without changing state. */
  reset(): void {
    this.failureTimestamps = [];
  }
}

/**
 * Whether a failure should count towards opening the breaker.
 *
 * 4xx (other than 408/429) means this particular request was wrong — a height that does
 * not exist, a malformed id — so the source is demonstrably alive and should not be
 * penalised. That distinction is what stops one bad block from causing a failover (#12).
 */
export function isWorthyOfCounting(error: unknown): boolean {
  if (!(error instanceof HttpError)) {
    // A programming error or an unnormalised payload: not the source's fault.
    return false;
  }

  return error.retryable;
}

function describeError(error: unknown): string {
  if (error instanceof HttpError) {
    return error.status === undefined ? error.message : `HTTP ${error.status} ${error.url}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export interface FailoverOptions {
  readonly sources: readonly DataSource[];
  readonly config: Config;
  readonly log: Logger;
  readonly limiter?: Limiter;
  /** Overrides for tests. */
  readonly now?: () => number;
}

/**
 * Picks the first source whose breaker is closed, and probes the rest in the background.
 *
 * Sources are ordered by preference. The FluxNode pool is first because it costs the
 * project nothing and is not rate-limited (#35); a dedicated indexer, if configured, is
 * the fastest; Blockbook is the public fallback.
 */
export class FailoverDataSource {
  private readonly breakers: Map<string, CircuitBreaker>;
  private probeTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: FailoverOptions) {
    this.breakers = new Map(
      options.sources.map((source) => [
        source.id,
        new CircuitBreaker({
          name: source.id,
          failureThreshold: 5,
          failureWindowMs: 60_000,
          openMs: 30_000,
          log: options.log.child({ component: 'circuit-breaker' }),
          ...(options.now ? { now: options.now } : {})
        })
      ])
    );
  }

  /** The source that would serve the next request. */
  get active(): DataSource | undefined {
    return this.options.sources.find(
      (source) => this.breakerFor(source.id).currentState !== 'open'
    );
  }

  breakerFor(id: string): CircuitBreaker {
    const breaker = this.breakers.get(id);
    if (!breaker) throw new Error(`unknown data source: ${id}`);
    return breaker;
  }

  /**
   * Run `fn` against the first healthy source, failing over on error.
   *
   * Each source is tried once: a source that is not the active one is only reached after
   * the previous one has already failed, so this is not a retry loop.
   */
  async withFailover<T>(operation: (source: DataSource) => Promise<T>): Promise<T> {
    const attempted: string[] = [];
    let lastError: unknown;

    for (const source of this.options.sources) {
      const breaker = this.breakerFor(source.id);

      if (breaker.currentState === 'open') {
        this.options.log.debug(
          { source: source.id, retryInMs: breaker.retryInMs },
          'skipping source: breaker open'
        );
        continue;
      }

      attempted.push(source.id);

      try {
        return await breaker.execute(() =>
          operation(this.options.limiter ? wrapWithLimiter(source, this.options.limiter) : source)
        );
      } catch (error) {
        lastError = error;
        this.options.log.warn(
          { source: source.id, reason: describeError(error) },
          'source failed, trying the next one'
        );
      }
    }

    throw lastError ?? new Error('no usable data source is configured');
  }

  /**
   * Probe every source on a timer.
   *
   * This is the "switch back to the primary once it is healthy" half of #12: without it,
   * a service that failed over during an outage never returns to the good source.
   */
  startProbing(intervalMs = 60_000): void {
    if (this.probeTimer) return;

    this.probeTimer = setInterval(() => {
      void this.probeAll();
    }, intervalMs);

    // Never hold the process open just to run a health probe.
    this.probeTimer.unref?.();
  }

  stopProbing(): void {
    if (!this.probeTimer) return;
    clearInterval(this.probeTimer);
    this.probeTimer = undefined;
  }

  async probeAll(): Promise<void> {
    for (const source of this.options.sources) {
      const breaker = this.breakerFor(source.id);
      if (breaker.currentState === 'closed') continue;

      await breaker.probe(() => source.isHealthy());
    }
  }

  /** A snapshot for the status endpoint. */
  status(): {
    active: string | undefined;
    sources: { id: string; description: string; state: BreakerState; retryInMs: number }[];
  } {
    return {
      active: this.active?.id,
      sources: this.options.sources.map((source) => {
        const breaker = this.breakerFor(source.id);
        return {
          id: source.id,
          description: source.description,
          state: breaker.currentState,
          retryInMs: breaker.retryInMs
        };
      })
    };
  }

  /**
   * Extra per-source detail for `/api/status`, when a source offers it.
   *
   * The FluxNode pool reports how many nodes it found, how many can attribute inputs and
   * which are benched (#25). That is the difference between "the pool is unhealthy" and
   * "the pool is fine but half of it has no spent index", which are very different
   * problems.
   *
   * Kept optional on the contract so a source is not required to expose internals in order
   * to be used.
   */
  detailsFor(id: string): Record<string, unknown> | undefined {
    const source = this.options.sources.find((candidate) => candidate.id === id);
    const status = (source as { status?: () => Record<string, unknown> } | undefined)?.status;

    return typeof status === 'function' ? status.call(source) : undefined;
  }
}

/**
 * Present a source to the caller while enforcing the shared concurrency limit.
 *
 * Wrapping rather than mutating the source keeps every adapter free of limiter plumbing
 * and guarantees sync and enhancement share one budget.
 */
function wrapWithLimiter(source: DataSource, limiter: Limiter): DataSource {
  return {
    id: source.id,
    description: source.description,
    getTip: () => limiter.run(() => source.getTip()),
    getBlock: (height) => limiter.run(() => source.getBlock(height)),
    isHealthy: () => source.isHealthy()
  };
}
