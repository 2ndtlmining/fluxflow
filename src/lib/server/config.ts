/**
 * Server configuration.
 *
 * Everything the service needs comes from the environment and is validated once, at
 * startup, by zod. Nothing here is importable from the client: this module lives under
 * `$lib/server`, which SvelteKit strips from the browser bundle.
 *
 * This replaces the hard-coded `src/lib/config.js` object (see #11), which shipped the
 * server's private indexer IP to every browser that loaded the dashboard.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Env loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load `.env` into `process.env` without overriding variables that are already set,
 * so real environment variables (Docker, systemd, CI) always win.
 *
 * Silently does nothing when the file is absent — which is the normal case in
 * production, where configuration comes from the environment itself.
 */
export function loadDotEnv(file = '.env', cwd = process.cwd()): boolean {
  const target = path.resolve(cwd, file);

  if (!existsSync(target)) return false;

  // `process.loadEnvFile` is available from Node 20.12 / 21.7 and throws only on a
  // malformed file, which we want to surface loudly.
  process.loadEnvFile(target);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coercion helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Accepts `1/true/yes/on` (case-insensitive) as true; anything else is false. */
const boolFlag = z.union([z.boolean(), z.string()]).transform((value) => {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
});

/**
 * Trim a string, mapping a blank value to `undefined`.
 *
 * This has to happen *before* the inner schema runs, otherwise `FOO=` fails with
 * "expected string, received undefined" instead of being treated as unset — which is how
 * a blank `ADMIN_TOKEN=` in a compose file or a blank `FLUX_INDEXER_URL=` in a shell
 * profile should behave.
 */
const blankToUndefined = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

const nonEmpty = (schema: z.ZodString) => z.preprocess(blankToUndefined, schema);

/** As {@link nonEmpty}, but a blank or missing value is valid and means "unset". */
const optionalNonEmpty = (schema: z.ZodString) => z.preprocess(blankToUndefined, schema.optional());

/** Strips trailing slashes so `${base}/block/1` never produces a double slash. */
const baseUrl = nonEmpty(z.string().url()).transform((value) => value.replace(/\/+$/, ''));

const optionalBaseUrl = optionalNonEmpty(z.string().url()).transform((value) =>
  value === undefined ? undefined : value.replace(/\/+$/, '')
);

const optionalToken = optionalNonEmpty(z.string());

/**
 * A comma-separated port list, e.g. `16127,16137`.
 *
 * Kept as a string in the env schema and resolved here, so a bad port is reported with the
 * variable name the operator actually set rather than as an index into an array.
 */
const portList = nonEmpty(z.string()).transform((value, ctx) => {
  const ports = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const port = Number(part);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        ctx.addIssue({
          code: 'custom',
          message: `${part} is not a valid TCP port`
        });
        return Number.NaN;
      }
      return port;
    });

  return ports;
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

