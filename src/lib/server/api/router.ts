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
import { z } from 'zod';
import { serialiseError } from '../logger.js';
import type { StreamHub } from '../live/stream.js';
import type { AlertService } from '../live/alerts.js';
import { createRateLimiter } from './ratelimit.js';
import { renderMetrics, type EventLoopMonitor } from './metrics.js';
import { PERIODS, PERIOD_LABELS, isPeriodId, type PeriodId } from '../../shared/constants.js';
import {
  flowSeries,
  listFlowEvents,
  openRange,
  previousRange,
  resolvePeriod,
  summariseFlow,
  summariseFlowRange,
  summariseUnknowns
} from './queries.js';
import {
  ADDRESS_PATTERN,
  LEADERBOARD_KINDS,
  leaderboard,
  search,
  walletEvents,
  walletProfile,
  type LeaderboardKind
} from './wallets.js';
import { ResponseCache } from './cache.js';

export interface ApiDependencies {
  readonly config: Config;
  readonly db: Db;
  readonly labels: LabelLookup;
  readonly dataSource: FailoverDataSource;
  readonly log: Logger;
  /** Absent when ingestion is switched off; the admin endpoints are then not registered. */
  readonly sync?: SyncService;
  /** Live updates, alerts and runtime telemetry; absent pieces are simply not served. */
  readonly runtime?: {
    readonly stream?: StreamHub;
    readonly alerts?: AlertService;
    readonly eventLoop?: EventLoopMonitor;
  };
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
/**
 * How long a long-period leaderboard may be reused across sync cycles.
 *
 * Even on the per-wallet rollups, an exact top-N must group every wallet active in the
 * window: on a synthetic 6-month database with ~19,000 distinct sellers that is ~110 ms
 * (30 days: ~50 ms). Over a long period the ranking barely moves in a few minutes, so it is
 * recomputed at most every 10 minutes instead of on every sync; 7 days and shorter stay live.
 */
function leaderboardStaleness(period: PeriodId): { maxStaleMs: number } {
  return { maxStaleMs: PERIOD_SECONDS[period] > 7 * 86_400 ? 10 * 60_000 : 0 };
}

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
  const { config, db, labels, dataSource, health, sync, log, runtime } = deps;
  const router = Router();
  // Counts and flow answers change only when a sync cycle commits (#3, #4).
  const cache = new ResponseCache(db);

