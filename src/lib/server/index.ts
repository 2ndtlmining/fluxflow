/**
 * Service assembly and lifecycle.
 *
 * One process, one port. The Express app serves `/api/*` and delegates everything else to
 * the SvelteKit handler (#9).
 */

import express, { type Express } from 'express';
import { createServer, type Server } from 'node:http';
import type { Logger } from 'pino';
import { loadDotEnv, loadConfig, describeConfig, type Config } from './config.js';
import { createLogger, fatal, serialiseError } from './logger.js';
import { initDatabase, type Db } from './db/index.js';
import { loadLabels, type LabelLookup } from './labels.js';
import { createLimiter } from './http.js';
import { BlockbookDataSource } from './ingest/datasource/blockbook.js';
import { FluxIndexerDataSource } from './ingest/datasource/fluxindexer.js';
import { FluxNodePool } from './ingest/datasource/fluxnode.js';
import { OwnNodeDataSource } from './ingest/datasource/ownnode.js';
import { FailoverDataSource } from './ingest/datasource/circuitbreaker.js';
import type { DataSource } from './ingest/datasource/types.js';
import { SyncService } from './ingest/sync.js';
import { createApiRouter, errorHandler } from './api/router.js';
import { EventLoopMonitor } from './api/metrics.js';
import { dataVersion } from './api/queries.js';
import { StreamHub } from './live/stream.js';
import { AlertService } from './live/alerts.js';
import type { FlowRow } from './ingest/derive.js';

/** How long a graceful shutdown may take before the process exits anyway. */
const SHUTDOWN_DEADLINE_MS = 10_000;

/** Sync is considered stale after this long without a successful cycle. */
const SYNC_STALE_SECONDS = 10 * 60;

export interface Service {
  readonly app: Express;
  readonly config: Config;
  readonly log: Logger;
  readonly db: Db;
  readonly labels: LabelLookup;
  readonly dataSource: FailoverDataSource;
  /** Absent when `SYNC_ENABLED=0`. */
  readonly sync: SyncService | null;
  listen(): Promise<Server>;
  close(): Promise<void>;
  /** Record a successful sync cycle, which `/api/health` reads to decide if we are stale. */
  markSyncSuccess(at?: number): void;
}

export interface CreateServiceOptions {
  /** Passed to `loadDotEnv`; tests point this at a fixture. */
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Injected for tests so no network call happens at boot. */
  readonly sources?: DataSource[];
  /**
   * Start the ingestion loop immediately.
   *
   * Tests set this to `false` to exercise the wiring — including the staleness check — and
   * then drive `service.sync.runOnce()` themselves, rather than racing a real poll.
   */
  readonly autoStartSync?: boolean;
}

/**
 * Build the data sources in preference order.
 *
 * A dedicated indexer comes first when configured: the operator chose it, it is on their
 * own LAN, and it is the fastest option available.
 *
 * Then the FluxNode pool (#35). This is what makes ingestion work at all on a public
 * deployment — the single public Blockbook instance rate-limits by IP and cannot sustain a
 * sync. The pool is spread across thousands of operator-run nodes, and it returns a whole
 * block per request instead of one request per transaction (#15).
 *
 * Blockbook is always last, so there is always something to fall back to.
 */
function buildSources(config: Config, log: Logger): DataSource[] {
  const http = {
    timeoutMs: config.http.timeoutMs,
    retries: config.http.retries,
    retryBaseMs: config.http.retryBaseMs
  };

  const sources: DataSource[] = [];

  // Your own node first: trusted, local, and not limited to the pool's courtesy rate.
  if (config.dataSources.fluxNodeUrl) {
    sources.push(new OwnNodeDataSource({ baseUrl: config.dataSources.fluxNodeUrl, http }));
    log.info({ url: config.dataSources.fluxNodeUrl }, 'own FluxNode configured as primary source');
  }

  if (config.dataSources.fluxIndexerUrl) {
    sources.push(
      new FluxIndexerDataSource({
        baseUrl: config.dataSources.fluxIndexerUrl,
        enrichConcurrency: config.sync.concurrency,
        http
      })
    );
  }

  if (config.fluxNode.enabled) {
    const pool = new FluxNodePool({
      discoveryUrl: config.fluxNode.discoveryUrl,
      poolSize: config.fluxNode.poolSize,
      probeSample: config.fluxNode.probeSample,
      maxInflightPerNode: config.fluxNode.maxInflightPerNode,
      apiPorts: config.fluxNode.apiPorts,
      discoverySeconds: config.fluxNode.discoverySeconds,
      benchSeconds: config.fluxNode.benchSeconds,
      tipTolerance: config.fluxNode.tipTolerance,
      probeTimeoutMs: config.fluxNode.probeTimeoutMs,
      spotCheckEvery: config.fluxNode.spotCheckEvery,
      http,
      log: log.child({ component: 'fluxnode-pool' })
    });

    sources.push(pool);

    log.info(
      {
        poolSize: config.fluxNode.poolSize,
        maxInflightPerNode: config.fluxNode.maxInflightPerNode,
        apiPorts: config.fluxNode.apiPorts
      },
      'FluxNode pool enabled: spreading reads across operator nodes instead of one Blockbook'
    );
  }

  sources.push(new BlockbookDataSource({ baseUrl: config.dataSources.blockbookUrl, http }));

  return sources;
}

