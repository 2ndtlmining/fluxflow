/**
 * API router.
 *
 * Mounted by the server entry point in front of the SvelteKit handler, so `/api/*` and the
 * web app are served by one process on one port (#9). That removes the CORS layer, the
 * localhost special case in the browser client, and the 404 that v1 shipped because
 * `hooks.server.js` sat at the repo root where SvelteKit never compiled it.
 */

import { timingSafeEqual } from 'node:crypto';
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response
} from 'express';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { SyncService } from '../ingest/sync.js';
import type { LabelLookup } from '../labels.js';
import type { FailoverDataSource } from '../ingest/datasource/circuitbreaker.js';
import type { Db } from '../db/database.js';
import { serialiseError } from '../logger.js';
import { PERIODS, PERIOD_LABELS, isPeriodId, type PeriodId } from '../../shared/constants.js';
import {
  listFlowEvents,
  resolvePeriod,
  summariseDatabase,
  summariseFlow,
  summariseUnknowns,
  topCounterparties
} from './queries.js';

export interface ApiDependencies {
  readonly config: Config;
  readonly db: Db;
  readonly labels: LabelLookup;
  readonly dataSource: FailoverDataSource;
  readonly log: Logger;
  /** Absent when ingestion is switched off; the admin endpoints are then not registered. */
  readonly sync?: SyncService;
  /** Read by `/api/health`; kept O(1) so the Docker healthcheck is never the bottleneck. */
  readonly health: {
    startedAt: number;
    lastSuccessfulSyncAt: number | null;
    degraded(): { degraded: boolean; reason: string | null };
  };
}

/** Seconds of history for a period id. */
const PERIOD_SECONDS: Record<PeriodId, number> = {
  '24H': 24 * 60 * 60,
  '7D': 7 * 24 * 60 * 60,
  '30D': 30 * 24 * 60 * 60,
  '90D': 90 * 24 * 60 * 60,
  '6M': 180 * 24 * 60 * 60
};

/**
 * Validate a `:period` route parameter.
 *
 * The set is closed, so anything else is a 400 rather than a chance to build a query from
 * user input (#21).
 */
function parsePeriod(req: Request, res: Response): PeriodId | null {
  const raw = req.params.period;

  if (typeof raw !== 'string' || !isPeriodId(raw.toUpperCase())) {
    res.status(400).json({
      error: 'Invalid period',
      message: `Expected one of ${Object.keys(PERIODS).join(', ')}`
    });
    return null;
  }

  return raw.toUpperCase() as PeriodId;
}

