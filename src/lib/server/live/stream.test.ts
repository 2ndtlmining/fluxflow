import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from '../testkit.js';
import { StreamHub } from './stream.js';

let server: TestServer | undefined;
let hub: StreamHub | undefined;

afterEach(async () => {
  hub?.close();
  await server?.close();
  hub = undefined;
  server = undefined;
});

async function boot(maxClients = 10, heartbeatMs = 60_000): Promise<string> {
  hub = new StreamHub({ maxClients, heartbeatMs });
  const app = express();
  app.get('/stream', hub.subscribe);
  server = await startTestServer(app);
  return `${server.url}/stream`;
}

/** Read the stream until `predicate` holds for the text so far, or time out. */
async function readUntil(
  body: ReadableStream<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 2_000
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;

  try {
    while (!predicate(text)) {
      if (Date.now() > deadline) throw new Error(`timed out; got: ${text}`);
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  return text;
}

async function waitForClients(count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (hub!.size < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('StreamHub (#32)', () => {
  it('serves an event stream and delivers published events', async () => {
    const url = await boot();
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await waitForClients(1);

    hub!.publish({ type: 'sync', height: 3_004_000, dataVersion: 42 });

    const text = await readUntil(response.body!, (t) => t.includes('event: sync'));
    expect(text).toContain('retry: 5000');
    expect(text).toContain('"height":3004000');
    expect(text).toContain('"dataVersion":42');

    controller.abort();
  });

  it('drops a client that disconnects', async () => {
    const url = await boot();
    const controller = new AbortController();
    await fetch(url, { signal: controller.signal });
    await waitForClients(1);

    controller.abort();

    const deadline = Date.now() + 2_000;
    while (hub!.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(hub!.size).toBe(0);
  });

  it('refuses subscribers beyond the cap with 503', async () => {
    const url = await boot(1);
    const controller = new AbortController();
    await fetch(url, { signal: controller.signal });
    await waitForClients(1);

    const second = await fetch(url);
    expect(second.status).toBe(503);
    expect(second.headers.get('retry-after')).toBe('30');

    controller.abort();
  });

  it('sends heartbeats so proxies keep an idle stream open', async () => {
    const url = await boot(10, 20);
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });

    const text = await readUntil(response.body!, (t) => t.includes(': ping'));
    expect(text).toContain(': ping');

    controller.abort();
  });

  it('ends every stream on close, so shutdown is not held open', async () => {
    const url = await boot();
    const response = await fetch(url);
    await waitForClients(1);

    hub!.close();

    // The body ends rather than hanging: a hang fails the test on its timeout.
    await readUntil(response.body!, () => false);
    expect(hub!.size).toBe(0);
  });
});
