/**
 * `/api/metrics` in the Prometheus text exposition format (#24).
 *
 * Every value here is either a counter the process already keeps or an O(1) query, so a
 * scrape every 15 s costs nothing: no table scans (#3).
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type { Db } from '../db/database.js';
import type { SyncStats } from '../ingest/sync.js';
import type { BreakerState } from '../ingest/datasource/circuitbreaker.js';

/**
 * Event-loop delay, the number that says whether a request or a write is starving the server.
 *
 * Sampled continuously and reset every minute, so the percentiles describe the recent past
 * rather than everything since boot.
 */
export class EventLoopMonitor {
  private readonly histogram: IntervalHistogram;
  private readonly reset: NodeJS.Timeout;

  constructor(resetEveryMs = 60_000) {
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
    this.reset = setInterval(() => this.histogram.reset(), resetEveryMs);
    this.reset.unref?.();
  }

  /** Milliseconds. Zeros before the first sample. */
  snapshot(): { p50: number; p99: number; max: number } {
    const ms = (ns: number) => (Number.isFinite(ns) ? Number((ns / 1e6).toFixed(2)) : 0);
    return {
      p50: ms(this.histogram.percentile(50)),
      p99: ms(this.histogram.percentile(99)),
      max: ms(this.histogram.max)
    };
  }

  close(): void {
    clearInterval(this.reset);
    this.histogram.disable();
  }
}

export interface MetricsInput {
  readonly db: Db;
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly dataVersion: number;
  readonly degraded: boolean;
  readonly sync?: SyncStats;
  readonly sources: {
    readonly active: string | undefined;
    readonly sources: readonly { id: string; state: BreakerState }[];
  };
  readonly pool?: Record<string, unknown>;
  readonly cache: { hits: number; misses: number; notModified: number };
  readonly eventLoop: { p50: number; p99: number; max: number };
  readonly stream: { clients: number; eventsSent: number };
  readonly alerts: { sent: number; failed: number; suppressed: number };
  readonly rateLimited: number;
}

