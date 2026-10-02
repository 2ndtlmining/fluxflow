import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createChildLogger, createLogger, serialiseError } from './logger.js';

function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({ NODE_ENV: 'test', LOG_PRETTY: '0', ...overrides });
}

/**
 * An in-memory log sink.
 *
 * Intercepting `process.stdout.write` instead would race pino's write buffer and make the
 * assertions intermittently see nothing, so tests write into a stream they own.
 */
function memoryDestination() {
  const lines: string[] = [];

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    }
  });

  return {
    lines,
    stream,
    /** Let the stream finish any pending write before assertions run. */
    async settle(): Promise<void> {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

describe('createLogger', () => {
  let sink: ReturnType<typeof memoryDestination>;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    sink = memoryDestination();
    logger = createLogger(testConfig(), { destination: sink.stream });
  });

  afterEach(() => {
    logger.flush();
  });

  async function parseLast(): Promise<Record<string, unknown>> {
    await sink.settle();
    return JSON.parse(sink.lines.at(-1) ?? '') as Record<string, unknown>;
  }

  it('writes one JSON object per line, tagged with the service name', async () => {
    logger.info({ height: 42 }, 'block committed');

    expect(await parseLast()).toMatchObject({
      level: 30,
      service: 'fluxflow',
      height: 42,
      msg: 'block committed'
    });
  });

  it('stamps each line with an ISO timestamp', async () => {
    logger.info('hello');

    expect((await parseLast()).time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('attaches bindings passed to the constructor', async () => {
    createLogger(testConfig(), {
      destination: sink.stream,
      bindings: { component: 'ingest' }
    }).info('starting');

    expect(await parseLast()).toMatchObject({ component: 'ingest' });
  });

  it('lets a child logger add bindings without changing the parent', async () => {
    createChildLogger(logger, { component: 'ingest', batch: 7 }).info('syncing');

    expect(await parseLast()).toMatchObject({ component: 'ingest', batch: 7 });

    logger.info('plain');
    expect(await parseLast()).not.toHaveProperty('component');
  });

  it('honours LOG_LEVEL', async () => {
    const quiet = createLogger(testConfig({ LOG_LEVEL: 'error' }), { destination: sink.stream });

    quiet.debug('invisible');
    quiet.info('also invisible');
    quiet.error('visible');

    await sink.settle();
    const output = sink.lines.join('');

    expect(output).not.toContain('invisible');
    expect(output).toContain('visible');
  });

  it('drops undefined bindings instead of emitting nulls', async () => {
    createChildLogger(logger, { component: 'ingest', batch: undefined }).info('hello');

    expect(await parseLast()).not.toHaveProperty('batch');
  });

  it('stays structured JSON in production even when LOG_PRETTY is set', async () => {
    const production = createLogger(
      testConfig({ NODE_ENV: 'production', LOG_PRETTY: '1', ADMIN_TOKEN: 'a'.repeat(32) }),
      { destination: sink.stream }
    );

    production.info('hello');
    await sink.settle();

    // A pino transport would bypass the supplied stream, so this also proves production
    // never silently enables pretty printing.
    expect(sink.lines).toHaveLength(1);
    expect(() => JSON.parse(sink.lines[0] ?? '')).not.toThrow();
  });

  it('never writes the admin token, even if it is bound as a field', async () => {
    createChildLogger(logger, { adminToken: 'super-secret-token-value' }).info('oops');

    expect(sink.lines.join('')).not.toContain('super-secret-token-value');
    expect((await parseLast()).adminToken).toBe('[redacted]');
  });
});

describe('serialiseError', () => {
  it('keeps the name, message and stack of an Error', () => {
    const result = serialiseError(new TypeError('bad input')) as {
      error: { name: string; message: string; stack: string };
    };

    expect(result.error.name).toBe('TypeError');
    expect(result.error.message).toBe('bad input');
    expect(result.error.stack).toContain('TypeError');
  });

  it('nests the cause instead of stringifying it to "Error: ..."', () => {
    const result = serialiseError(new Error('fetch failed', { cause: new Error('ETIMEDOUT') })) as {
      error: { cause: { name: string; message: string } };
    };

    expect(result.error.cause).toMatchObject({ name: 'Error', message: 'ETIMEDOUT' });
  });

  it('stringifies non-Error causes', () => {
    const result = serialiseError(new Error('wrapped', { cause: 'a string reason' })) as {
      error: { cause: { message: string } };
    };

    expect(result.error.cause.message).toBe('a string reason');
  });

  it('stringifies non-Error throws instead of logging [object Object]', () => {
    expect(serialiseError('plain string')).toEqual({ error: { message: 'plain string' } });
    expect(serialiseError(42)).toEqual({ error: { message: '42' } });
  });

  it('handles null and undefined', () => {
    expect(serialiseError(null)).toEqual({ error: { message: 'null' } });
    expect(serialiseError(undefined)).toEqual({ error: { message: 'undefined' } });
  });

  it('omits cause entirely when there is none', () => {
    expect(serialiseError(new Error('no cause'))).not.toHaveProperty('error.cause');
  });
});
