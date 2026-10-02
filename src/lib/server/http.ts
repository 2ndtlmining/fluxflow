/**
 * The one place FluxFlow makes an outbound HTTP request.
 *
 * Fixes #10. v1 passed `{ timeout: 10000 }` to `node-fetch@3`, which **removed** that
 * option and ignored it silently, so almost every call had no timeout at all. A request
 * that hangs — an overloaded indexer, a half-open TCP connection — left `syncLatest()`
 * awaiting forever: the scheduler's `isRunning` flag never cleared, every later cycle
 * logged "Previous sync still running, skipping…", and `/api/health` still reported `ok`.
 *
 * Every call here goes through `AbortSignal.timeout`, so a hung request becomes a bounded
 * failure instead of a stalled service.
 */

import { randomUUID } from 'node:crypto';

/** A non-2xx response, or a transport-level failure, with enough context to act on. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly options: {
      readonly url: string;
      readonly status?: number;
      readonly statusText?: string;
      readonly bodySnippet?: string;
      readonly cause?: unknown;
      readonly timeoutMs?: number;
    }
  ) {
    super(message, { cause: options.cause });
    this.name = 'HttpError';
  }

  get url(): string {
    return this.options.url;
  }

  get status(): number | undefined {
    return this.options.status;
  }

  /**
   * Whether retrying the *same* request could plausibly succeed.
   *
   * 4xx other than 408/429 means the request itself is wrong, so retrying just wastes
   * quota. 429 and 5xx are the server telling us to come back.
   */
  get retryable(): boolean {
    const status = this.options.status;

    if (status === undefined) return true; // transport failure: DNS, TLS, reset, timeout
    if (status === 408 || status === 429) return true;

    return status >= 500 && status < 600;
  }

  /** `Retry-After` in milliseconds, when the server sent a usable one. */
  retryAfterMs(): number | undefined {
    const header = this.retryAfterHeader;
    if (header === undefined) return undefined;

    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

    const date = Date.parse(header);
    if (Number.isNaN(date)) return undefined;

    return Math.max(0, date - Date.now());
  }

  private get retryAfterHeader(): string | undefined {
    const raw = this.responseHeaders?.get('retry-after');
    return raw ?? undefined;
  }

  /** Populated by {@link httpRequest} so {@link HttpError} can read response headers. */
  responseHeaders?: Headers;
}

export interface RetryInfo {
  /** 1 for the first retry. */
  readonly attempt: number;
  readonly delayMs: number;
  readonly error: HttpError;
}

export interface HttpRequestOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  /** `RequestInit['body']`, spelled this way because the server build has no DOM lib. */
  readonly body?: RequestInit['body'];
  /**
   * Caller-side cancellation, e.g. a shutdown signal. Combined with the timeout, so
   * either can abort the request.
   */
  readonly signal?: AbortSignal;
  /** Defaults to `config.http.timeoutMs`. */
  readonly timeoutMs?: number;
  /** Defaults to `config.http.retries`. */
  readonly retries?: number;
  /** Defaults to `config.http.retryBaseMs`. */
  readonly retryBaseMs?: number;
  /** Cap on any single backoff delay, including `Retry-After`. */
  readonly maxDelayMs?: number;
  /** Bounds how many requests may be in flight. Ingest gets its own limiter. */
  readonly limiter?: Limiter;
  /** Called before each retry, so the caller can log the transition once. */
  readonly onRetry?: (info: RetryInfo) => void;
  /** Overrides for tests. */
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable clock, so backoff is testable without real waiting. */
  readonly random?: () => number;
}

const DEFAULT_MAX_DELAY_MS = 30_000;

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Combine an optional caller signal with a mandatory timeout.
 *
 * `AbortSignal.any` keeps whichever fires first, so a hung request is always bounded even
 * when the caller passes no signal of its own.
 */
