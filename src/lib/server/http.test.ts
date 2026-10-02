import { describe, expect, it, vi } from 'vitest';
import {
  HttpError,
  backoffDelay,
  createLimiter,
  httpJson,
  httpRequest,
  type HttpRequestOptions
} from './http';

/** Build a `Response` without touching the network. */
function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  });
}

/**
 * Wrap a handler as a `fetch` implementation.
 *
 * `globalThis.fetch` accepts `RequestInfo | URL`; narrowing to `string` keeps the mocks
 * readable while still satisfying the real signature.
 */
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>): {
  fetchImpl: typeof fetch;
  mock: ReturnType<typeof vi.fn>;
} {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {})
  );

  return { fetchImpl: mock as unknown as typeof fetch, mock };
}

/** Never actually sleep, so retry tests are instant. */
const noSleep = async (): Promise<void> => {};

/** Deterministic jitter: always the top of the backoff range. */
const alwaysMaxRandom = () => 0.999_999;

function baseOptions(overrides: Partial<HttpRequestOptions> = {}): HttpRequestOptions {
  return {
    sleep: noSleep,
    random: alwaysMaxRandom,
    timeoutMs: 1_000,
    retries: 2,
    retryBaseMs: 100,
    ...overrides
  };
}

describe('HttpError', () => {
  it('treats transport failures as retryable', () => {
    expect(
      new HttpError('boom', { url: 'https://x', cause: new Error('ECONNRESET') }).retryable
    ).toBe(true);
  });

  it('treats timeouts as retryable', () => {
    expect(new HttpError('timed out', { url: 'https://x' }).retryable).toBe(true);
  });

  it.each([408, 429, 500, 502, 503, 504])('treats HTTP %i as retryable', (status) => {
    expect(new HttpError('x', { url: 'https://x', status }).retryable).toBe(true);
  });

  it.each([400, 401, 403, 404, 410, 422])('treats HTTP %i as final', (status) => {
    expect(new HttpError('x', { url: 'https://x', status }).retryable).toBe(false);
  });

  it('reads Retry-After in seconds', () => {
    const error = new HttpError('slow down', { url: 'https://x', status: 429 });
    error.responseHeaders = new Response(null, {
      status: 429,
      headers: { 'retry-after': '30' }
    }).headers;

    expect(error.retryAfterMs()).toBe(30_000);
  });

  it('reads Retry-After as a date', () => {
    const when = new Date(Date.now() + 60_000).toUTCString();
    const error = new HttpError('slow down', { url: 'https://x', status: 503 });
    error.responseHeaders = new Response(null, {
      status: 503,
      headers: { 'retry-after': when }
    }).headers;

    const delay = error.retryAfterMs();
    expect(delay).toBeGreaterThan(50_000);
    expect(delay).toBeLessThanOrEqual(60_000);
  });

  it('ignores an unparseable Retry-After', () => {
    const error = new HttpError('x', { url: 'https://x', status: 429 });
    error.responseHeaders = new Response(null, {
      status: 429,
      headers: { 'retry-after': 'whenever' }
    }).headers;

    expect(error.retryAfterMs()).toBeUndefined();
  });

  it('exposes the url it failed on', () => {
    expect(new HttpError('x', { url: 'https://example/api' }).url).toBe('https://example/api');
  });
});

describe('backoffDelay', () => {
  it('grows exponentially', () => {
    expect(backoffDelay(1, 100, alwaysMaxRandom)).toBe(100);
    expect(backoffDelay(2, 100, alwaysMaxRandom)).toBe(200);
    expect(backoffDelay(3, 100, alwaysMaxRandom)).toBe(400);
  });

  it('caps at 30s', () => {
    expect(backoffDelay(50, 100, alwaysMaxRandom)).toBe(30_000);
  });

  it('applies full jitter, so the delay can be anywhere in [0, ceiling)', () => {
    expect(backoffDelay(3, 100, () => 0)).toBe(0);
    expect(backoffDelay(3, 100, () => 0.5)).toBe(200);
  });

  it('produces different delays for the same attempt, which is the point of jitter', () => {
    const samples = new Set(Array.from({ length: 20 }, () => backoffDelay(3, 100, Math.random)));

    expect(samples.size).toBeGreaterThan(1);
  });
});

