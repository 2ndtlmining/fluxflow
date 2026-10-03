/**
 * Server-Sent Events for live dashboard updates (#32).
 *
 * After each committed sync cycle the hub broadcasts a `sync` event (new tip, data version),
 * and a `flow` event for every new flow above `LIVE_FLOW_MIN_FLUX`. A browser holding the
 * stream refetches only when something changed, instead of polling on a timer — and the
 * data version in the event matches the ETag the API sends, so that refetch is cheap.
 *
 * SSE rather than WebSockets: one-way, plain HTTP, reconnects on its own in the browser,
 * and nothing to negotiate through a reverse proxy.
 */

import type { Request, Response } from 'express';

export type LiveEvent =
  | { readonly type: 'sync'; readonly height: number | null; readonly dataVersion: number }
  | {
      readonly type: 'flow';
      readonly txid: string;
      readonly vout: number;
      readonly height: number;
      readonly time: number;
      readonly flowType: string;
      readonly fromAddress: string;
      readonly fromKind: string;
      readonly toAddress: string;
      readonly toKind: string;
      readonly exchange: string | null;
      readonly amount: number;
    };

export interface StreamHubOptions {
  readonly maxClients: number;
  /** A comment line every so often keeps proxies from closing an idle stream. */
  readonly heartbeatMs?: number;
}

/** Proxies commonly drop idle connections after 60 s; stay well inside that. */
const DEFAULT_HEARTBEAT_MS = 20_000;

export class StreamHub {
  private readonly clients = new Set<Response>();
  private readonly heartbeat: NodeJS.Timeout;
  private nextId = 1;
  private sent = 0;

  constructor(private readonly options: StreamHubOptions) {
    this.heartbeat = setInterval(
      () => this.write(': ping\n\n'),
      options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    );
    this.heartbeat.unref?.();
  }

  get size(): number {
    return this.clients.size;
  }

  get eventsSent(): number {
    return this.sent;
  }

  /** Express handler for `GET /api/stream`. */
  readonly subscribe = (req: Request, res: Response): void => {
    if (this.clients.size >= this.options.maxClients) {
      // Each subscriber pins a socket. A cap stops a crowd (or a script) exhausting them;
      // clients fall back to their normal polling.
      res.setHeader('Retry-After', '30');
      res.status(503).json({ error: 'stream_full', message: 'Too many live subscribers' });
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // nginx buffers responses by default, which would hold events until the buffer fills.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Ask the browser to wait 5 s before reconnecting, rather than its 3 s default.
    res.write('retry: 5000\n\n');

    this.clients.add(res);

    const drop = (): void => {
      this.clients.delete(res);
    };
    req.on('close', drop);
    res.on('error', drop);
  };

  publish(event: LiveEvent): void {
    if (this.clients.size === 0) return;

    const id = this.nextId++;
    this.sent++;
    this.write(`id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  /** End every stream, e.g. on shutdown, so `server.close()` is not held open by them. */
  close(): void {
    clearInterval(this.heartbeat);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  private write(chunk: string): void {
    for (const res of this.clients) {
      // A write to a socket that is already gone throws on some Node versions; that
      // client is simply dropped, never allowed to break delivery to the others.
      try {
        res.write(chunk);
      } catch {
        this.clients.delete(res);
      }
    }
  }
}
