/**
 * Structured logging.
 *
 * Replaces the emoji-prefixed `console.log` calls scattered through the codebase (#24).
 * Every log line is a single JSON object in production, so a container log aggregator can
 * index on `level`, `component`, `event` or any binding attached to a child logger.
 */

import { createRequire } from 'node:module';
import pino, { type Logger, type LoggerOptions } from 'pino';
import type { Config } from './config.js';

// `require` is not available in ESM, but `createRequire` gives us the resolver we need to
// probe for an optional dependency without importing it.
const requireFrom = createRequire(import.meta.url);

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

/** Keys whose values must never reach a log sink. */
const redactPaths = [
  'adminToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  '*.adminToken'
];

/**
 * `pino-pretty` is a development-only dependency. When it is not installed we fall back to
 * structured JSON rather than failing to boot, so a production image built with
 * `--omit=dev` still starts with `LOG_PRETTY=1` set.
 */
function resolveTransport(pretty: boolean): LoggerOptions['transport'] | undefined {
  if (!pretty) return undefined;

  try {
    requireFrom.resolve('pino-pretty');
  } catch {
    return undefined;
  }

  // pino loads the transport in a worker thread, so the module id is enough here.
  return {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' }
  };
}

export interface LoggerOptionsInput {
  /** Bindings attached to every line, e.g. `{ component: 'ingest' }`. */
  bindings?: Record<string, unknown>;
  /**
   * Where log lines go. Defaults to stdout. Tests pass a synchronous in-memory stream so
   * output can be asserted without racing the write buffer.
   */
  destination?: pino.DestinationStream;
}

/**
 * Create the root logger.
 *
 * Call once from the server entry point and derive scoped loggers with
 * {@link createChildLogger} rather than constructing new ones.
 */
export function createLogger(config: Config, options: LoggerOptionsInput = {}): Logger {
  const transport = resolveTransport(config.log.pretty);

  const loggerOptions: LoggerOptions = {
    level: config.log.level,
    base: { service: 'fluxflow', ...options.bindings },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: redactPaths, censor: '[redacted]' },
    formatters: {
      // Drop empty bindings so log lines stay compact.
      bindings(bindings) {
        return Object.fromEntries(Object.entries(bindings).filter(([, v]) => v !== undefined));
      }
    },
    // A transport (pretty printing) takes ownership of the stream, so an explicit
    // destination and a transport are mutually exclusive.
    ...(transport ? { transport } : {})
  };

  // pino takes the destination as a positional argument, not as an option.
  return options.destination ? pino(loggerOptions, options.destination) : pino(loggerOptions);
}

/**
 * Derive a logger that tags every line with additional bindings.
 *
 * ```ts
 * const log = createChildLogger(root, { component: 'ingest' });
 * log.info({ height, ms }, 'block committed');
 * ```
 */
export function createChildLogger(parent: Logger, bindings: Record<string, unknown>): Logger {
  return parent.child(bindings);
}

/**
 * Emit a fatal line without needing a configured logger.
 *
 * Used only by the process entry points, for failures that happen *before* the config is
 * valid — a config error, or a port that will not bind. Writes straight to stderr so it
 * cannot be lost in a stdout pipe, and so it is exempt from the `no-console` rule without a
 * blanket disable.
 */
export function fatal(message: string, error?: unknown): void {
  const line = JSON.stringify({
    level: 60,
    time: new Date().toISOString(),
    service: 'fluxflow',
    msg: message,
    ...(error === undefined ? {} : serialiseError(error))
  });

  process.stderr.write(`${line}\n`);
}

/**
 * Normalise an unknown thrown value into something loggable.
 *
 * `Error` instances keep their name, message, stack and — recursively — their `cause`,
 * because the most useful thing about a failed fetch or a failed migration is what it was
 * a failure *of*. Anything that is not an `Error` is stringified so it is not silently
 * dropped as `[object Object]`.
 */
export function serialiseError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
        ...(error.cause === undefined ? {} : { cause: serialiseError(error.cause).error })
      }
    };
  }

  return { error: { message: String(error) } };
}