/** Escape a label value per the exposition format. */
const label = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export function renderMetrics(input: MetricsInput): string {
  const lines: string[] = [];

  const metric = (
    name: string,
    type: 'counter' | 'gauge',
    help: string,
    samples: readonly { labels?: Record<string, string>; value: number }[]
  ) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const sample of samples) {
      const labels = sample.labels
        ? `{${Object.entries(sample.labels)
            .map(([key, value]) => `${key}="${label(value)}"`)
            .join(',')}}`
        : '';
      lines.push(`${name}${labels} ${Number.isFinite(sample.value) ? sample.value : 0}`);
    }
  };

  const one = (value: number) => [{ value }];

  // O(1): the rowid maximum, the page count, and a table that holds only failed heights.
  const height =
    input.db.prepare<[], { h: number | null }>(`SELECT MAX(height) AS h FROM blocks`).get()?.h ?? 0;
  const sizeBytes =
    input.db
      .prepare<[], { size: number }>(
        `SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()`
      )
      .get()?.size ?? 0;
  const missing =
    input.db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM missing_blocks`).get()?.n ?? 0;

  metric('fluxflow_info', 'gauge', 'Build information.', [
    { labels: { version: input.version }, value: 1 }
  ]);
  metric(
    'fluxflow_uptime_seconds',
    'gauge',
    'Seconds since the process started.',
    one(input.uptimeSeconds)
  );
  metric(
    'fluxflow_degraded',
    'gauge',
    '1 when sync is stale or has never succeeded.',
    one(input.degraded ? 1 : 0)
  );
  metric('fluxflow_chain_height', 'gauge', 'Highest stored block.', one(height));
  metric('fluxflow_missing_blocks', 'gauge', 'Heights queued for retry.', one(missing));
  metric('fluxflow_db_size_bytes', 'gauge', 'SQLite file size.', one(sizeBytes));
  metric(
    'fluxflow_data_version',
    'gauge',
    'Bumped whenever stored blocks change.',
    one(input.dataVersion)
  );

  if (input.sync) {
    const s = input.sync;
    metric('fluxflow_sync_cycles_total', 'counter', 'Sync cycles run.', one(s.cycles));
    metric('fluxflow_sync_blocks_total', 'counter', 'Blocks committed, by phase.', [
      { labels: { phase: 'forward' }, value: s.synced },
      { labels: { phase: 'repair' }, value: s.repaired },
      { labels: { phase: 'backfill' }, value: s.backfilled }
    ]);
    metric(
      'fluxflow_sync_failed_total',
      'counter',
      'Heights that failed to fetch or derive.',
      one(s.failed)
    );
    metric(
      'fluxflow_sync_reorged_heights_total',
      'counter',
      'Heights rolled back by reorgs.',
      one(s.reorgedHeights)
    );
    metric(
      'fluxflow_sync_pruned_blocks_total',
      'counter',
      'Blocks removed by retention.',
      one(s.prunedBlocks)
    );
    metric(
      'fluxflow_sync_blocks_per_minute',
      'gauge',
      'Recent ingest rate.',
      one(s.blocksPerMinute)
    );
    metric(
      'fluxflow_sync_last_cycle_seconds',
      'gauge',
      'Duration of the last cycle.',
      one(s.lastCycleMs / 1000)
    );
    metric(
      'fluxflow_sync_last_success_timestamp_seconds',
      'gauge',
      'When ingestion last made progress.',
      one(s.lastSuccessAt ? s.lastSuccessAt / 1000 : 0)
    );
  }

  metric(
    'fluxflow_source_state',
    'gauge',
    'Circuit-breaker state per data source (1 for the current state).',
    input.sources.sources.flatMap((source) =>
      (['closed', 'open', 'half-open'] as const).map((state) => ({
        labels: { source: source.id, state },
        value: source.state === state ? 1 : 0
      }))
    )
  );
  metric(
    'fluxflow_source_active',
    'gauge',
    '1 for the source currently serving ingestion.',
    input.sources.sources.map((source) => ({
      labels: { source: source.id },
      value: source.id === input.sources.active ? 1 : 0
    }))
  );

  if (input.pool) {
    const count = (key: string) =>
      typeof input.pool?.[key] === 'number' ? (input.pool[key] as number) : 0;
    metric('fluxflow_pool_nodes', 'gauge', 'FluxNode pool size by state.', [
      { labels: { state: 'discovered' }, value: count('discovered') },
      { labels: { state: 'serving' }, value: count('serving') },
      { labels: { state: 'insight' }, value: count('insight') }
    ]);
  }

  metric('fluxflow_api_cache_total', 'counter', 'Cached API responses by outcome.', [
    { labels: { outcome: 'hit' }, value: input.cache.hits },
    { labels: { outcome: 'miss' }, value: input.cache.misses },
    { labels: { outcome: 'not_modified' }, value: input.cache.notModified }
  ]);
  metric(
    'fluxflow_api_rate_limited_total',
    'counter',
    'Requests refused with 429.',
    one(input.rateLimited)
  );
  metric('fluxflow_event_loop_delay_seconds', 'gauge', 'Event-loop delay over the last minute.', [
    { labels: { quantile: '0.5' }, value: input.eventLoop.p50 / 1000 },
    { labels: { quantile: '0.99' }, value: input.eventLoop.p99 / 1000 },
    { labels: { quantile: '1' }, value: input.eventLoop.max / 1000 }
  ]);
  metric(
    'fluxflow_stream_clients',
    'gauge',
    'Open /api/stream subscribers.',
    one(input.stream.clients)
  );
  metric(
    'fluxflow_stream_events_total',
    'counter',
    'Live events broadcast.',
    one(input.stream.eventsSent)
  );
  metric('fluxflow_alerts_total', 'counter', 'Alert deliveries by outcome.', [
    { labels: { outcome: 'sent' }, value: input.alerts.sent },
    { labels: { outcome: 'failed' }, value: input.alerts.failed },
    { labels: { outcome: 'suppressed' }, value: input.alerts.suppressed }
  ]);

  return `${lines.join('\n')}\n`;
}