export function createApiRouter(deps: ApiDependencies): Router {
  const { config, db, labels, dataSource, health, sync, log } = deps;
  const router = Router();

  // ── Health ────────────────────────────────────────────────────────────────
  /**
   * Liveness plus staleness, and nothing else.
   *
   * v1's `/api/health` called `getStats()` — five full table scans — and the Docker
   * healthcheck ran it every 30 s. Worse, it reported `ok` while sync had been silently
   * stalled for hours. This is a handful of field reads plus a timestamp comparison
   * (#3, #10).
   */
  router.get('/health', (_req: Request, res: Response) => {
    const { degraded, reason } = health.degraded();

    res.status(degraded ? 503 : 200).json({
      status: degraded ? 'degraded' : 'ok',
      uptimeSeconds: Math.round((Date.now() - health.startedAt) / 1000),
      lastSuccessfulSyncAt: health.lastSuccessfulSyncAt,
      ...(reason ? { reason } : {})
    });
  });

  // ── Status ────────────────────────────────────────────────────────────────
  router.get('/status', (_req: Request, res: Response) => {
    const database = summariseDatabase(db);
    const { degraded, reason } = health.degraded();

    res.json({
      sync: {
        enabled: config.syncEnabled,
        latestHeight: database.maxHeight,
        oldestHeight: database.minHeight,
        lastSuccessfulSyncAt: health.lastSuccessfulSyncAt,
        degraded,
        ...(reason ? { reason } : {})
      },
      ...(sync ? { ingest: sync.stats } : {}),
      database: {
        blocks: database.blocks,
        flows: database.flows,
        txDeltas: database.txDeltas,
        missingBlocks: database.missingBlocks,
        sizeBytes: database.dbSizeBytes
      },
      dataSources: {
        ...dataSource.status(),
        // Per-source detail, where a source has any. Currently the FluxNode pool (#25).
        details: Object.fromEntries(
          dataSource
            .status()
            .sources.map((source) => [source.id, dataSource.detailsFor(source.id)])
            .filter(([, detail]) => detail !== undefined)
        )
      },
      labels: labels.stats()
    });
  });

  /** Kept for the existing dashboard components, which poll this every 5 s. */
  router.get('/blocks/status', (_req: Request, res: Response) => {
    const database = summariseDatabase(db);
    const { degraded } = health.degraded();

    res.json({
      currentBlockHeight: database.maxHeight,
      blockCount: database.blocks,
      syncInProgress: false,
      syncProgress: syncProgress(database.blocks, PERIODS['6M']),
      lastSync: health.lastSuccessfulSyncAt,
      transactionCount: database.txDeltas,
      flowEventCount: database.flows,
      isAnalyzing: database.blocks < PERIODS['6M'],
      degraded
    });
  });

  router.get('/database/stats', (_req: Request, res: Response) => {
    const database = summariseDatabase(db);
    const sixMonthBlocks = PERIODS['6M'];

    res.json({
      sizeBytes: database.dbSizeBytes,
      size: formatBytes(database.dbSizeBytes),
      blocks: database.blocks,
      transactions: database.txDeltas,
      flowEvents: database.flows,
      missingBlocks: database.missingBlocks,
      blockRange: { minHeight: database.minHeight, maxHeight: database.maxHeight },
      dataSpan: database.maxHeight - database.minHeight,
      sixMonthBlockTarget: sixMonthBlocks,
      percentOfTarget: ((database.blocks / sixMonthBlocks) * 100).toFixed(1)
    });
  });

  // ── Classification ────────────────────────────────────────────────────────
  const classificationStats = (_req: Request, res: Response) => {
    const stats = labels.stats();
    res.json({
      exchanges: { count: stats.exchanges },
      foundation: { count: stats.foundation },
      nodeOperators: { count: 0, totalNodes: 0, lastRefresh: 0 },
      unknown: { count: databaseUnknownCount() }
    });
  };

  router.get('/classification/stats', classificationStats);
  router.get('/classifications/stats', classificationStats);

  function databaseUnknownCount(): number {
    return (
      db
        .prepare<[], { count: number }>(
          `SELECT COUNT(DISTINCT address) AS count FROM address_labels`
        )
        .get()?.count ?? 0
    );
  }

  router.get('/unknowns/stats', (_req: Request, res: Response) => {
    const window = resolvePeriod(db, Math.floor(Date.now() / 1000) - PERIOD_SECONDS['6M']);
    const unknowns = summariseUnknowns(db, window);

    res.json({
      ...unknowns,
      enhancementStats: [],
      totalFlowEvents: summariseDatabase(db).flows
    });
  });

  // ── Admin ─────────────────────────────────────────────────────────────────
  /*
   * Every mutating endpoint requires ADMIN_TOKEN.
   *
   * v1's `POST /api/enhance-wallets` and `/api/enhancement/background/trigger` were open to
   * anyone who could reach the port. A trigger starts a job that makes thousands of
   * outbound requests, so an unauthenticated endpoint is both a denial-of-service lever
   * and a way to point the service at someone else's infrastructure (#21).
   */
  const admin = requireAdmin(config);

  if (sync) {
    const apiLog = log.child({ component: 'admin' });

    router.post('/admin/sync', admin, (_req: Request, res: Response) => {
      void sync.runOnce().then(
        () => res.json({ success: true, stats: sync.stats }),
        (error: unknown) => {
          apiLog.error({ ...serialiseError(error) }, 'manual sync failed');
          res.status(500).json({ error: 'Sync failed', message: 'see server logs' });
        }
      );
    });

    router.post('/admin/retention', admin, (_req: Request, res: Response) => {
      sync.pruneNow();
      res.json({ success: true, prunedBlocks: sync.stats.prunedBlocks });
    });
  }

  // ── Flow analysis ─────────────────────────────────────────────────────────
  router.get('/flow/:period', (req: Request, res: Response) => {
    const period = parsePeriod(req, res);
    if (!period) return;

    const database = summariseDatabase(db);
    const requiredBlocks = PERIODS[period];
    const progress = syncProgress(database.blocks, requiredBlocks);

    if (database.blocks === 0) {
      res.json({
        period,
        ready: false,
        partial: false,
        message: 'No data available yet. Syncing blocks...',
        progress: 0,
        blocksNeeded: requiredBlocks,
        blocksSynced: 0
      });
      return;
    }

    const fromTime = Math.floor(database.maxTime - PERIOD_SECONDS[period]);
    const window = resolvePeriod(db, fromTime);
    const buying = summariseFlow(db, window, 'buying');
    const selling = summariseFlow(db, window, 'selling');

    const complete = database.blocks >= requiredBlocks;

    res.json({
      period,
      label: PERIOD_LABELS[period],
      ready: complete,
      partial: !complete,
      partialWarning: complete
        ? null
        : `Data is incomplete (${progress.toFixed(1)}% synced). Results may not be fully representative.`,
      progress,
      blocksNeeded: requiredBlocks,
      blocksSynced: database.blocks,
      blockRange: {
        newest: window.toHeight,
        oldest: window.fromHeight,
        count: buying.count + selling.count
      },
      buying: toDirection('buying', buying),
      selling: toDirection('selling', selling),
      p2p: { total: 0, count: 0 },
      netFlow: buying.totalSat - selling.totalSat
    });
  });

  /**
   * Keyset-paginated events.
   *
   * v1 shipped every event of a period to the browser — 97 MB for 30D, and a
   * `RangeError` in `JSON.stringify` at 6M (#2, #27). Events now come a page at a time.
   */
  router.get('/flow/:period/events', (req: Request, res: Response) => {
    const period = parsePeriod(req, res);
    if (!period) return;

    const database = summariseDatabase(db);
    const window = resolvePeriod(db, Math.floor(database.maxTime - PERIOD_SECONDS[period]));

    const cursor = parseCursor(req.query.cursor);

    if (req.query.cursor && !cursor) {
      res.status(400).json({ error: 'Invalid cursor', message: 'Expected height:txid:vout' });
      return;
    }

    const page = listFlowEvents(db, window, {
      ...(typeof req.query.type === 'string' ? { flowType: req.query.type } : {}),
      ...(typeof req.query.kind === 'string' ? { kind: req.query.kind } : {}),
      ...(typeof req.query.exchange === 'string' ? { exchange: req.query.exchange } : {}),
      ...(req.query.minAmount ? { minSat: Number(req.query.minAmount) } : {}),
      limit: Number(req.query.limit) || 50,
      ...(cursor ? { cursor } : {})
    });

    res.json({
      period,
      events: page.events,
      nextCursor: page.nextCursor
    });
  });

  router.get('/flow/:period/buyers', (req: Request, res: Response) => {
    const period = parsePeriod(req, res);
    if (!period) return;

    const database = summariseDatabase(db);
    const window = resolvePeriod(db, Math.floor(database.maxTime - PERIOD_SECONDS[period]));

    res.json({ buyers: topCounterparties(db, window, 'buying', Number(req.query.limit) || 10) });
  });

  router.get('/flow/:period/sellers', (req: Request, res: Response) => {
    const period = parsePeriod(req, res);
    if (!period) return;

    const database = summariseDatabase(db);
    const window = resolvePeriod(db, Math.floor(database.maxTime - PERIOD_SECONDS[period]));

    res.json({ sellers: topCounterparties(db, window, 'selling', Number(req.query.limit) || 10) });
  });

  // ── Compatibility shims ───────────────────────────────────────────────────
  // The v1 dashboard and its components still call these. The v2 intelligence worker
  // replaces them; until then they report an honest "not available" rather than pretending
  // to have run.
  router.get('/enhance-wallets/status', (_req: Request, res: Response) => {
    res.json({
      isRunning: false,
      stats: null,
      note: 'Superseded by local-data intelligence (#7, #19).'
    });
  });

  router.get('/enhancement/background/status', (_req: Request, res: Response) => {
    res.json({
      enabled: false,
      isRunning: false,
      note: 'Superseded by local-data intelligence (#7).'
    });
  });

  return router;
}

