import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../testkit.js';
import type { FlowRow } from '../ingest/derive.js';
import { AlertService, describeFlow } from './alerts.js';

const SATS = 100_000_000;
const DISCORD = 'https://discord.test/api/webhooks/1/abc';

/** The parts of a fetch init the assertions read. */
interface SentRequest {
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

const services: AlertService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
});

function flow(overrides: Partial<FlowRow> = {}): FlowRow {
  return {
    txid: 'tx1',
    vout: 0,
    height: 3_004_000,
    time: 1_791_000_000,
    fromAddress: 't1nodeoperatorxxxxxxxxxxxxxxxxxxx',
    fromKind: 'node_operator',
    toAddress: 't1kucoindepositxxxxxxxxxxxxxxxxxx',
    toKind: 'exchange',
    exchange: 'Kucoin',
    flowType: 'selling',
    sat: 50_000 * SATS,
    ...overrides
  };
}

function setup(
  file: unknown,
  options: { env?: NodeJS.ProcessEnv; status?: number[]; now?: () => number } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-alerts-'));
  const alertsPath = path.join(dir, 'alerts.json');
  if (file !== undefined) fs.writeFileSync(alertsPath, JSON.stringify(file));

  const statuses = [...(options.status ?? [])];
  const fetchImpl = vi.fn(
    async (_url: string, _init?: SentRequest) =>
      new Response(null, { status: statuses.shift() ?? 204 })
  );

  const service = new AlertService({
    path: alertsPath,
    log: silentLogger(),
    env: options.env ?? { DISCORD_WEBHOOK_URL: DISCORD },
    ...(options.now ? { now: options.now } : {}),
    http: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} }
  });
  services.push(service);
  service.reload();

  const posts = () =>
    fetchImpl.mock.calls.map(([url, init]) => ({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    }));

  return { service, fetchImpl, posts, alertsPath };
}

const WHALE_RULES = {
  channels: { discord: { type: 'discord', url: 'env:DISCORD_WEBHOOK_URL' } },
  rules: [{ name: 'Whale sells', minFlux: 10_000, flowTypes: ['selling'], channels: ['discord'] }]
};