export function createService(options: CreateServiceOptions = {}): Service {
  const cwd = options.cwd ?? process.cwd();

  loadDotEnv('.env', cwd);

  const config = loadConfig(options.env ?? process.env);
  const log = createLogger(config, { bindings: { component: 'server' } });

  // Print the effective configuration first, so a deployment that misbehaves can be
  // diagnosed from the first lines of the log.
  log.info({ config: describeConfig(config) }, 'starting fluxflow');

  if (!config.enhancementEnabled) {
    log.info(
      'no FLUX_INDEXER_URL configured: wallet enrichment is disabled, ' +
        'classification will use labels and local chain data only'
    );
  }

  const database = initDatabase({ config, log });
  const labels = loadLabels(database.db, config, log.child({ component: 'labels' }));
  log.info({ labels: labels.stats() }, 'address labels loaded');

  const limiter = createLimiter(config.sync.concurrency);
  const dataSource = new FailoverDataSource({
    sources: options.sources ?? buildSources(config, log),
    config,
    log: log.child({ component: 'datasource' }),
    limiter
  });

  // Probing runs unref'd, so it never keeps the process alive on its own.
  if (config.syncEnabled) dataSource.startProbing(60_000);

  /*
   * Declared before the sync service so the service can report into it.
   *
   * Previously nothing connected the two: `lastSuccessfulSyncAt` was only ever set by
   * `markSyncSuccess`, which no production code path calls. A service that had ingested
   * hundreds of blocks still reported `degraded: no successful sync yet` and answered
   * `/api/health` with 503 for the life of the process — so a Docker healthcheck would
   * restart a container that was working perfectly.
   */
  const health = {
    startedAt: Date.now(),
    lastSuccessfulSyncAt: null as number | null,

    /** True when sync has not completed within `SYNC_STALE_SECONDS`. */
    degraded(): { degraded: boolean; reason: string | null } {
      if (!config.syncEnabled) return { degraded: false, reason: null };
      if (health.lastSuccessfulSyncAt === null) {
        return { degraded: true, reason: 'no successful sync yet' };
      }

      const ageSeconds = (Date.now() - health.lastSuccessfulSyncAt) / 1000;
      if (ageSeconds > SYNC_STALE_SECONDS) {
        return {
          degraded: true,
          reason: `last successful sync was ${Math.round(ageSeconds)}s ago`
        };
      }

      return { degraded: false, reason: null };
    }
  };

  // ── Live updates & alerts (#32) ────────────────────────────────────────────
  const eventLoop = new EventLoopMonitor();
  const stream = new StreamHub({ maxClients: config.live.maxClients });
  const alerts = new AlertService({
    path: config.live.alertsPath,
    log: log.child({ component: 'alerts' }),
    http: { timeoutMs: config.http.timeoutMs }
  });
  alerts.reload();
  alerts.watch();

  /*
   * After every committed batch: tell stream subscribers the data changed, and push new
   * flows to the stream and the alert rules.
   *
   * Only flows from tip-following, and only recent ones. A backfill, or a forward pass
   * catching up after downtime, writes hours or months of history; announcing each of those
   * as if it had just happened would bury the one alert that matters.
   */
  const LIVE_WINDOW_SECONDS = 60 * 60;
  const onCommit = (event: {
    phase: string;
    blocks: readonly { flows: readonly FlowRow[]; time: number }[];
  }) => {
    stream.publish({
      type: 'sync',
      height: sync?.tip() ?? null,
      dataVersion: dataVersion(database.db)
    });

    if (event.phase !== 'forward') return;

    const cutoff = Date.now() / 1000 - LIVE_WINDOW_SECONDS;
    const fresh = event.blocks
      .filter((block) => block.time >= cutoff)
      .flatMap((block) => block.flows);
    if (fresh.length === 0) return;

    for (const flow of fresh) {
      if (flow.sat < config.live.flowMinSat) continue;
      stream.publish({
        type: 'flow',
        txid: flow.txid,
        vout: flow.vout,
        height: flow.height,
        time: flow.time,
        flowType: flow.flowType,
        fromAddress: flow.fromAddress,
        fromKind: flow.fromKind,
        toAddress: flow.toAddress,
        toKind: flow.toKind,
        exchange: flow.exchange,
        amount: flow.sat / 100_000_000
      });
    }

    alerts.evaluate(fresh);
  };

  const sync = config.syncEnabled
    ? new SyncService({
        config,
        db: database.db,
        labels,
        dataSource,
        log: log.child({ component: 'ingest' }),
        limiter,
        onSuccess: (at) => {
          health.lastSuccessfulSyncAt = at;
        },
        onCommit
      })
    : null;

  if (sync && options.autoStartSync !== false) sync.start();

  const app = express();

  // No CORS by default: the API and the app share an origin, so cross-origin requests are
  // the only thing CORS would permit. `ORIGIN` opts into a split deployment.
  if (config.origin) {
    log.info({ origin: config.origin }, 'allowing a cross-origin API client');
    app.use((_req, res, next) => {
      res.setHeader('access-control-allow-origin', config.origin!);
      res.setHeader('access-control-allow-headers', 'content-type, authorization');
      res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
      next();
    });
  }

  app.disable('x-powered-by');
  // Only behind a proxy the operator runs: otherwise X-Forwarded-For is client-controlled and
  // anyone could choose their own rate-limit bucket (#21).
  if (config.rateLimit.trustProxy) app.set('trust proxy', true);
  app.use('/api', express.json({ limit: '64kb' }));
  app.use(
    '/api',
    createApiRouter({
      config,
      db: database.db,
      labels,
      dataSource,
      log: log.child({ component: 'api' }),
      health,
      runtime: { stream, alerts, eventLoop },
      ...(sync ? { sync } : {})
    })
  );
  app.use('/api', errorHandler(config, log.child({ component: 'api' })));

  let server: Server | undefined;
  let closing = false;

  return {
    app,
    config,
    log,
    db: database.db,
    labels,
    dataSource,
    sync,

    async listen(): Promise<Server> {
      if (server) return server;

      server = await new Promise<Server>((resolve, reject) => {
        const created = createServer(app);

        // No request may take more than 30 s to *arrive* (#21): a slow-loris client cannot
        // hold a socket indefinitely. Responses are unaffected, so the live stream, which
        // is one long response, still works.
        created.requestTimeout = 30_000;
        created.headersTimeout = 20_000;

        const onError = (error: Error) => {
          log.error(
            { ...serialiseError(error), port: config.port, host: config.host },
            'failed to bind'
          );
          reject(error);
        };

        created.once('error', onError);
        created.listen(config.port, config.host, () => {
          created.off('error', onError);
          log.info(
            { url: `http://${config.host}:${config.port}` },
            'listening: API and web app on one port'
          );
          resolve(created);
        });
      });

      return server;
    },

    async close(): Promise<void> {
      if (closing) return;
      closing = true;

      const deadline = setTimeout(() => {
        log.error('graceful shutdown timed out, exiting anyway');
        process.exit(1);
      }, SHUTDOWN_DEADLINE_MS);
      deadline.unref();

      log.info('shutting down');

      dataSource.stopProbing();

      // Stop the loop before closing the database, otherwise an in-flight cycle would try
      // to commit against a closed handle.
      await sync?.stop();

      // Streams never end on their own, so `server.close()` would wait for them forever.
      stream.close();
      alerts.close();
      eventLoop.close();

      if (server) {
        await new Promise<void>((resolve) => {
          // close() waits for in-flight requests, which is the point: an interrupted
          // write is worse than a slightly slower restart.
          server!.close(() => resolve());
          server!.closeIdleConnections?.();
        });
      }

      await sync?.drain();
      await limiter.drain();
      // Give queued alerts a moment to go out; never let a dead webhook block shutdown.
      await Promise.race([
        alerts.drain(),
        new Promise((resolve) => setTimeout(resolve, 5_000).unref())
      ]);
      database.close();

      clearTimeout(deadline);
      log.info('shutdown complete');
    },

    /** Exposed so the ingest worker can record progress for `/api/health`. */
    markSyncSuccess(at = Date.now()): void {
      health.lastSuccessfulSyncAt = at;
      sync?.markSuccess(at);
    }
  };
}

/** Process-level signal handling. Safe to call once. */
export function installSignalHandlers(service: Service): void {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;

    service.log.info({ signal }, 'received shutdown signal');

    service
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        fatal('shutdown failed', error);
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A crash must be loud: an unhandled rejection in a background job would otherwise leave
  // the process serving stale data while looking healthy.
  process.on('unhandledRejection', (reason) => fatal('unhandled rejection', reason));

  process.on('uncaughtException', (error) => {
    fatal('uncaught exception', error);
    shutdown('SIGTERM');
  });
}