/**
 * Require a valid `ADMIN_TOKEN`.
 *
 * Compared in constant time so the endpoint cannot be used as an oracle to discover the
 * token byte by byte. When no token is configured the endpoint is refused outright rather
 * than left open — an unset secret must fail closed.
 */
export function requireAdmin(config: Config): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config.adminToken) {
      res.status(503).json({
        error: 'admin_disabled',
        message: 'ADMIN_TOKEN is not configured, so admin endpoints are disabled'
      });
      return;
    }

    const header = req.get('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    if (!safeEqual(presented, config.adminToken)) {
      // Never say which part was wrong.
      res.status(401).json({ error: 'unauthorized', message: 'Provide a valid admin token' });
      return;
    }

    next();
  };
}

function safeEqual(a: string, b: string): boolean {
  // timingSafeEqual requires equal lengths; a length mismatch is reported without
  // comparing, so the response time does not leak the token's length.
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Shape a summary into what the existing `FlowComparison` and `FlowCard` components read.
 *
 * `breakdown` keeps the v1 key names (`toNodeOperators`, `fromUnknown`, …) so the current UI
 * keeps working against the v2 API. The UI rework (#25–#33) replaces these keys.
 */
function toDirection(flowType: 'buying' | 'selling', summary: ReturnType<typeof summariseFlow>) {
  const prefix = flowType === 'buying' ? 'to' : 'from';

  const kindAmount = (kind: string): number => summary.byKind[kind] ?? 0;

  return {
    total: summary.totalSat,
    count: summary.count,
    breakdown: {
      [`${prefix}NodeOperators`]: kindAmount('node_operator'),
      [`${prefix}Unknown`]: kindAmount('unknown'),
      [`${prefix}Foundation`]: kindAmount('foundation'),
      [`${prefix}Exchanges`]: kindAmount('exchange')
    },
    byExchange: Object.fromEntries(
      summary.byExchange.map((exchange) => [
        exchange.name,
        { name: exchange.name, total: exchange.totalSat, count: exchange.count }
      ])
    ),
    // Retained for the transaction drill-down, which reads `events` off this payload.
    events: [] as unknown[]
  };
}

function parseCursor(value: unknown): { height: number; txid: string; vout: number } | null {
  if (typeof value !== 'string') return null;

  const [height, txid, vout] = value.split(':');
  const parsedHeight = Number(height);
  const parsedVout = Number(vout);

  if (!txid || !Number.isInteger(parsedHeight) || !Number.isInteger(parsedVout)) return null;

  return { height: parsedHeight, txid, vout: parsedVout };
}

function syncProgress(blocks: number, required: number): number {
  return Math.min(100, Number(((blocks / required) * 100).toFixed(1)));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Last-resort error handler.
 *
 * v1 logged errors and returned `500 { error: message }`, which leaked internal messages
 * (including file paths) to the browser. Unknown failures now return a generic message and
 * keep the detail in the log.
 */
export function errorHandler(config: Config, log: Logger) {
  return (error: unknown, _req: Request, res: Response, next: (err?: unknown) => void): void => {
    if (res.headersSent) {
      next(error);
      return;
    }

    if (error instanceof ApiError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }

    log.error({ ...serialiseError(error) }, 'unhandled api error');

    res.status(500).json({
      error: 'Internal server error',
      ...(config.isProduction
        ? {}
        : { detail: error instanceof Error ? error.message : String(error) })
    });
  };
}

/** An error that is safe to describe to the client. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string): ApiError {
    return new ApiError(400, 'bad_request', message);
  }

  static unauthorized(message = 'Missing or invalid admin token'): ApiError {
    return new ApiError(401, 'unauthorized', message);
  }

  static tooManyRequests(message = 'Too many requests'): ApiError {
    return new ApiError(429, 'rate_limited', message);
  }
}