describe('AlertService (#32)', () => {
  it('posts a Discord embed for a flow over the threshold', async () => {
    const { service, posts } = setup(WHALE_RULES);

    service.evaluate([flow()]);
    await service.drain();

    expect(posts()).toHaveLength(1);
    const [post] = posts();
    expect(post!.url).toBe(DISCORD);
    const embed = (post!.body.embeds as Record<string, unknown>[])[0]!;
    expect(embed.title).toBe('Whale sells');
    expect(embed.description).toContain('SELL 50,000 FLUX to Kucoin');
    expect(embed.url).toBe('https://explorer.runonflux.io/tx/tx1');
    expect(service.stats().sent).toBe(1);
  });

  it('ignores flows below the threshold or of another direction', async () => {
    const { service, posts } = setup(WHALE_RULES);

    service.evaluate([flow({ sat: 9_999 * SATS }), flow({ txid: 'b', flowType: 'buying' })]);
    await service.drain();

    expect(posts()).toHaveLength(0);
  });

  it('matches watched addresses on either side of a flow', async () => {
    const { service, posts } = setup({
      channels: WHALE_RULES.channels,
      rules: [{ name: 'Watch', addresses: ['t1watched'], channels: ['discord'] }]
    });

    service.evaluate([
      flow({ txid: 'a', toAddress: 't1watched', sat: 1 }),
      flow({ txid: 'b', fromAddress: 't1watched', sat: 1 }),
      flow({ txid: 'c' })
    ]);
    await service.drain();

    expect(posts()).toHaveLength(2);
  });

  it('never alerts twice for the same flow, e.g. after a re-sync', async () => {
    const { service, posts } = setup(WHALE_RULES);

    service.evaluate([flow()]);
    service.evaluate([flow()]);
    await service.drain();

    expect(posts()).toHaveLength(1);
  });

  it('suppresses further matches during the cooldown', async () => {
    let now = 0;
    const { service, posts } = setup(
      {
        ...WHALE_RULES,
        rules: [{ ...WHALE_RULES.rules[0], cooldownSeconds: 300 }]
      },
      { now: () => now }
    );

    service.evaluate([flow({ txid: 'a' })]);
    now += 60_000;
    service.evaluate([flow({ txid: 'b' })]);
    now += 300_000;
    service.evaluate([flow({ txid: 'c' })]);
    await service.drain();

    expect(posts()).toHaveLength(2);
    expect(service.stats().suppressed).toBe(1);
  });

  it('caps a flood from one batch and says how many more there were', async () => {
    const { service, posts } = setup(WHALE_RULES);

    service.evaluate(Array.from({ length: 12 }, (_, i) => flow({ txid: `t${i}` })));
    await service.drain();

    expect(posts()).toHaveLength(5);
    const descriptions = posts().map(
      (post) => (post.body.embeds as { description: string }[])[0]!.description
    );
    expect(descriptions.some((text) => text.endsWith('(+7 more)'))).toBe(true);
  });

  it('retries a failed delivery', async () => {
    const { service, fetchImpl } = setup(WHALE_RULES, { status: [500, 502, 204] });

    service.evaluate([flow()]);
    await service.drain();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(service.stats()).toMatchObject({ sent: 1, failed: 0 });
  });

  it('counts a delivery that keeps failing, without throwing into ingestion', async () => {
    const { service } = setup(WHALE_RULES, { status: [500, 500, 500, 500] });

    expect(() => service.evaluate([flow()])).not.toThrow();
    await service.drain();

    expect(service.stats()).toMatchObject({ sent: 0, failed: 1 });
  });

  it('disables a channel whose secret is missing from the environment', async () => {
    const { service, posts } = setup(WHALE_RULES, { env: {} });

    service.evaluate([flow()]);
    await service.drain();

    expect(service.stats().channels).toBe(0);
    expect(posts()).toHaveLength(0);
  });

  it('sends a generic webhook with resolved headers, and Telegram messages', async () => {
    const { service, fetchImpl } = setup(
      {
        channels: {
          hook: {
            type: 'webhook',
            url: 'https://hooks.test/in',
            headers: { authorization: 'env:HOOK_AUTH' }
          },
          tg: { type: 'telegram', botToken: 'env:TG_TOKEN', chatId: '42' }
        },
        rules: [{ name: 'All', channels: ['hook', 'tg'] }]
      },
      { env: { HOOK_AUTH: 'Bearer s3cret', TG_TOKEN: '123:abc' } }
    );

    service.evaluate([flow()]);
    await service.drain();

    const calls = fetchImpl.mock.calls.map(([url, init]) => ({
      url: String(url),
      headers: init?.headers ?? {},
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    }));
    const hook = calls.find((call) => call.url === 'https://hooks.test/in')!;
    expect(hook.headers.authorization).toBe('Bearer s3cret');
    expect(hook.body).toMatchObject({ rule: 'All', flow: { txid: 'tx1', amount: 50_000 } });

    const telegram = calls.find((call) => call.url.includes('api.telegram.org'))!;
    expect(telegram.url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    expect(telegram.body).toMatchObject({ chat_id: '42' });
  });

  it('is off without a rules file', () => {
    const { service } = setup(undefined);

    expect(service.stats().enabled).toBe(false);
    expect(() => service.evaluate([flow()])).not.toThrow();
  });

  it('keeps the previous rules when an edit breaks the file', () => {
    const { service, alertsPath } = setup(WHALE_RULES);

    fs.writeFileSync(alertsPath, '{ not json');
    const stats = service.reload();

    expect(stats.rules).toBe(1);
    expect(stats.lastError).toMatch(/invalid/);
  });

  it('describes a buy in plain words', () => {
    expect(
      describeFlow(
        flow({
          flowType: 'buying',
          fromAddress: 't1kucoinhotwallet',
          fromKind: 'exchange',
          toAddress: 't1whalewalletxxxxxxxxxxxx',
          toKind: 'unknown',
          sat: 1_234.5 * SATS
        })
      )
    ).toBe('BUY 1,234.5 FLUX from Kucoin to unknown t1whale…xxxxx (block 3,004,000)');
  });
});
