/**
 * Live updates (#32): one `EventSource` on `/api/stream` for the whole page.
 *
 * Views do not poll on their own. They read `live.version` and revalidate when it changes,
 * which happens:
 *  - on every `sync` event while the stream is open (a batch was committed), or
 *  - every 30 s while it is not: the stream failed, was refused (503 at the client cap), or
 *    the server does not offer it. Revalidating is cheap either way, because the API answers
 *    304 until its data version moves.
 *
 * While the tab is hidden the stream is closed and polling stops; becoming visible again
 * revalidates at once and reconnects.
 */

import { apiUrl } from './api';
import type { LiveEvent } from './types';

type FlowEvent = Extract<LiveEvent, { type: 'flow' }>;

export interface LiveToast {
  readonly id: number;
  readonly flow: FlowEvent;
}

const POLL_MS = 30_000;
/** After the server refuses or lacks the stream, wait this long before asking again. */
const RECONNECT_MS = 60_000;
const TOAST_MS = 10_000;
const MAX_TOASTS = 3;

class Live {
  /** True while the event stream is open. */
  connected = $state(false);
  /** Bumped whenever the data may have changed; views revalidate on it. */
  version = $state(0);
  height = $state<number | null>(null);
  toasts = $state<LiveToast[]>([]);

  private source: EventSource | null = null;
  private poll: ReturnType<typeof setInterval> | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private users = 0;
  private nextToast = 1;

  /** Start for one consumer; returns its stop function. Ref-counted, so one stream serves all. */
  start(): () => void {
    this.users++;
    if (this.users === 1) {
      document.addEventListener('visibilitychange', this.onVisibility);
      if (!document.hidden) this.connect();
    }
    return () => {
      this.users--;
      if (this.users === 0) {
        document.removeEventListener('visibilitychange', this.onVisibility);
        this.disconnect();
      }
    };
  }

  dismiss(id: number): void {
    this.toasts = this.toasts.filter((toast) => toast.id !== id);
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) {
      this.disconnect();
    } else {
      this.version++;
      this.connect();
    }
  };

  private connect(): void {
    if (this.source || typeof EventSource === 'undefined') {
      if (!this.source) this.startPolling();
      return;
    }
    clearTimeout(this.reconnect);

    const source = new EventSource(apiUrl('/stream'));
    this.source = source;

    source.addEventListener('open', () => {
      this.connected = true;
      this.stopPolling();
    });

    source.addEventListener('sync', (message) => {
      const event = parse(message);
      if (event?.type === 'sync') this.height = event.height;
      this.version++;
    });

    source.addEventListener('flow', (message) => {
      const event = parse(message);
      if (event?.type === 'flow') this.toast(event);
    });

    source.addEventListener('error', () => {
      this.connected = false;
      this.startPolling();

      // CLOSED means the browser gave up: a 503 at the client cap, a 404 on a server
      // without the stream, or a wrong content type. Ask again later rather than never.
      if (source.readyState === EventSource.CLOSED) {
        source.close();
        if (this.source === source) this.source = null;
        clearTimeout(this.reconnect);
        this.reconnect = setTimeout(() => {
          if (!document.hidden && this.users > 0) this.connect();
        }, RECONNECT_MS);
      }
      // Otherwise the browser is already reconnecting on its own (server `retry: 5000`).
    });
  }

  private disconnect(): void {
    this.source?.close();
    this.source = null;
    this.connected = false;
    clearTimeout(this.reconnect);
    this.stopPolling();
  }

  private startPolling(): void {
    if (this.poll) return;
    this.poll = setInterval(() => {
      if (!document.hidden) this.version++;
    }, POLL_MS);
  }

  private stopPolling(): void {
    clearInterval(this.poll);
    this.poll = undefined;
  }

  private toast(flow: FlowEvent): void {
    const id = this.nextToast++;
    this.toasts = [{ id, flow }, ...this.toasts].slice(0, MAX_TOASTS);
    setTimeout(() => this.dismiss(id), TOAST_MS);
  }
}

function parse(message: Event): LiveEvent | null {
  try {
    return JSON.parse((message as MessageEvent<string>).data) as LiveEvent;
  } catch {
    return null;
  }
}

export const live = new Live();

// Development only: inspect live state from the browser console.
if (import.meta.env.DEV) (globalThis as { __fluxflowLive?: Live }).__fluxflowLive = live;
