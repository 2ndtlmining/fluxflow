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
import { z } from 'zod';
import {
  APPLY_MIN_CONFIDENCE,
  CONFIDENCE,
  confidenceLevel,
  parseMinConfidence
} from '../labels.js';
import type { IntelService } from '../intel/service.js';
import { decideCandidate, listCandidates } from '../intel/clusters.js';
import { foundationReport } from '../intel/foundation.js';
import { listHops, summariseHops } from '../intel/hops.js';

export interface ApiDependencies {
  readonly config: Config;
  readonly db: Db;
  readonly labels: LabelLookup;
  readonly dataSource: FailoverDataSource;
  readonly log: Logger;
  /** Absent when ingestion is switched off; the admin endpoints are then not registered. */
  readonly sync?: SyncService;
  /** Address intelligence (#18-#20, #31); absent when disabled. */
  readonly intel?: IntelService;
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
  const { config, db, labels, dataSource, health, sync, intel, log } = deps;
  const router = Router();
  // Counts and flow answers change only when a sync cycle commits (#3, #4).
  const cache = new ResponseCache(db);

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
      nodeOperators: {
        count: stats.nodeOperators,
        totalNodes: intel?.status().nodeList?.addresses ?? 0,
        lastRefresh: intel?.status().nodeList?.at ?? 0
      },
      bySource: stats.bySource,
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

  // ── Intelligence (#18-#20, #31) ──────────────────────────────────────────
  router.get('/intel/status', (_req: Request, res: Response) => {
    res.json({ labels: labels.stats(), intel: intel?.status() ?? { enabled: false } });
  });

  /** Withdrawals re-deposited into an exchange by the same wallet shortly after (#20). */
  router.get('/flow/:period/hops', (req: Request, res: Response) => {
    const period = parsePeriod(req, res);
    if (!period) return;

    cache.send(req, res, () => {
      const window = periodWindow(period);
      return {
        period,
        summary: summariseHops(db, window.fromTime, window.toTime),
        hops: listHops(db, window.fromTime, window.toTime, Number(req.query.limit) || 50)
      };
    });
  });

  /**
   * The Foundation's wallets (#31). Not response-cached: balances refresh on their own
   * schedule, and the report reads only the Foundation's few addresses.
   */
  router.get('/foundation', (req: Request, res: Response) => {
    const raw = typeof req.query.period === 'string' ? req.query.period.toUpperCase() : '30D';
    if (!isPeriodId(raw)) {
      res.status(400).json({ error: 'Invalid period', message: `Unknown period: ${raw}` });
      return;
    }

    const window = periodWindow(raw);
    res.json({
      period: raw,
      ...foundationReport(db, labels, window, intel?.foundationBalances() ?? null)
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

  const candidateKey = z.object({
    address: z.string().regex(ADDRESS_PATTERN),
    kind: z.enum(['exchange', 'foundation', 'node_operator']),
    name: z.string().max(100).default('')
  });

  router.get('/admin/labels/candidates', admin, (req: Request, res: Response) => {
    const status = z
      .enum(['pending', 'accepted', 'rejected'])
      .optional()
      .safeParse(req.query.status ?? undefined);
    if (!status.success) {
      res.status(400).json({ error: 'Invalid status' });
      return;
    }
    res.json({
      candidates: listCandidates(db, {
        ...(status.data ? { status: status.data } : {}),
        limit: Number(req.query.limit) || 100
      })
    });
  });

  router.post('/admin/labels/candidates/decide', admin, (req: Request, res: Response) => {
    const body = candidateKey
      .extend({ decision: z.enum(['accepted', 'rejected']) })
      .safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid body', issues: body.error.issues });
      return;
    }

    const { decision, ...key } = body.data;
    if (!decideCandidate(db, labels, key, decision)) {
      res.status(404).json({ error: 'No such candidate' });
      return;
    }
    res.json({ success: true, decision, queued: intel?.status().relabelQueue ?? null });
  });

  /** A manual label beats every other source; `kind: "unknown"` overrides a wrong label. */
  router.post('/admin/labels', admin, (req: Request, res: Response) => {
    const body = z
      .object({
        address: z.string().regex(ADDRESS_PATTERN),
        kind: z.enum(['exchange', 'foundation', 'node_operator', 'unknown']),
        name: z.string().max(100).optional(),
        subLabel: z.string().max(100).optional(),
        note: z.string().max(500).optional()
      })
      .safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid body', issues: body.error.issues });
      return;
    }

    const { address, kind, name, subLabel, note } = body.data;
    db.prepare(
      `INSERT INTO address_labels
         (address, kind, name, sub_label, source, confidence, evidence, updated_at)
       VALUES (?, ?, ?, ?, 'manual', 1, ?, CAST(strftime('%s','now') AS INTEGER))
       ON CONFLICT (address, kind, source) DO UPDATE SET
         name = excluded.name, sub_label = excluded.sub_label,
         evidence = excluded.evidence, updated_at = excluded.updated_at`
    ).run(
      address,
      kind,
      name ?? null,
      subLabel ?? null,
      JSON.stringify({ method: 'manual', note })
    );

    const changed = labels.refresh('manual label');
    res.json({ success: true, changed: changed.length });
  });

  router.delete('/admin/labels/:address', admin, (req: Request, res: Response) => {
    const address = parseAddress(req, res);
    if (!address) return;

    const removed = db
      .prepare(`DELETE FROM address_labels WHERE address = ? AND source = 'manual'`)
      .run(address).changes;
    const changed = labels.refresh('manual label removed');
    res.json({ success: true, removed, changed: changed.length });
  });

  if (intel) {
    router.post('/admin/intel/run', admin, (_req: Request, res: Response) => {
      void intel.runAll().then(
        (status) => res.json({ success: true, status }),
        (error: unknown) => {
          log.error({ ...serialiseError(error) }, 'intelligence run failed');
          res.status(500).json({ error: 'Intelligence run failed', message: 'see server logs' });
        }
      );
    });
  }

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
      byType: { buying: buying.byKind, selling: selling.byKind },
      ...hopAdjusted(window.fromTime, window.toTime, buying.totalSat, selling.totalSat)
    };
  }