  // Monitoring and the live stream are exempt: a healthcheck must never be throttled into
  // reporting the service down, and a stream is one long request, not many (#21).
  const rateLimiter = createRateLimiter({
    rps: config.rateLimit.rps,
    burst: config.rateLimit.burst,
    exempt: ['/health', '/status', '/metrics', '/stream']
  });
  router.use(rateLimiter);

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
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - health.startedAt) / 1000),
      lastSuccessfulSyncAt: health.lastSuccessfulSyncAt,
      ...(reason ? { reason } : {})
    });
  });

  // ── Status ────────────────────────────────────────────────────────────────
  router.get('/status', (_req: Request, res: Response) => {
    const database = cache.databaseSummary();
    const { degraded, reason } = health.degraded();

    res.json({
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - health.startedAt) / 1000),
      sync: {
        enabled: config.syncEnabled,
        latestHeight: database.maxHeight,
        oldestHeight: database.minHeight,
        lastSuccessfulSyncAt: health.lastSuccessfulSyncAt,
        degraded,
        ...(reason ? { reason } : {})
      },
      ...(sync ? { ingest: sync.stats } : {}),
      runtime: {
        eventLoopDelayMs: runtime?.eventLoop?.snapshot() ?? null,
        streamClients: runtime?.stream?.size ?? 0,
        alerts: runtime?.alerts?.stats() ?? null
      },
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
    const database = cache.databaseSummary();
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
    const database = cache.databaseSummary();
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
      totalFlowEvents: cache.databaseSummary().flows
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

    /*
     * Starts a cycle and answers at once. Waiting for it held the request open for as long
     * as a full batch takes - minutes against a slow source (#21). Repeated calls are
     * harmless: `runOnce` joins the cycle already in flight rather than starting another.
     */
    router.post('/admin/sync', admin, (_req: Request, res: Response) => {
      void sync.runOnce().catch((error: unknown) => {
        apiLog.error({ ...serialiseError(error) }, 'manual sync failed');
      });
      res.status(202).json({ accepted: true, stats: sync.stats });
    });

    router.post('/admin/retention', admin, (_req: Request, res: Response) => {
      sync.pruneNow();
      res.json({ success: true, prunedBlocks: sync.stats.prunedBlocks });
    });
  }

  if (runtime?.alerts) {
    const alerts = runtime.alerts;
    router.post('/admin/alerts/reload', admin, (_req: Request, res: Response) => {
      res.json(alerts.reload());
    });
  }

  // ── Metrics (#24) ─────────────────────────────────────────────────────────
  router.get('/metrics', (_req: Request, res: Response) => {
    const pool = dataSource.detailsFor('fluxnode-pool');

    res.type('text/plain; version=0.0.4').send(
      renderMetrics({
        db,
        version: config.version,
        uptimeSeconds: Math.round((Date.now() - health.startedAt) / 1000),
        dataVersion: cache.version(),
        degraded: health.degraded().degraded,
        ...(sync ? { sync: sync.stats } : {}),
        sources: dataSource.status(),
        ...(pool ? { pool } : {}),
        cache: cache.counters,
        eventLoop: runtime?.eventLoop?.snapshot() ?? { p50: 0, p99: 0, max: 0 },
        stream: {
          clients: runtime?.stream?.size ?? 0,
          eventsSent: runtime?.stream?.eventsSent ?? 0
        },
        alerts: runtime?.alerts?.stats() ?? { sent: 0, failed: 0, suppressed: 0 },
        rateLimited: rateLimiter.rejected()
      })
    );
  });

  // ── Live stream (#32) ─────────────────────────────────────────────────────
  if (runtime?.stream) router.get('/stream', runtime.stream.subscribe);

  // ── Flow analysis ─────────────────────────────────────────────────────────
  router.get('/flow/:period', (req: Request, res: Response) => {
    const period = parsePeriod(req, res);
    if (!period) return;

    cache.send(req, res, () => flowSummary(period));
  });

  function flowSummary(period: PeriodId): unknown {
    const database = cache.databaseSummary();
    const requiredBlocks = PERIODS[period];
    const progress = syncProgress(database.blocks, requiredBlocks);

    if (database.blocks === 0) {
      return {
        period,
        ready: false,
        partial: false,
        message: 'No data available yet. Syncing blocks...',
        progress: 0,
        blocksNeeded: requiredBlocks,
        blocksSynced: 0
      };
    }

    const fromTime = Math.floor(database.maxTime - PERIOD_SECONDS[period]);
    const window = resolvePeriod(db, fromTime);
    const buying = summariseFlow(db, window, 'buying');
    const selling = summariseFlow(db, window, 'selling');

    // The equally long window just before this one, for "vs previous period" deltas (#28).
    const before = previousRange(openRange(window));
    const previousBuying = summariseFlowRange(db, before, 'buying');
    const previousSelling = summariseFlowRange(db, before, 'selling');

    const complete = database.blocks >= requiredBlocks;

    return {
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
      netFlow: buying.totalSat - selling.totalSat,
      previousPeriod: {
        from: before.fromTime,
        to: before.toTime,
        buying: { total: previousBuying.totalSat, count: previousBuying.count },
        selling: { total: previousSelling.totalSat, count: previousSelling.count },
        netFlow: previousBuying.totalSat - previousSelling.totalSat,
        byKind: { buying: previousBuying.byKind, selling: previousSelling.byKind }
      },
      byType: { buying: buying.byKind, selling: selling.byKind }
    };
  }

  /**
   * Keyset-paginated events.
   *
   * v1 shipped every event of a period to the browser — 97 MB for 30D, and a
   * `RangeError` in `JSON.stringify` at 6M (#2, #27). Events now come a page at a time.
   */
  router.get('/flow/:period/events', (req: Request, res: Response) => {
    const period = parsePeriod(req, res);
    if (!period) return;

    const database = cache.databaseSummary();
    const window = resolvePeriod(db, Math.floor(database.maxTime - PERIOD_SECONDS[period]));

    const query = parseQuery(eventsQuery, req, res);
    if (!query) return;

    const cursor = query.cursor === undefined ? null : parseCursor(query.cursor);

    if (query.cursor !== undefined && !cursor) {
      res.status(400).json({ error: 'Invalid cursor', message: 'Expected height:txid:vout' });
      return;
    }

    cache.send(req, res, () => {
      const page = listFlowEvents(db, window, {
        ...(query.type ? { flowType: query.type } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.exchange ? { exchange: query.exchange } : {}),
        ...(query.minAmount !== undefined ? { minSat: query.minAmount } : {}),
        limit: query.limit,
        ...(cursor ? { cursor } : {})
      });

      return { period, events: page.events, nextCursor: page.nextCursor };
    });
  });

  /**
   * Leaderboards: who withdrew from (buyers) or deposited to (sellers) exchanges (#28).
   *
   * Served from the per-wallet rollups; see {@link leaderboardStaleness} for long periods.
   * `?kind=` narrows to one counterparty type.
   */
  const leaderboardRoute =
    (flowType: 'buying' | 'selling', key: 'buyers' | 'sellers') =>
    (req: Request, res: Response) => {
      const period = parsePeriod(req, res);
      if (!period) return;
      const query = parseQuery(leaderboardQuery, req, res);
      if (!query) return;

      const kind = req.query.kind;
      if (kind !== undefined && !LEADERBOARD_KINDS.includes(kind as LeaderboardKind)) {
        res.status(400).json({
          error: 'Invalid kind',
          message: `kind must be one of: ${LEADERBOARD_KINDS.join(', ')}`
        });
        return;
      }

      cache.send(
        req,
        res,
        () => {
          const window = periodWindow(period);
          const board = leaderboard(db, openRange(window), flowType, {
            limit: query.limit,
            ...(kind ? { kind: kind as LeaderboardKind } : {})
          });

          return {
            period,
            flowType,
            total: board.total,
            [key]: board.leaders.map((leader) => ({
              ...leader,
              name: labels.nameOf(leader.address)
            }))
          };
        },
        leaderboardStaleness(period)
      );
    };

  router.get('/flow/:period/buyers', leaderboardRoute('buying', 'buyers'));
  router.get('/flow/:period/sellers', leaderboardRoute('selling', 'sellers'));

  /**
   * Net flow over time (#29): hourly buckets up to 7 days, daily beyond, from the rollups.
   * `?exchange=` and `?kind=` filter both directions.
   */
  router.get('/flow/:period/series', (req: Request, res: Response) => {
    const period = parsePeriod(req, res);
    if (!period) return;

    const exchange = optionalText(req.query.exchange, 64);
    const kind = req.query.kind;
    if (exchange === null || (kind !== undefined && !SERIES_KINDS.includes(String(kind)))) {
      res.status(400).json({ error: 'Invalid filter', message: 'Check exchange and kind' });
      return;
    }

    cache.send(req, res, () => {
      const bucketSeconds = PERIOD_SECONDS[period] <= 7 * 86_400 ? 3_600 : 86_400;
      return {
        period,
        bucketSeconds,
        points: flowSeries(db, periodWindow(period), {
          bucketSeconds,
          ...(exchange ? { exchange } : {}),
          ...(kind ? { kind: String(kind) } : {})
        })
      };
    });
  });

  // ── Wallets (#30) ─────────────────────────────────────────────────────────
  const searchRoute = (req: Request, res: Response) => {
    const q = optionalText(req.query.q, 64);
    if (!q || q.trim().length < 2) {
      res.status(400).json({ error: 'Invalid query', message: 'q must be 2-64 characters' });
      return;
    }

    cache.send(req, res, () => ({
      query: q,
      results: search(db, q, Number(req.query.limit) || 10).map((result) =>
        result.type === 'wallet'
          ? {
              ...result,
              name: result.name ?? labels.nameOf(result.address),
              kind: labels.kindOf(result.address)
            }
          : result
      )
    }));
  };

  // Registered before `/wallets/:address`, which would otherwise capture "search".
  router.get('/wallets/search', searchRoute);
  router.get('/search', searchRoute);

  router.get('/wallets/:address', (req: Request, res: Response) => {
    const address = parseAddress(req, res);
    if (!address) return;

    const profile = walletProfile(db, address);
    if (!profile) {
      res.status(404).json({ error: 'Not found', message: 'No stored activity for this address' });
      return;
    }

    cache.send(req, res, () => ({
      ...profile,
      kind: labels.kindOf(address),
      name: labels.nameOf(address),
      recent: walletEvents(db, address, { limit: 20 })
    }));
  });

  router.get('/wallets/:address/events', (req: Request, res: Response) => {
    const address = parseAddress(req, res);
    if (!address) return;

    const cursor = parseCursor(req.query.cursor);
    if (req.query.cursor && !cursor) {
      res.status(400).json({ error: 'Invalid cursor', message: 'Expected height:txid:vout' });
      return;
    }

    const type = req.query.type;
    if (type !== undefined && !['buying', 'selling', 'p2p'].includes(String(type))) {
      res
        .status(400)
        .json({ error: 'Invalid type', message: 'type must be buying, selling or p2p' });
      return;
    }

    cache.send(req, res, () => ({
      address,
      ...walletEvents(db, address, {
        limit: Number(req.query.limit) || 50,
        ...(cursor ? { cursor } : {}),
        ...(type ? { flowType: String(type) } : {})
      })
    }));
  });

  /** A period's window, ending at the newest stored block. */
  function periodWindow(period: PeriodId) {
    const database = cache.databaseSummary();
    return resolvePeriod(db, Math.floor(database.maxTime - PERIOD_SECONDS[period]));
  }

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

/** Counterparty kinds the series can be filtered by (the exchange side is implied). */
const SERIES_KINDS: readonly string[] = ['unknown', 'node_operator', 'foundation', 'exchange'];

/**
 * A bounded optional text query parameter: `undefined` when absent, `null` when present
 * but not a short plain string (repeated parameters arrive as arrays).
 */
function optionalText(value: unknown, maxLength: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return null;
  return value;
}

/** Validate an `:address` route parameter (#21): anything else is a 400, never a query. */
function parseAddress(req: Request, res: Response): string | null {
  const address = req.params.address;
  if (typeof address !== 'string' || !ADDRESS_PATTERN.test(address)) {
    res.status(400).json({
      error: 'Invalid address',
      message: 'Expected a FLUX transparent address (t1… or t3…, 35 characters)'
    });
    return null;
  }
  return address;
}

// ── Query validation (#21) ───────────────────────────────────────────────────
/*
 * Every query parameter is parsed against a closed schema. Bad values are a 400 with the
 * reason, not silently coerced: `Number('abc') || 50` used to turn garbage into a default
 * and hide the client's bug.
 */
const ADDRESS_KINDS = ['exchange', 'foundation', 'node_operator', 'unknown'] as const;

const eventsQuery = z.object({
  type: z.enum(['buying', 'selling', 'p2p']).optional(),
  kind: z.enum(ADDRESS_KINDS).optional(),
  exchange: z.string().min(1).max(64).optional(),
  minAmount: z.coerce.number().min(0).max(1e10).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().max(200).optional()
});

const leaderboardQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10)
});

function parseQuery<T extends z.ZodTypeAny>(
  schema: T,
  req: Request,
  res: Response
): z.infer<T> | null {
  const parsed = schema.safeParse(req.query);

  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid query',
      issues: parsed.error.issues.map((issue) => ({
        parameter: issue.path.join('.'),
        message: issue.message
      }))
    });
    return null;
  }

  return parsed.data as z.infer<T>;
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

    /*
     * Errors raised by Express middleware describing a bad *request* — body-parser's 413 for
     * an oversized body, 400 for malformed JSON — carry their status. They are the client's
     * fault, so they are answered as such rather than logged as a server failure (#21).
     */
    const status = (error as { status?: unknown; type?: unknown } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const type = (error as { type?: unknown }).type;
      res.status(status).json({
        error: typeof type === 'string' ? type : 'bad_request',
        message: error instanceof Error ? error.message : 'Bad request'
      });
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
