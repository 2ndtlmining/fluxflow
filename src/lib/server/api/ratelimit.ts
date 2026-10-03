/**
 * Per-client rate limiting for `/api` (#21).
 *
 * A token bucket per client IP, in process: `rps` tokens a second refill a bucket that holds
 * at most `burst`, and each request spends one. A dashboard load is a handful of requests at
 * once, which the burst absorbs; a script hammering the API runs dry and gets `429` with a
 * `Retry-After`.
 *
 * In process rather than a dependency: FluxFlow is one process, so there is no shared
 * store to coordinate, and the whole thing is a Map and some arithmetic.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface RateLimitOptions {
  /** Sustained requests per second per client. 0 disables limiting. */
  readonly rps: number;
  readonly burst: number;
  /** Paths (relative to the router mount) that are never limited. */
  readonly exempt?: readonly string[];
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Above this many tracked clients, idle full buckets are dropped. */
const SWEEP_THRESHOLD = 10_000;

export interface RateLimiter extends RequestHandler {
  /** Tracked clients, for metrics. */
  readonly clients: () => number;
  /** Requests refused since start, for metrics. */
  readonly rejected: () => number;
}

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const now = options.now ?? Date.now;
  const exempt = new Set(options.exempt ?? []);
  const buckets = new Map<string, Bucket>();
  let rejected = 0;

  const refill = (bucket: Bucket, at: number): void => {
    const elapsedSeconds = (at - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(options.burst, bucket.tokens + elapsedSeconds * options.rps);
    bucket.updatedAt = at;
  };

  /** Drop buckets that have refilled completely: they carry no state worth keeping. */
  const sweep = (at: number): void => {
    for (const [key, bucket] of buckets) {
      refill(bucket, at);
      if (bucket.tokens >= options.burst) buckets.delete(key);
    }
  };

  const handler = (req: Request, res: Response, next: NextFunction): void => {
    if (options.rps <= 0 || exempt.has(req.path)) {
      next();
      return;
    }

    const at = now();
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';

    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= SWEEP_THRESHOLD) sweep(at);
      bucket = { tokens: options.burst, updatedAt: at };
      buckets.set(key, bucket);
    } else {
      refill(bucket, at);
    }

    if (bucket.tokens < 1) {
      rejected++;
      const retryAfterSeconds = Math.ceil((1 - bucket.tokens) / options.rps);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        error: 'rate_limited',
        message: `Too many requests; retry in ${retryAfterSeconds}s`
      });
      return;
    }

    bucket.tokens -= 1;
    next();
  };

  return Object.assign(handler, {
    clients: () => buckets.size,
    rejected: () => rejected
  });
}