describe('httpRequest', () => {
  it('passes an AbortSignal on every call, so no request can hang', async () => {
    const { fetchImpl } = stubFetch(async (_url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ ok: true });
    });

    await httpRequest('https://example/api', baseOptions({ fetchImpl }));

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('returns the response on success', async () => {
    const response = await httpRequest(
      'https://example/api',
      baseOptions({ fetchImpl: async () => jsonResponse({ height: 42 }) })
    );

    expect(response.status).toBe(200);
  });

  it('retries a 503 and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const response = await httpRequest('https://example/api', baseOptions({ fetchImpl }));

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 404, because the request itself is wrong', async () => {
    const fetchImpl = vi.fn(async () => new Response('missing', { status: 404 }));

    await expect(httpRequest('https://example/api', baseOptions({ fetchImpl }))).rejects.toThrow(
      /HTTP 404/
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('gives up after the configured number of retries', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));

    await expect(
      httpRequest('https://example/api', baseOptions({ fetchImpl, retries: 3 }))
    ).rejects.toThrow(/HTTP 500/);

    // 1 initial attempt + 3 retries.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('makes exactly one attempt when retries is 0', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));

    await expect(
      httpRequest('https://example/api', baseOptions({ fetchImpl, retries: 0 }))
    ).rejects.toThrow(/HTTP 500/);

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('reports each retry with the delay it is about to wait', async () => {
    const onRetry = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('a', { status: 500 }))
      .mockResolvedValueOnce(new Response('b', { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await httpRequest('https://example/api', baseOptions({ fetchImpl, onRetry }));

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, delayMs: 100 });
    expect(onRetry.mock.calls[1]?.[0]).toMatchObject({ attempt: 2, delayMs: 200 });
  });

  it('prefers Retry-After over its own backoff', async () => {
    const onRetry = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('slow down', { status: 429, headers: { 'retry-after': '7' } })
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await httpRequest('https://example/api', baseOptions({ fetchImpl, onRetry }));

    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ delayMs: 7_000 });
  });

  it('caps a server-requested Retry-After at maxDelayMs', async () => {
    const onRetry = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('slow down', { status: 429, headers: { 'retry-after': '3600' } })
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await httpRequest(
      'https://example/api',
      baseOptions({ fetchImpl, onRetry, maxDelayMs: 5_000 })
    );

    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ delayMs: 5_000 });
  });

  it('reports a timeout as a timeout, not as a generic failure', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    const fetchImpl = vi.fn(async () => {
      throw timeout;
    });

    await expect(
      httpRequest('https://example/api', baseOptions({ fetchImpl, retries: 0 }))
    ).rejects.toThrow(/timed out after 1000ms/);
  });

  it('turns a rejection into an HttpError that carries the url', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(
      httpRequest('https://example/api', baseOptions({ fetchImpl, retries: 0 }))
    ).rejects.toMatchObject({
      name: 'HttpError',
      url: 'https://example/api'
    });
  });

  it('includes a bounded snippet of the error body for debugging', async () => {
    const long = 'x'.repeat(5_000);
    const fetchImpl = vi.fn(async () => new Response(long, { status: 500 }));

    await expect(
      httpRequest('https://example/api', baseOptions({ fetchImpl, retries: 0 }))
    ).rejects.toMatchObject({ options: { bodySnippet: 'x'.repeat(500) } });
  });

  it('aborts as soon as the caller-provided signal fires', async () => {
    const controller = new AbortController();

    const { fetchImpl } = stubFetch(
      (_url, init) =>
        // A real `fetch` rejects as soon as its signal aborts; emulate that faithfully.
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
          setTimeout(() => controller.abort(), 1);
        })
    );

    await expect(
      httpRequest(
        'https://example/api',
        baseOptions({ fetchImpl, retries: 0, signal: controller.signal })
      )
    ).rejects.toThrow(/aborted/);
  });

  it('runs through the limiter when one is supplied', async () => {
    const limiter = createLimiter(1);
    const order: string[] = [];

    const makeRequest = (id: string) =>
      httpRequest(
        'https://example/api',
        baseOptions({
          limiter,
          retries: 0,
          fetchImpl: async () => {
            order.push(`start:${id}`);
            await new Promise((resolve) => setTimeout(resolve, 5));
            order.push(`end:${id}`);
            return jsonResponse({});
          }
        })
      );

    await Promise.all([makeRequest('a'), makeRequest('b')]);

    // With concurrency 1 the requests must not interleave.
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });
});