const rawConfigSchema = z
  .object({
    // ── Runtime ───────────────────────────────────────────────────────────────
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    HOST: nonEmpty(z.string()).default('0.0.0.0'),
    /**
     * Only needed when the browser reaches the API from a different origin than the
     * server. Single-origin deployments (the default) need nothing here, and no CORS
     * headers are emitted at all.
     */
    ORIGIN: optionalBaseUrl,

    // ── Database ──────────────────────────────────────────────────────────────
    DATABASE_PATH: nonEmpty(z.string()).default('./data/flux-flow.db'),
    SQLITE_BUSY_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    /** Log every SQL statement. Off unless explicitly requested; never on in production. */
    DEBUG_SQL: boolFlag.default(false),

    // ── Data sources ──────────────────────────────────────────────────────────
    FLUX_NODE_POOL_URL: baseUrl.default('https://explorer.runonflux.io/api/status?q=getFluxNodes'),
    /** Optional dedicated indexer. Unset by default: no LAN addresses ship in the image. */
    FLUX_INDEXER_URL: optionalBaseUrl,
    BLOCKBOOK_URL: baseUrl.default('https://blockbook.runonflux.io'),
    FLUX_NODES_API: baseUrl.default('https://explorer.runonflux.io/api/status?q=getFluxNodes'),
    SYNC_ENABLED: boolFlag.default(true),

    // ── FluxNode pool (#35) ───────────────────────────────────────────────────
    /**
     * Spread reads across many FluxNode daemon APIs instead of one rate-limited Blockbook.
     *
     * Every FluxNode runs `fluxd` and FluxOS republishes its RPCs over HTTP, so thousands
     * of full nodes exist and the load can be spread across them. This costs the project
     * nothing and — unlike the single public Blockbook instance — is not rate-limited per
     * IP. It is also one request per block rather than one request per transaction.
     */
    FLUXNODE_POOL_ENABLED: boolFlag.default(true),
    /** How many probed nodes to keep. More nodes means faster sync and less pressure each. */
    FLUXNODE_POOL_SIZE: z.coerce.number().int().min(1).max(200).default(15),
    /** How many candidates to probe before keeping the fastest `FLUXNODE_POOL_SIZE`. */
    FLUXNODE_PROBE_SAMPLE: z.coerce.number().int().min(1).max(500).default(60),
    /**
     * Max concurrent requests **per node**.
     *
     * Deliberately small: these are operators' home connections, not our infrastructure.
     * Two in flight keeps the pipe full without being rude. FluxOS has no general HTTP rate
     * limiter, so operator goodwill is the only real limit.
     */
    FLUXNODE_MAX_INFLIGHT: z.coerce.number().int().min(1).max(8).default(2),
    /**
     * Daemon API ports to try per node. 16127 is the Flux default; UPnP deployments use
     * 16137-16197. Ports are tried in order and the first that answers is used.
     */
    FLUXNODE_API_PORTS: portList.default([16127, 16137, 16147, 16157, 16167]),
    /** How often to re-discover and re-probe the node list. */
    FLUXNODE_DISCOVERY_SECONDS: z.coerce.number().int().min(300).max(86_400).default(1_800),
    /** How long a node is benched after a timeout, 5xx, or a wrong-height answer. */
    FLUXNODE_BENCH_SECONDS: z.coerce.number().int().min(10).max(3_600).default(120),
    /** A node is discarded if its tip is this far behind the pool median. */
    FLUXNODE_TIP_TOLERANCE: z.coerce.number().int().min(0).max(100).default(2),
    /** Timeout for a liveness or capability probe. Probes must not stall a sync cycle. */
    FLUXNODE_PROBE_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
    /** Fetch every Nth block's hash from a second node to catch a node that lies. */
    FLUXNODE_SPOTCHECK_EVERY: z.coerce.number().int().min(0).max(1_000).default(25),

    // ── Sync ──────────────────────────────────────────────────────────────────
    SYNC_POLL_SECONDS: z.coerce.number().int().min(5).max(3_600).default(30),
    SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(5_000).default(250),
    SYNC_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(16),
    RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(180),
    /** How many blocks back to re-check hashes for reorgs each cycle. 0 disables. */
    REORG_CHECK_DEPTH: z.coerce.number().int().min(0).max(1_000).default(10),

    // ── Classification ────────────────────────────────────────────────────────
    LABELS_PATH: nonEmpty(z.string()).default('./config/labels.json'),
    NODE_REFRESH_SECONDS: z.coerce.number().int().min(60).max(86_400).default(600),

    // ── Outbound HTTP ─────────────────────────────────────────────────────────
    HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    HTTP_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
    HTTP_RETRY_BASE_MS: z.coerce.number().int().positive().default(500),

    // ── Observability ─────────────────────────────────────────────────────────
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),
    LOG_PRETTY: boolFlag.default(false),

    // ── Security ──────────────────────────────────────────────────────────────
    ADMIN_TOKEN: optionalToken
  })
  .superRefine((config, ctx) => {
    if (config.NODE_ENV !== 'production') return;

    // An unauthenticated dashboard lets anyone trigger syncs and enhancement jobs (#21).
    if (!config.ADMIN_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_TOKEN'],
        message:
          'ADMIN_TOKEN is required when NODE_ENV=production. Generate one with: ' +
          "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
      });
    }

    if (config.ADMIN_TOKEN && config.ADMIN_TOKEN.length < 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_TOKEN'],
        message: 'ADMIN_TOKEN must be at least 32 characters.'
      });
    }

    if (config.DEBUG_SQL) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEBUG_SQL'],
        message: 'DEBUG_SQL cannot be enabled in production: it logs every SQL statement.'
      });
    }
  });

