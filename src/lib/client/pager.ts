/**
 * Keyset paging over one or more event streams, merged newest first.
 *
 * The explorer's default view is exchange flows: buying *and* selling. The API filters one
 * direction per request, so the two are fetched as separate streams and merged here in the
 * server's own order — height, then txid, then vout, all descending — which keeps "show
 * older" exact: no transfer is skipped or shown twice, however the two directions interleave.
 */

import type { EventsPage, FlowEvent } from './types';

export type PageFetcher = (cursor: string | null) => Promise<EventsPage>;

interface Stream {
  readonly fetch: PageFetcher;
  buffer: FlowEvent[];
  cursor: string | null;
  done: boolean;
}

/** Newest first, matching the API's `ORDER BY height DESC, txid DESC, vout DESC`. */
export function compareEvents(a: FlowEvent, b: FlowEvent): number {
  if (a.height !== b.height) return b.height - a.height;
  if (a.txid !== b.txid) return a.txid < b.txid ? 1 : -1;
  return b.vout - a.vout;
}

export class MergedPager {
  private readonly streams: Stream[];

  constructor(fetchers: readonly PageFetcher[]) {
    this.streams = fetchers.map((fetch) => ({ fetch, buffer: [], cursor: null, done: false }));
  }

  /** Whether `next` can return anything more. */
  get hasMore(): boolean {
    return this.streams.some((stream) => stream.buffer.length > 0 || !stream.done);
  }

  /**
   * The next `count` events across all streams.
   *
   * An event can only be placed once every stream that might still hold something newer has
   * shown its next item, so each unfinished stream is topped up to `count` before merging.
   */
  async next(count: number): Promise<FlowEvent[]> {
    await Promise.all(
      this.streams.map(async (stream) => {
        while (!stream.done && stream.buffer.length < count) {
          const page = await stream.fetch(stream.cursor);
          stream.buffer.push(...page.events);
          stream.cursor = page.nextCursor;
          stream.done = page.nextCursor === null;
        }
      })
    );

    const out: FlowEvent[] = [];
    while (out.length < count) {
      let pick: Stream | null = null;
      for (const stream of this.streams) {
        const head = stream.buffer[0];
        if (head && (!pick || compareEvents(head, pick.buffer[0]!) < 0)) pick = stream;
      }
      if (!pick) break;
      out.push(pick.buffer.shift()!);
    }

    return out;
  }
}
