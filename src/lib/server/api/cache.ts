/**
 * Response caching keyed on the stored data's version (#3, #4).
 *
 * Everything the dashboard reads changes only when a sync cycle commits. Between cycles the
 * same question has the same answer, so it is computed once: repeat requests are served from
 * memory, and a browser that already holds the answer gets `304 Not Modified` with no body.
 *
 * The version is a counter bumped by trigger whenever a block is written or removed (see
 * migration 2), so it is correct however the data changed — sync, reorg, or retention.
 */

import type { Request, Response } from 'express';
import type { Db } from '../db/database.js';
import { dataVersion, summariseDatabase, type DatabaseSummary } from './queries.js';

interface CacheEntry {
  readonly version: number;
  readonly computedAt: number;
  readonly body: string;
}

/** Plenty for every period × filter combination a dashboard actually requests. */
const DEFAULT_MAX_ENTRIES = 256;

export class ResponseCache {
  private readonly entries = new Map<string, CacheEntry>();
  private database: { version: number; value: DatabaseSummary } | null = null;

  constructor(
    private readonly db: Db,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES
  ) {}

  version(): number {
    return dataVersion(this.db);
  }

  /**
   * Row counts and bounds, recomputed at most once per data version.
   *
   * `COUNT(*)` walks a whole table; v1 ran five of them on every poll from every tab (#3).
   * Now they run once per sync cycle, whatever the number of viewers.
   */
  databaseSummary(): DatabaseSummary {
    const version = this.version();

    if (this.database?.version !== version) {
      this.database = { version, value: summariseDatabase(this.db) };
    }

    return this.database.value;
  }

  /**
   * Send `compute()`'s result as JSON, computing it at most once per data version per URL.
   *
   * The ETag is the version the body was computed at: it changes exactly when the answer can.
   *
   * `maxStaleMs` lets an expensive answer be reused across a few sync cycles. A 6-month
   * leaderboard does not change meaningfully every 30 seconds, and recomputing it on every
   * cycle would block the event loop each time (#2).
   */
  send(
    req: Request,
    res: Response,
    compute: () => unknown,
    options: { maxStaleMs?: number } = {}
  ): void {
    const version = this.version();
    const key = req.originalUrl;
    const hit = this.entries.get(key);
    const now = Date.now();

    const reusable =
      hit !== undefined &&
      (hit.version === version || now - hit.computedAt < (options.maxStaleMs ?? 0));

    // Revalidate every time: cheap (a 304 has no body), and never stale beyond maxStaleMs.
    res.setHeader('Cache-Control', 'no-cache');

    let entry: CacheEntry;
    if (reusable) {
      entry = hit;
      // Re-insert so the Map's insertion order doubles as least-recently-used order.
      this.entries.delete(key);
    } else {
      entry = { version, computedAt: now, body: JSON.stringify(compute()) };
    }

    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }

    const etag = `W/"${entry.version}"`;
    res.setHeader('ETag', etag);

    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    res.type('application/json').send(entry.body);
  }
}