export type RawConfig = z.infer<typeof rawConfigSchema>;

/**
 * Validated configuration, with derived values resolved once.
 */
export interface Config {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly isProduction: boolean;
  readonly isTest: boolean;

  readonly host: string;
  readonly port: number;
  /** Undefined means same-origin only: no CORS headers are sent. */
  readonly origin: string | undefined;

  readonly databasePath: string;
  readonly sqliteBusyTimeoutMs: number;
  readonly debugSql: boolean;

  /** Ordered by preference. The FluxNode pool is always available. */
  readonly dataSources: {
    readonly fluxNodePoolUrl: string;
    readonly fluxIndexerUrl: string | undefined;
    readonly blockbookUrl: string;
    readonly fluxNodesApi: string;
  };
  /** Dedicated indexer present? Gates anything that needs per-address queries (#7). */
  readonly hasDedicatedIndexer: boolean;

  /** FluxNode daemon pool (#35). */
  readonly fluxNode: {
    readonly enabled: boolean;
    /** Explorer endpoint the node list is discovered from. */
    readonly discoveryUrl: string;
    readonly poolSize: number;
    readonly probeSample: number;
    readonly maxInflightPerNode: number;
    readonly apiPorts: readonly number[];
    readonly discoverySeconds: number;
    readonly benchSeconds: number;
    readonly tipTolerance: number;
    readonly probeTimeoutMs: number;
    /** 0 disables cross-node hash verification. */
    readonly spotCheckEvery: number;
  };
  /**
   * Historical wallet analysis needs a source that can answer address queries.
   * Without an indexer the v2 intelligence layer uses local data only (coinbase node
   * rewards, clustering, hop tracing over stored txs), so this is off.
   */
  readonly enhancementEnabled: boolean;
  readonly syncEnabled: boolean;

  readonly sync: {
    readonly pollSeconds: number;
    readonly batchSize: number;
    readonly concurrency: number;
    readonly retentionDays: number;
    readonly reorgCheckDepth: number;
  };

  readonly labelsPath: string;
  readonly nodeRefreshSeconds: number;

  readonly http: {
    readonly timeoutMs: number;
    readonly retries: number;
    readonly retryBaseMs: number;
  };

  readonly log: {
    readonly level: RawConfig['LOG_LEVEL'];
    readonly pretty: boolean;
  };

  readonly adminToken: string | undefined;
}

