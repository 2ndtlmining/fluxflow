import { describe, expect, it, vi } from 'vitest';
import { createLimiter, HttpError } from '../../http.js';
import type { Config } from '../../config.js';
import {
  CircuitBreaker,
  CircuitOpenError,
  FailoverDataSource,
  isWorthyOfCounting
} from './circuitbreaker';
import type { DataSource, NormalisedBlock } from './types';

/** A pino-shaped logger that records nothing, unless a test supplies its own `warn`. */
function makeSilentLog(warn: (obj: object, msg?: string) => void = () => {}): LoggerLike {
  const logger: LoggerLike = {
    debug: () => {},
    info: () => {},
    warn,
    error: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => logger
  };
  return logger;
}

interface LoggerLike {
  debug: (obj: object, msg?: string) => void;
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
  fatal: (obj: object, msg?: string) => void;
  trace: (obj: object, msg?: string) => void;
  child: (bindings: Record<string, unknown>) => LoggerLike;
}

const silentLog = makeSilentLog() as never;

/** A clock the tests advance by hand, so breaker timings need no real waiting. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

function transient(): HttpError {
  return new HttpError('boom', { url: 'https://x', status: 503 });
}

function permanent(): HttpError {
  return new HttpError('missing', { url: 'https://x', status: 404 });
}

describe('isWorthyOfCounting', () => {
  it('counts an outage-shaped failure', () => {
    expect(isWorthyOfCounting(transient())).toBe(true);
  });

  it('does not count a 404, so one bad block cannot flip the source', () => {
    expect(isWorthyOfCounting(permanent())).toBe(false);
  });

  it('does not count a programming error or an unnormalised payload', () => {
    expect(isWorthyOfCounting(new TypeError('cannot read properties of undefined'))).toBe(false);
    expect(isWorthyOfCounting(new RangeError('non-numeric amount'))).toBe(false);
    expect(isWorthyOfCounting('a string')).toBe(false);
  });
});

describe('CircuitBreaker', () => {
  it('starts closed', () => {
    expect(new CircuitBreaker({ name: 'test' }).currentState).toBe('closed');
  });

  it('stays closed below the failure threshold', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      now: clock.now
    });

    for (let i = 0; i < 2; i++) {
      await expect(breaker.execute(async () => Promise.reject(transient()))).rejects.toThrow();
    }

    expect(breaker.currentState).toBe('closed');
  });

  it('opens once the threshold is reached across separate requests', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 3, now: clock.now });

    for (let i = 0; i < 3; i++) {
      await breaker.execute(async () => Promise.reject(transient())).catch(() => {});
    }

    expect(breaker.currentState).toBe('open');
  });

  it('rejects immediately while open instead of making the request', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 1, now: clock.now });

    await breaker.execute(async () => Promise.reject(transient())).catch(() => {});

    const work = vi.fn(async () => 'never called');
    await expect(breaker.execute(work)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(work).not.toHaveBeenCalled();
  });

  it('forgets failures outside the sliding window', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      failureWindowMs: 1_000,
      now: clock.now
    });

    for (let i = 0; i < 2; i++) {
      await breaker.execute(async () => Promise.reject(transient())).catch(() => {});
    }

    clock.advance(2_000);

    for (let i = 0; i < 2; i++) {
      await breaker.execute(async () => Promise.reject(transient())).catch(() => {});
    }

    // 2 old + 2 new is below the threshold of 3, so the old failures must have aged out.
    expect(breaker.currentState).toBe('closed');
  });

  it('does not count a 404 towards opening', async () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 2 });

    for (let i = 0; i < 10; i++) {
      await breaker.execute(async () => Promise.reject(permanent())).catch(() => {});
    }

    expect(breaker.currentState).toBe('closed');
  });

  it('goes half-open once the cooldown elapses', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      openMs: 30_000,
      now: clock.now
    });

    await breaker.execute(async () => Promise.reject(transient())).catch(() => {});
    expect(breaker.currentState).toBe('open');

    clock.advance(30_000);
    expect(breaker.currentState).toBe('half-open');
  });

  it('closes again when the probe request succeeds', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      openMs: 1_000,
      now: clock.now
    });

    await breaker.execute(async () => Promise.reject(transient())).catch(() => {});
    clock.advance(1_000);

    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');
    expect(breaker.currentState).toBe('closed');
  });

  it('reopens when the probe request fails, with a longer cooldown', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      openMs: 1_000,
      openBackoffFactor: 2,
      now: clock.now
    });

    await breaker.execute(async () => Promise.reject(transient())).catch(() => {});
    clock.advance(1_000);

    await breaker.execute(async () => Promise.reject(transient())).catch(() => {});

    expect(breaker.currentState).toBe('open');
    expect(breaker.retryInMs).toBe(2_000);
  });

  it('lets only one probe through in half-open', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      openMs: 1_000,
      now: clock.now
    });

    await breaker.execute(async () => Promise.reject(transient())).catch(() => {});
    clock.advance(1_000);

    let release: () => void = () => {};
    const inFlight = breaker.execute(
      () => new Promise<string>((resolve) => (release = () => resolve('ok')))
    );

    // A second concurrent call must not slip past and be counted as a fresh success.
    await expect(breaker.execute(async () => 'should not run')).rejects.toBeInstanceOf(
      CircuitOpenError
    );

    release();
    await expect(inFlight).resolves.toBe('ok');
  });

  it('closes on a successful health probe', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      openMs: 1_000,
      now: clock.now
    });

    await breaker.execute(async () => Promise.reject(transient())).catch(() => {});
    clock.advance(1_000);

    await expect(breaker.probe(async () => true)).resolves.toBe(true);
    expect(breaker.currentState).toBe('closed');
  });

  it('stays open when the health probe reports unhealthy', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      openMs: 1_000,
      now: clock.now
    });

    await breaker.execute(async () => Promise.reject(transient())).catch(() => {});
    clock.advance(1_000);

    await expect(breaker.probe(async () => false)).resolves.toBe(false);
    expect(breaker.currentState).toBe('open');
  });

  it('never throws from a probe, even if the probe itself throws', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      openMs: 1_000,
      now: clock.now
    });

    await breaker.execute(async () => Promise.reject(transient())).catch(() => {});
    clock.advance(1_000);

    await expect(
      breaker.probe(async () => {
        throw new Error('dns exploded');
      })
    ).resolves.toBe(false);
    expect(breaker.currentState).toBe('open');
  });

  it('does not probe a source that is already closed', async () => {
    const probe = vi.fn(async () => true);
    const breaker = new CircuitBreaker({ name: 'test' });

    await expect(breaker.probe(probe)).resolves.toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it('logs one line per transition, not one per failing request', async () => {
    const warn = vi.fn();
    const clock = fakeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 2,
      now: clock.now,
      log: makeSilentLog(warn) as never
    });

    for (let i = 0; i < 20; i++) {
      await breaker.execute(async () => Promise.reject(transient())).catch(() => {});
    }

    // 20 failures, but exactly one closed -> open transition.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ from: 'closed', to: 'open', source: 'test' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failover
// ─────────────────────────────────────────────────────────────────────────────

function fakeSource(id: string, behaviour: { block: NormalisedBlock | Error }): DataSource {
  return {
    id,
    description: `fake ${id}`,
    getTip: vi.fn(async () => 100),
    getBlock: vi.fn(async () => {
      if (behaviour.block instanceof Error) throw behaviour.block;
      return behaviour.block;
    }),
    isHealthy: vi.fn(async () => true)
  };
}

function emptyBlock(height: number): NormalisedBlock {
  return { height, hash: `h${height}`, prevHash: null, time: 0, txCount: 0, transactions: [] };
}

function testConfig(): Config {
  return {
    sync: { concurrency: 4 },
    http: { timeoutMs: 1_000, retries: 1, retryBaseMs: 10 }
  } as Config;
}

function failover(sources: DataSource[], clock?: ReturnType<typeof fakeClock>): FailoverDataSource {
  return new FailoverDataSource({
    sources,
    config: testConfig(),
    log: silentLog,
    ...(clock ? { now: clock.now } : {})
  });
}

describe('FailoverDataSource', () => {
  it('uses the first source when it works', async () => {
    const primary = fakeSource('primary', { block: emptyBlock(1) });
    const backup = fakeSource('backup', { block: emptyBlock(1) });

    const result = await failover([primary, backup]).withFailover((source) => source.getBlock(1));

    expect(result.height).toBe(1);
    expect(backup.getBlock).not.toHaveBeenCalled();
  });

  it('falls over to the next source on a retryable failure', async () => {
    const primary = fakeSource('primary', { block: transient() });
    const backup = fakeSource('backup', { block: emptyBlock(7) });

    const result = await failover([primary, backup]).withFailover((source) => source.getBlock(7));

    expect(result.height).toBe(7);
  });

  it('consults the next source for a 404, but does not trip its breaker', async () => {
    const clock = fakeClock();
    const primary = fakeSource('primary', { block: permanent() });
    const backup = fakeSource('backup', { block: emptyBlock(7) });

    const registry = failover([primary, backup], clock);

    // Asking a second source for one missing block is harmless and often correct. What
    // must not happen is one 404 demoting the primary for everyone (#12).
    for (let i = 0; i < 20; i++) {
      await expect(registry.withFailover((source) => source.getBlock(7))).resolves.toMatchObject({
        height: 7
      });
    }

    expect(registry.breakerFor('primary').currentState).toBe('closed');
    expect(registry.active?.id).toBe('primary');
  });

  it('tries each source at most once', async () => {
    const a = fakeSource('a', { block: transient() });
    const b = fakeSource('b', { block: transient() });

    await expect(failover([a, b]).withFailover((s) => s.getBlock(1))).rejects.toThrow();
    expect(a.getBlock).toHaveBeenCalledTimes(1);
    expect(b.getBlock).toHaveBeenCalledTimes(1);
  });

  it('does not flap: repeated failures produce a single transition', async () => {
    const warn = vi.fn();
    const clock = fakeClock();
    const bad = fakeSource('bad', { block: transient() });
    const good = fakeSource('good', { block: emptyBlock(1) });

    const registry = new FailoverDataSource({
      sources: [bad, good],
      config: testConfig(),
      now: clock.now,
      log: makeSilentLog(warn) as never
    });

    // Ten concurrent calls all failing over at once: v1 toggled a global here and the
    // active source flipped repeatedly.
    await Promise.allSettled(
      Array.from({ length: 10 }, () => registry.withFailover((source) => source.getBlock(1)))
    );

    // Per-request "trying the next one" lines are expected; what must not happen is a
    // storm of state transitions.
    const transitions = warn.mock.calls.filter((call) => call[0]?.from !== undefined);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.[0]).toMatchObject({ from: 'closed', to: 'open' });
  });

  it('skips a source whose breaker is open', async () => {
    const clock = fakeClock();
    const bad = fakeSource('bad', { block: transient() });
    const good = fakeSource('good', { block: emptyBlock(1) });

    const registry = failover([bad, good], clock);

    for (let i = 0; i < 5; i++) {
      await registry.withFailover((source) => source.getBlock(1)).catch(() => {});
    }

    const callsBefore = (bad.getBlock as ReturnType<typeof vi.fn>).mock.calls.length;

    await registry.withFailover((source) => source.getBlock(1));

    // The open source is skipped entirely rather than retried and failed again.
    expect((bad.getBlock as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  it('switches back to the primary once it recovers', async () => {
    const clock = fakeClock();
    let primaryHealthy = false;

    const primary: DataSource = {
      id: 'primary',
      description: 'primary',
      getTip: vi.fn(async () => 1),
      getBlock: vi.fn(async () => {
        if (!primaryHealthy) throw transient();
        return emptyBlock(1);
      }),
      isHealthy: vi.fn(async () => primaryHealthy)
    };
    const backup = fakeSource('backup', { block: emptyBlock(1) });

    const registry = failover([primary, backup], clock);

    for (let i = 0; i < 5; i++) {
      await registry.withFailover((source) => source.getBlock(1)).catch(() => {});
    }
    expect(registry.active?.id).toBe('backup');

    primaryHealthy = true;
    clock.advance(60_000);

    await registry.probeAll();

    expect(registry.breakerFor('primary').currentState).toBe('closed');
    expect(registry.active?.id).toBe('primary');
  });

  it('reports a status snapshot for the API', async () => {
    const clock = fakeClock();
    const bad = fakeSource('bad', { block: transient() });
    const good = fakeSource('good', { block: emptyBlock(1) });

    const registry = failover([bad, good], clock);

    for (let i = 0; i < 5; i++) {
      await registry.withFailover((source) => source.getBlock(1)).catch(() => {});
    }

    const status = registry.status();

    expect(status.active).toBe('good');
    expect(status.sources.map((source) => source.id)).toEqual(['bad', 'good']);
    expect(status.sources.find((source) => source.id === 'bad')?.state).toBe('open');
    expect(status.sources.find((source) => source.id === 'good')?.state).toBe('closed');
  });

  it('throws a clear error when every source is unavailable', async () => {
    const a = fakeSource('a', { block: permanent() });
    const b = fakeSource('b', { block: permanent() });

    await expect(failover([a, b]).withFailover((s) => s.getBlock(1))).rejects.toMatchObject({
      status: 404
    });
  });

  it('rejects an unknown source id', () => {
    const registry = failover([fakeSource('a', { block: emptyBlock(1) })]);
    expect(() => registry.breakerFor('nope')).toThrow(/unknown data source/);
  });

  it('enforces the shared concurrency limit across sources', async () => {
    const slow = fakeSource('slow', { block: emptyBlock(1) });
    let inFlight = 0;
    let peak = 0;

    (slow.getBlock as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 3));
      inFlight--;
      return emptyBlock(1);
    });

    const registry = new FailoverDataSource({
      sources: [slow],
      config: testConfig(),
      log: silentLog,
      limiter: createLimiter(2)
    });

    await Promise.all(
      Array.from({ length: 8 }, () => registry.withFailover((source) => source.getBlock(1)))
    );

    expect(peak).toBe(2);
  });
});