describe('httpJson', () => {
  it('parses a JSON response', async () => {
    const result = await httpJson<{ height: number }>('https://example/api', {
      ...baseOptions(),
      fetchImpl: async () => jsonResponse({ height: 7 })
    });

    expect(result).toEqual({ height: 7 });
  });

  it('fails loudly on a non-JSON response rather than returning undefined', async () => {
    await expect(
      httpJson('https://example/api', {
        ...baseOptions(),
        fetchImpl: async () => new Response('<html>502 Bad Gateway</html>', { status: 200 })
      })
    ).rejects.toThrow(/not valid JSON/);
  });

  it('serialises a json body and sets the content type', async () => {
    const { fetchImpl, mock } = stubFetch(async () => jsonResponse({ ok: true }));

    await httpJson('https://example/api', {
      ...baseOptions(),
      fetchImpl,
      json: { hello: 'world' }
    });

    const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"hello":"world"}');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
});

describe('createLimiter', () => {
  it('rejects a nonsensical concurrency', () => {
    expect(() => createLimiter(0)).toThrow(RangeError);
    expect(() => createLimiter(1.5)).toThrow(RangeError);
  });

  it('never exceeds the concurrency limit', async () => {
    const limiter = createLimiter(3);
    let inFlight = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        limiter.run(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 2));
          inFlight--;
        })
      )
    );

    expect(peak).toBe(3);
    expect(limiter.stats).toMatchObject({ concurrency: 3, active: 0, queued: 0 });
  });

  it('starts the next task as soon as a slot frees, rather than waiting for a chunk', async () => {
    const limiter = createLimiter(2);
    const finished: number[] = [];

    const task = (id: number, ms: number) =>
      limiter.run(
        () =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              finished.push(id);
              resolve();
            }, ms)
          )
      );

    const slow = task(1, 40);
    const fast = task(2, 1);
    const next = task(3, 1);

    await Promise.all([fast, next]);

    // Both fast tasks finished while the slow one was still running. v1's chunked
    // `Promise.all` barrier would have held task 3 until task 1 also completed (#5).
    expect(finished).toEqual([2, 3]);

    await slow;
    expect(limiter.stats).toMatchObject({ active: 0, queued: 0 });
  });

  it('releases its slot when the task throws', async () => {
    const limiter = createLimiter(1);

    await expect(
      limiter.run(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // A leaked slot would deadlock every later request.
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('propagates the resolved value', async () => {
    await expect(createLimiter(1).run(async () => 42)).resolves.toBe(42);
  });

  it('drains once everything queued has settled', async () => {
    const limiter = createLimiter(2);

    const work = Array.from({ length: 6 }, () =>
      limiter.run(() => new Promise<void>((resolve) => setTimeout(resolve, 3)))
    );

    await limiter.drain();
    await Promise.all(work);

    expect(limiter.stats.active).toBe(0);
  });
});
