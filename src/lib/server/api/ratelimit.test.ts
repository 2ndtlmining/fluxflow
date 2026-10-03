import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from './ratelimit.js';

/** Just enough of Express for the middleware: an IP, a path and a recordable response. */
function call(limiter: ReturnType<typeof createRateLimiter>, ip = '10.0.0.1', path = '/flow/24H') {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    }
  };
  const next = vi.fn();

  limiter({ ip, path, socket: {} } as unknown as Request, res as unknown as Response, next);

  return { res, passed: next.mock.calls.length === 1 };
}

describe('createRateLimiter (#21)', () => {
  it('allows a burst, then refuses with 429 and Retry-After', () => {
    const limiter = createRateLimiter({ rps: 1, burst: 3, now: () => 0 });

    expect([1, 2, 3].map(() => call(limiter).passed)).toEqual([true, true, true]);

    const refused = call(limiter);
    expect(refused.passed).toBe(false);
    expect(refused.res.statusCode).toBe(429);
    expect(refused.res.headers['retry-after']).toBe('1');
    expect(limiter.rejected()).toBe(1);
  });

  it('refills at the configured rate', () => {
    let now = 0;
    const limiter = createRateLimiter({ rps: 2, burst: 2, now: () => now });

    call(limiter);
    call(limiter);
    expect(call(limiter).passed).toBe(false);

    now += 500; // half a second at 2/s is one token
    expect(call(limiter).passed).toBe(true);
    expect(call(limiter).passed).toBe(false);
  });

  it('keeps a separate bucket per client', () => {
    const limiter = createRateLimiter({ rps: 1, burst: 1, now: () => 0 });

    expect(call(limiter, '10.0.0.1').passed).toBe(true);
    expect(call(limiter, '10.0.0.1').passed).toBe(false);
    expect(call(limiter, '10.0.0.2').passed).toBe(true);
    expect(limiter.clients()).toBe(2);
  });

  it('never limits exempt paths, so monitoring cannot be throttled into an outage', () => {
    const limiter = createRateLimiter({ rps: 1, burst: 1, exempt: ['/health'], now: () => 0 });

    call(limiter);
    for (let i = 0; i < 20; i++) expect(call(limiter, '10.0.0.1', '/health').passed).toBe(true);
  });

  it('is off when the rate is 0', () => {
    const limiter = createRateLimiter({ rps: 0, burst: 1, now: () => 0 });

    for (let i = 0; i < 100; i++) expect(call(limiter).passed).toBe(true);
  });
});