  /**
   * Exchange hops inside the window (#20): withdrawals re-deposited by the same wallet shortly
   * after. They count as both a buy and a sell, so headline totals are also given without them.
   * Nothing is subtracted from the main figures, which stay comparable with the raw events.
   */
  function hopAdjusted(fromTime: number, toTime: number, buying: number, selling: number) {
    const hops = summariseHops(db, fromTime, toTime);
    const adjustedBuying = Math.max(0, buying - hops.buyingExcluded);
    const adjustedSelling = Math.max(0, selling - hops.sellingExcluded);
    return {
      exchangeHops: hops,
      adjusted: {
        buying: adjustedBuying,
        selling: adjustedSelling,
        netFlow: adjustedBuying - adjustedSelling
      }
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

    const cursor = parseCursor(req.query.cursor);

    if (req.query.cursor && !cursor) {
      res.status(400).json({ error: 'Invalid cursor', message: 'Expected height:txid:vout' });
      return;
    }

    cache.send(req, res, () => {
      const page = listFlowEvents(db, window, {
        ...(typeof req.query.type === 'string' ? { flowType: req.query.type } : {}),
        ...(typeof req.query.kind === 'string' ? { kind: req.query.kind } : {}),
        ...(typeof req.query.exchange === 'string' ? { exchange: req.query.exchange } : {}),
        ...(req.query.minAmount ? { minSat: Number(req.query.minAmount) } : {}),
        limit: Number(req.query.limit) || 50,
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

      const kind = req.query.kind;
      if (kind !== undefined && !LEADERBOARD_KINDS.includes(kind as LeaderboardKind)) {
        res.status(400).json({
          error: 'Invalid kind',
          message: `kind must be one of: ${LEADERBOARD_KINDS.join(', ')}`
        });
        return;
      }

      const minConfidence = parseMinConfidence(req.query.minConfidence);
      if (req.query.minConfidence !== undefined && minConfidence === null) {
        res.status(400).json({
          error: 'Invalid minConfidence',
          message: `minConfidence must be 0..1 or one of: ${Object.keys(CONFIDENCE).join(', ')}`
        });
        return;
      }

      cache.send(
        req,
        res,
        () => {
          const window = periodWindow(period);
          const limit = Math.min(Math.max(1, Number(req.query.limit) || 10), 100);
          // Over-fetch when filtering by confidence, so the filter still returns `limit` rows.
          const board = leaderboard(db, openRange(window), flowType, {
            limit: minConfidence === null ? limit : Math.min(limit * 5, 100),
            ...(kind ? { kind: kind as LeaderboardKind } : {})
          });

          const leaders = board.leaders
            .map((leader) => {
              const label = labels.labelOf(leader.address);
              return {
                ...leader,
                name: label?.name ?? null,
                confidence: label?.confidence ?? null,
                level: label ? label.level : null,
                labelSource: label?.source ?? null
              };
            })
            .filter((leader) => minConfidence === null || (leader.confidence ?? 0) >= minConfidence)
            .slice(0, limit)
            .map((leader, index) => ({ ...leader, rank: index + 1 }));

          return { period, flowType, total: board.total, minConfidence, [key]: leaders };
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

    cache.send(req, res, () => {
      const label = labels.labelOf(address);
      const cluster = db
        .prepare<[string], { clusterId: string; size: number }>(
          `SELECT cluster_id AS clusterId, size FROM address_clusters WHERE address = ?`
        )
        .get(address);

      return {
        ...profile,
        kind: label?.kind ?? 'unknown',
        name: label?.name ?? null,
        // The label that classifies this wallet's flows, and every other one on record —
        // including `possible` ones that are shown but never change a total (#19).
        label,
        labels: labels.allLabels(address).map((row) => ({
          kind: row.kind,
          name: row.name,
          subLabel: row.subLabel,
          source: row.source,
          confidence: row.confidence,
          level: confidenceLevel(row.confidence),
          applied: row.confidence >= APPLY_MIN_CONFIDENCE && row.kind !== 'unknown',
          validFrom: row.validFrom,
          validTo: row.validTo,
          evidence: row.evidence
        })),
        cluster: cluster
          ? {
              ...cluster,
              sample: db
                .prepare<[string, string], { address: string }>(
                  `SELECT address FROM address_clusters
                   WHERE cluster_id = ? AND address <> ? ORDER BY address LIMIT 10`
                )
                .all(cluster.clusterId, address)
                .map((row) => row.address)
            }
          : null,
        candidates: listCandidates(db, { address, limit: 10 }),
        recent: walletEvents(db, address, { limit: 20 })
      };
    });
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