function withTimeout(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

/**
 * Exponential backoff with full jitter.
 *
 * Full jitter (a uniform pick from `[0, exp]) rather than a fixed exponential step is what
 * actually de-synchronises a fleet of clients after an outage. Without jitter, every
 * worker that failed at the same moment retries at the same moment.
 */
export function backoffDelay(attempt: number, baseMs: number, random = Math.random): number {
  const ceiling = Math.min(baseMs * 2 ** (attempt - 1), DEFAULT_MAX_DELAY_MS);
  return Math.round(ceiling * random());
}

/** One HTTP attempt. Throws {@link HttpError} on transport failure or a non-2xx status. */
async function runAttempt(
  url: string,
  options: HttpRequestOptions,
  timeoutMs: number
): Promise<Response> {
  const {
    method = 'GET',
    headers,
    body,
    signal,
    retries: _retries,
    retryBaseMs: _retryBaseMs,
    maxDelayMs: _maxDelayMs,
    limiter,
    onRetry: _onRetry,
    fetchImpl = fetch,
    sleep: _sleep,
    random: _random
  } = options;

  const run = async (): Promise<Response> => {
    let response: Response;

    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body,
        signal: withTimeout(timeoutMs, signal),
        redirect: 'follow'
      });
    } catch (cause) {
      // AbortError from the timeout is the common case here, and it is exactly the
      // failure mode #10 is about, so say so plainly.
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      const aborted = cause instanceof Error && cause.name === 'AbortError';

      throw new HttpError(
        timedOut
          ? `request timed out after ${timeoutMs}ms`
          : aborted
            ? 'request aborted'
            : `request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { url, cause, timeoutMs }
      );
    }

    if (!response.ok) {
      // Read a bounded snippet: an error body can be large, and we only log it.
      const bodySnippet = await response.text().then(
        (text) => text.slice(0, 500),
        () => undefined
      );

      const error = new HttpError(`HTTP ${response.status} ${response.statusText}`, {
        url,
        status: response.status,
        statusText: response.statusText,
        bodySnippet
      });
      error.responseHeaders = response.headers;
      throw error;
    }

    return response;
  };

  return limiter ? limiter.run(run) : run();
}

/**
 * Perform an HTTP request with a bounded timeout and retries.
 *
 * @throws {HttpError} once the retries are exhausted, or immediately for a non-retryable
 * status.
 */
export async function httpRequest(
  url: string,
  options: HttpRequestOptions = {}
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retries = options.retries ?? 2;
  const retryBaseMs = options.retryBaseMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: HttpError | undefined;

  for (let attemptNumber = 1; attemptNumber <= retries + 1; attemptNumber++) {
    try {
      return await runAttempt(url, options, timeoutMs);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      lastError = error;

      const isLastAttempt = attemptNumber === retries + 1;
      if (isLastAttempt || !error.retryable) break;

      const serverRequested = error.retryAfterMs();
      const backoff = backoffDelay(attemptNumber, retryBaseMs, random);
      const delayMs = Math.min(serverRequested ?? backoff, maxDelayMs);

      options.onRetry?.({ attempt: attemptNumber, delayMs, error });

      await sleep(delayMs);
    }
  }

  throw lastError ?? new HttpError('request failed', { url });
}

export interface HttpJsonOptions extends Omit<HttpRequestOptions, 'body'> {
  readonly json?: unknown;
}

/** Perform a request and parse the response as JSON. */
export async function httpJson<T>(url: string, options: HttpJsonOptions = {}): Promise<T> {
  const { json, headers, ...rest } = options;

  const response = await httpRequest(url, {
    ...rest,
    ...(json === undefined ? {} : { method: rest.method ?? 'POST', body: JSON.stringify(json) }),
    headers: {
      accept: 'application/json',
      ...(json === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    }
  });

  const text = await response.text();

  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new HttpError('response was not valid JSON', {
      url,
      status: response.status,
      bodySnippet: text.slice(0, 200),
      cause
    });
  }
}

/** A fresh value for `x-request-id`, so one request can be traced end to end. */
export function requestId(): string {
  return randomUUID();
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency limiting
// ─────────────────────────────────────────────────────────────────────────────

export interface LimiterStats {
  readonly concurrency: number;
  readonly active: number;
  readonly queued: number;
}

/**
 * A minimal sliding-window concurrency limiter.
 *
 * v1 chunked work into fixed groups of 10 and waited for the slowest of each group before
 * starting the next, so one slow request stalled the whole batch (#5). This keeps N
 * requests in flight at all times instead.
 *
 * Deliberately not `p-limit`: this needs to be inspectable (`stats`) and interruptible from
 * the same module that makes the requests, and it is ~40 lines.
 */
export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly stats: LimiterStats;
  /** Wait for everything queued to finish. Used on graceful shutdown. */
  drain(): Promise<void>;
}

export function createLimiter(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
  }

  let active = 0;
  const queue: (() => void)[] = [];

  const next = (): void => {
    active--;
    queue.shift()?.();
  };

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= concurrency) {
        await new Promise<void>((resolve) => queue.push(resolve));
      }

      active++;
      try {
        return await fn();
      } finally {
        next();
      }
    },

    get stats(): LimiterStats {
      return { concurrency, active, queued: queue.length };
    },

    async drain(): Promise<void> {
      while (active > 0 || queue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  };
}