function toConfig(raw: RawConfig): Config {
  return {
    nodeEnv: raw.NODE_ENV,
    isProduction: raw.NODE_ENV === 'production',
    isTest: raw.NODE_ENV === 'test',

    host: raw.HOST,
    port: raw.PORT,
    origin: raw.ORIGIN,

    databasePath: raw.DATABASE_PATH,
    sqliteBusyTimeoutMs: raw.SQLITE_BUSY_TIMEOUT_MS,
    // Never allow SQL logging in production, even if the env var says so.
    debugSql: raw.DEBUG_SQL && raw.NODE_ENV !== 'production',

    dataSources: {
      fluxNodePoolUrl: raw.FLUX_NODE_POOL_URL,
      fluxIndexerUrl: raw.FLUX_INDEXER_URL,
      blockbookUrl: raw.BLOCKBOOK_URL,
      fluxNodesApi: raw.FLUX_NODES_API
    },
    hasDedicatedIndexer: raw.FLUX_INDEXER_URL !== undefined,
    enhancementEnabled: raw.SYNC_ENABLED && raw.FLUX_INDEXER_URL !== undefined,
    syncEnabled: raw.SYNC_ENABLED,

    fluxNode: {
      // Only useful when we are actually syncing.
      enabled: raw.SYNC_ENABLED && raw.FLUXNODE_POOL_ENABLED,
      discoveryUrl: raw.FLUX_NODE_POOL_URL,
      poolSize: raw.FLUXNODE_POOL_SIZE,
      probeSample: raw.FLUXNODE_PROBE_SAMPLE,
      maxInflightPerNode: raw.FLUXNODE_MAX_INFLIGHT,
      apiPorts: raw.FLUXNODE_API_PORTS,
      discoverySeconds: raw.FLUXNODE_DISCOVERY_SECONDS,
      benchSeconds: raw.FLUXNODE_BENCH_SECONDS,
      tipTolerance: raw.FLUXNODE_TIP_TOLERANCE,
      probeTimeoutMs: raw.FLUXNODE_PROBE_TIMEOUT_MS,
      spotCheckEvery: raw.FLUXNODE_SPOTCHECK_EVERY
    },

    sync: {
      pollSeconds: raw.SYNC_POLL_SECONDS,
      batchSize: raw.SYNC_BATCH_SIZE,
      concurrency: raw.SYNC_CONCURRENCY,
      retentionDays: raw.RETENTION_DAYS,
      reorgCheckDepth: raw.REORG_CHECK_DEPTH
    },

    labelsPath: raw.LABELS_PATH,
    nodeRefreshSeconds: raw.NODE_REFRESH_SECONDS,

    http: {
      timeoutMs: raw.HTTP_TIMEOUT_MS,
      retries: raw.HTTP_RETRIES,
      retryBaseMs: raw.HTTP_RETRY_BASE_MS
    },

    log: {
      level: raw.LOG_LEVEL,
      // Structured JSON is the default outside development, even if LOG_PRETTY says
      // otherwise, so container logs stay machine-readable.
      pretty: raw.LOG_PRETTY && raw.NODE_ENV !== 'production'
    },

    adminToken: raw.ADMIN_TOKEN
  };
}

/** Raised when the environment is missing or malformed. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: z.ZodIssue[]
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Validate the given environment (defaults to `process.env`) and return the resolved
 * configuration.
 *
 * @throws {ConfigError} with a human-readable summary of every problem found.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = rawConfigSchema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new ConfigError(`Invalid configuration:\n${details}`, parsed.error.issues);
  }

  return toConfig(parsed.data);
}

/**
 * A loggable, secret-free view of the configuration. `ADMIN_TOKEN` is reduced to
 * whether it is set and how long it is; no URL credentials are ever printed in full if
 * they happen to contain a userinfo section.
 */
export function describeConfig(config: Config): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    listen: `${config.host}:${config.port}`,
    origin: config.origin ?? '(same-origin only)',
    databasePath: config.databasePath,
    debugSql: config.debugSql,
    syncEnabled: config.syncEnabled,
    enhancementEnabled: config.enhancementEnabled,
    dataSources: {
      fluxNodePoolUrl: config.dataSources.fluxNodePoolUrl,
      fluxIndexerUrl: config.dataSources.fluxIndexerUrl ?? '(not configured)',
      blockbookUrl: config.dataSources.blockbookUrl,
      fluxNodePool: config.fluxNode.enabled
        ? `${config.fluxNode.poolSize} nodes, ${config.fluxNode.maxInflightPerNode} in flight each`
        : '(disabled)'
    },
    sync: config.sync,
    labelsPath: config.labelsPath,
    http: config.http,
    log: config.log,
    adminToken: config.adminToken ? `(set, ${config.adminToken.length} chars)` : '(not set)'
  };
}
