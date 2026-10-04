/**
 * The live path end to end, through the real service wiring: a sync cycle commits a block
 * with a whale buy, and that reaches `/api/stream`, a webhook, and `/api/metrics` (#24, #32).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createService, type Service } from '../index.js';
import { startTestServer, type TestServer } from '../testkit.js';
import type { DataSource, NormalisedBlock } from '../ingest/datasource/types.js';

const SATS = 100_000_000;
const ADMIN_TOKEN = 'x'.repeat(40);

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close().catch(() => {});
});

/** A chain whose blocks are recent and each carry a 50,000 FLUX withdrawal from Coinex. */
function whaleChain(initialTip: number): DataSource & { tip: number } {
  const now = Math.floor(Date.now() / 1000);
  const chain = { tip: initialTip };

  const block = (height: number): NormalisedBlock => ({
    height,
    hash: `hash-${height}`,
    prevHash: `hash-${height - 1}`,
    time: now - (initialTip - height) * 30,
    txCount: 1,
    transactions: [
      {
        txid: `tx-${height}`,
        kind: 'transfer',
        inputs: [{ address: 't1coinex', sat: 50_000 * SATS + 1_000, vout: 0 }],
        outputs: [{ n: 0, address: 't1whale', sat: 50_000 * SATS, nulldata: false }],
        complete: true
      }
    ]
  });

  return Object.assign(chain, {
    id: 'whale-chain',
    description: 'in-memory chain',
    getTip: async () => chain.tip,
    getBlock: async (height: number) => block(height),
    getBlockHash: async (height: number) => `hash-${height}`,
    isHealthy: async () => true
  });
}

async function webhookReceiver(): Promise<{ url: string; received: unknown[] }> {
  const received: unknown[] = [];
  const app = express();
  app.use(express.json());
  app.post('/hook', (req, res) => {
    received.push(req.body);
    res.status(204).end();
  });
  const server: TestServer = await startTestServer(app);
  cleanup.push(() => server.close());
  return { url: `${server.url}/hook`, received };
}

async function boot(
  hookUrl: string,
  chain: DataSource
): Promise<{ service: Service; base: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-live-'));
  const labelsPath = path.join(dir, 'labels.json');
  const alertsPath = path.join(dir, 'alerts.json');

  fs.writeFileSync(
    labelsPath,
    JSON.stringify({ exchanges: [{ name: 'Coinex', addresses: ['t1coinex'] }] })
  );
  fs.writeFileSync(
    alertsPath,
    JSON.stringify({
      channels: { hook: { type: 'webhook', url: hookUrl } },
      rules: [{ name: 'Whale buys', minFlux: 10_000, flowTypes: ['buying'], channels: ['hook'] }]
    })
  );

  const port = 41_000 + Math.floor(Math.random() * 2_000);
  const service = createService({
    env: {
      NODE_ENV: 'test',
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_PATH: path.join(dir, 'flux.db'),
      LABELS_PATH: labelsPath,
      ALERTS_PATH: alertsPath,
      ADMIN_TOKEN,
      LOG_LEVEL: 'silent',
      SYNC_ENABLED: '1',
      SYNC_BATCH_SIZE: '1000',
      REORG_CHECK_DEPTH: '0',
      LIVE_FLOW_MIN_FLUX: '1000'
    },
    sources: [chain],
    autoStartSync: false
  });
  cleanup.push(() => service.close());
  await service.listen();

  return { service, base: `http://127.0.0.1:${port}` };
}

async function readStreamUntil(
  body: ReadableStream<Uint8Array>,
  needle: string,
  timeoutMs = 3_000
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const timer = setTimeout(() => void reader.cancel(), timeoutMs);

  try {
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }

  return text;
}

describe('live updates and alerts, end to end', () => {
  it('streams sync and flow events and alerts a webhook after a committed cycle', async () => {
    const hook = await webhookReceiver();
    const chain = whaleChain(20);
    const { service, base } = await boot(hook.url, chain);

    const controller = new AbortController();
    cleanup.push(async () => controller.abort());
    const stream = await fetch(`${base}/api/stream`, { signal: controller.signal });
    expect(stream.status).toBe(200);

    // The first cycle on an empty database is a backfill from the retention floor: history,
    // not news. Subscribers hear the data changed, but nobody is alerted.
    await service.sync!.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(hook.received).toHaveLength(0);

    // A new block at the tip is news.
    chain.tip = 21;
    await service.sync!.runOnce();

    const text = await readStreamUntil(stream.body!, 'event: flow');
    expect(text).toContain('event: sync');
    expect(text).toContain('event: flow');
    expect(text).toContain('"txid":"tx-21"');

    const deadline = Date.now() + 3_000;
    while (hook.received.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(hook.received).toEqual([
      expect.objectContaining({
        rule: 'Whale buys',
        flow: expect.objectContaining({ txid: 'tx-21', exchange: 'Coinex', amount: 50_000 })
      })
    ]);

    // Metrics reflect all of it, in Prometheus format.
    const metrics = await fetch(`${base}/api/metrics`);
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    const body = await metrics.text();
    expect(body).toMatch(/^fluxflow_chain_height 21$/m);
    expect(body).toMatch(/^fluxflow_alerts_total\{outcome="sent"\} 1$/m);
    expect(body).toMatch(/^fluxflow_stream_clients 1$/m);
    expect(body).toMatch(/^fluxflow_source_active\{source="whale-chain"\} 1$/m);
    expect(body).toContain('fluxflow_event_loop_delay_seconds{quantile="0.99"}');

    // And /api/status carries the runtime view.
    const status = (await (await fetch(`${base}/api/status`)).json()) as {
      runtime: { streamClients: number; alerts: { sent: number }; eventLoopDelayMs: object };
    };
    expect(status.runtime.streamClients).toBe(1);
    expect(status.runtime.alerts.sent).toBe(1);
    expect(status.runtime.eventLoopDelayMs).toEqual(
      expect.objectContaining({ p50: expect.any(Number), p99: expect.any(Number) })
    );
  });

  it('answers a manual sync at once with 202 instead of holding the request open (#21)', async () => {
    const hook = await webhookReceiver();
    const { base } = await boot(hook.url, whaleChain(5));

    const unauthorised = await fetch(`${base}/api/admin/sync`, { method: 'POST' });
    expect(unauthorised.status).toBe(401);

    const accepted = await fetch(`${base}/api/admin/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });
    expect(accepted.status).toBe(202);
  });

  it('rejects oversized request bodies (#21)', async () => {
    const hook = await webhookReceiver();
    const { base } = await boot(hook.url, whaleChain(5));

    const response = await fetch(`${base}/api/admin/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(200_000) })
    });
    expect(response.status).toBe(413);
  });

  it('never exposes a failing webhook URL through /api/status or /api/metrics (security)', async () => {
    const TOKEN = 'HookTokenThatMustNeverLeak0987654321';

    // A receiver that fails and echoes the URL it was called on, as some servers do.
    const app = express();
    app.post(/.*/, (req, res) => {
      res.status(500).send(`failed for ${req.originalUrl}`);
    });
    const receiver = await startTestServer(app);
    cleanup.push(() => receiver.close());

    const chain = whaleChain(20);
    const { service, base } = await boot(`${receiver.url}/hook/${TOKEN}`, chain);

    await service.sync!.runOnce();
    chain.tip = 21;
    await service.sync!.runOnce();

    // Wait for the delivery (with its retries) to be given up on.
    const deadline = Date.now() + 15_000;
    let status: { runtime: { alerts: { failed: number; lastError: string | null } } };
    do {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = (await (await fetch(`${base}/api/status`)).json()) as typeof status;
    } while (status.runtime.alerts.failed === 0 && Date.now() < deadline);

    expect(status.runtime.alerts.failed).toBe(1);
    expect(status.runtime.alerts.lastError).toMatch(/HTTP 500/);

    const statusText = await (await fetch(`${base}/api/status`)).text();
    const metricsText = await (await fetch(`${base}/api/metrics`)).text();
    expect(statusText).not.toContain(TOKEN);
    expect(metricsText).not.toContain(TOKEN);
  }, 20_000);
});
