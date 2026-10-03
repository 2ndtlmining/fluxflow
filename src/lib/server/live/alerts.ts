/**
 * Whale and watchlist alerts, delivered to Discord, Telegram or any webhook (#32).
 *
 * Rules and channels live in a JSON file (`ALERTS_PATH`, mounted like `labels.json`), so
 * they can change without a rebuild; the file is re-read when it changes. A missing file
 * means alerts are off. Secrets such as webhook URLs can be kept out of the file with
 * `"env:NAME"`, which reads the value from the environment.
 *
 * Delivery never blocks ingestion: matching happens synchronously after a batch commits
 * (cheap), sending happens in the background with retries and a small concurrency cap.
 * Only tip-following flows are evaluated — a backfill of six months must not page anyone
 * about every whale since April.
 */

import fs from 'node:fs';
import type { Logger } from 'pino';
import { z } from 'zod';
import { createLimiter, httpRequest, type HttpRequestOptions } from '../http.js';
import type { FlowRow } from '../ingest/derive.js';

const SATS_PER_FLUX = 100_000_000;

/** A value, or `env:NAME` to read it from the environment. */
const secret = z.string().min(1);

const channelSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('discord'), url: secret }),
  z.object({
    type: z.literal('webhook'),
    url: secret,
    headers: z.record(z.string(), z.string()).optional()
  }),
  z.object({ type: z.literal('telegram'), botToken: secret, chatId: secret })
]);

const ruleSchema = z.object({
  name: z.string().min(1).max(100),
  /** Smallest flow that matches, in FLUX. */
  minFlux: z.number().min(0).default(0),
  /** Empty or absent means any. */
  flowTypes: z.array(z.enum(['buying', 'selling', 'p2p'])).default([]),
  exchanges: z.array(z.string()).default([]),
  /** Counterparty kinds, e.g. `node_operator`. */
  kinds: z.array(z.string()).default([]),
  /** Match when either side is one of these addresses: a personal watchlist. */
  addresses: z.array(z.string()).default([]),
  channels: z.array(z.string()).min(1),
  /** After an alert, further matches of this rule are suppressed for this long. */
  cooldownSeconds: z.number().int().min(0).max(86_400).default(0),
  enabled: z.boolean().default(true)
});

const fileSchema = z.object({
  channels: z.record(z.string(), channelSchema).default({}),
  rules: z.array(ruleSchema).default([])
});

export type AlertRule = z.infer<typeof ruleSchema>;
type Channel = z.infer<typeof channelSchema>;

export interface AlertStats {
  readonly enabled: boolean;
  readonly source: string;
  readonly rules: number;
  readonly channels: number;
  readonly sent: number;
  readonly failed: number;
  readonly suppressed: number;
  readonly lastError: string | null;
}

export interface AlertServiceOptions {
  readonly path: string;
  readonly log: Logger;
  readonly env?: NodeJS.ProcessEnv;
  readonly http?: Partial<HttpRequestOptions>;
  readonly now?: () => number;
  /** Seconds between checks of the rules file for changes. */
  readonly watchIntervalMs?: number;
}

/** Remembered (rule, flow) pairs, so a re-synced block cannot alert twice. */
const DEDUPE_SIZE = 5_000;
/** One rule matching a flood of flows in one batch sends this many, then a summary. */
const MAX_PER_RULE_PER_BATCH = 5;

export class AlertService {
  private rules: AlertRule[] = [];
  private channels = new Map<string, Channel>();
  private readonly lastSentAt = new Map<string, number>();
  private readonly seen = new Set<string>();
  private readonly limiter = createLimiter(4);
  private readonly pending = new Set<Promise<void>>();
  private watching = false;
  private counters = { sent: 0, failed: 0, suppressed: 0 };
  private lastError: string | null = null;
  private loaded = false;

  constructor(private readonly options: AlertServiceOptions) {}

  /** Read the rules file. Keeps the previous rules when the new file is invalid. */
  reload(): AlertStats {
    const { path, log } = this.options;

    if (!fs.existsSync(path)) {
      this.rules = [];
      this.channels.clear();
      this.loaded = false;
      return this.stats();
    }

    try {
      const parsed = fileSchema.parse(JSON.parse(fs.readFileSync(path, 'utf8')));
      const channels = new Map<string, Channel>();

      for (const [name, channel] of Object.entries(parsed.channels)) {
        const resolved = this.resolveSecrets(name, channel);
        if (resolved) channels.set(name, resolved);
      }

      for (const rule of parsed.rules) {
        const unknown = rule.channels.filter((name) => !channels.has(name));
        if (unknown.length > 0) {
          log.warn({ rule: rule.name, channels: unknown }, 'alert rule names unknown channels');
        }
      }

      this.rules = parsed.rules.filter((rule) => rule.enabled);
      this.channels = channels;
      this.loaded = true;
      this.lastError = null;
      log.info({ rules: this.rules.length, channels: channels.size }, 'alert rules loaded');
    } catch (error) {
      this.lastError = `invalid ${path}: ${error instanceof Error ? error.message : String(error)}`;
      log.error({ path, reason: this.lastError }, 'alert rules not reloaded; keeping previous');
    }

    return this.stats();
  }

  /** Re-read the file when it changes. Polling, so it works on bind mounts too. */
  watch(): void {
    if (this.watching) return;
    this.watching = true;
    fs.watchFile(
      this.options.path,
      { interval: this.options.watchIntervalMs ?? 5_000, persistent: false },
      () => this.reload()
    );
  }

  /**
   * Match newly committed flows against the rules and queue deliveries.
   *
   * Synchronous and cheap: it only decides what to send. Never throws.
   */
  evaluate(flows: readonly FlowRow[]): void {
    if (this.rules.length === 0 || flows.length === 0) return;

    const now = (this.options.now ?? Date.now)();

    for (const rule of this.rules) {
      const matches = flows.filter((flow) => this.matches(rule, flow));
      if (matches.length === 0) continue;

      const fresh = matches.filter((flow) =>
        this.remember(`${rule.name}|${flow.txid}:${flow.vout}`)
      );
      if (fresh.length === 0) continue;

      const cooldownMs = rule.cooldownSeconds * 1000;
      const last = this.lastSentAt.get(rule.name) ?? -Infinity;
      if (cooldownMs > 0 && now - last < cooldownMs) {
        this.counters.suppressed += fresh.length;
        continue;
      }
      this.lastSentAt.set(rule.name, now);

      const toSend = fresh.slice(0, MAX_PER_RULE_PER_BATCH);
      const extra = fresh.length - toSend.length;
      if (extra > 0) this.counters.suppressed += extra;

      for (const channelName of rule.channels) {
        const channel = this.channels.get(channelName);
        if (!channel) continue;

        toSend.forEach((flow, index) => {
          const note = index === toSend.length - 1 && extra > 0 ? ` (+${extra} more)` : '';
          this.enqueue(channelName, channel, rule, flow, note);
        });
      }
    }
  }

  stats(): AlertStats {
    return {
      enabled: this.loaded && this.rules.length > 0,
      source: this.options.path,
      rules: this.rules.length,
      channels: this.channels.size,
      ...this.counters,
      lastError: this.lastError
    };
  }

  /** Wait for queued deliveries, e.g. on shutdown or in tests. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  close(): void {
    if (this.watching) fs.unwatchFile(this.options.path);
    this.watching = false;
  }

  private matches(rule: AlertRule, flow: FlowRow): boolean {
    if (flow.sat < rule.minFlux * SATS_PER_FLUX) return false;
    if (rule.flowTypes.length > 0 && !rule.flowTypes.includes(flow.flowType)) return false;
    if (rule.exchanges.length > 0 && (!flow.exchange || !rule.exchanges.includes(flow.exchange))) {
      return false;
    }
    if (rule.kinds.length > 0) {
      const counterparty = flow.flowType === 'buying' ? flow.toKind : flow.fromKind;
      if (!rule.kinds.includes(counterparty)) return false;
    }
    if (
      rule.addresses.length > 0 &&
      !rule.addresses.includes(flow.fromAddress) &&
      !rule.addresses.includes(flow.toAddress)
    ) {
      return false;
    }
    return true;
  }

  /** @returns false when this key was already seen. */
  private remember(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > DEDUPE_SIZE) this.seen.delete(this.seen.values().next().value!);
    return true;
  }

  private enqueue(
    channelName: string,
    channel: Channel,
    rule: AlertRule,
    flow: FlowRow,
    note: string
  ): void {
    const delivery = this.limiter
      .run(() => this.send(channel, rule, flow, note))
      .then(() => {
        this.counters.sent++;
      })
      .catch((error: unknown) => {
        this.counters.failed++;
        this.lastError = `${channelName}: ${error instanceof Error ? error.message : String(error)}`;
        this.options.log.warn(
          { channel: channelName, rule: rule.name, reason: this.lastError },
          'alert delivery failed'
        );
      })
      .finally(() => {
        this.pending.delete(delivery);
      });

    this.pending.add(delivery);
  }

  private async send(
    channel: Channel,
    rule: AlertRule,
    flow: FlowRow,
    note: string
  ): Promise<void> {
    const text = describeFlow(flow) + note;
    const http: HttpRequestOptions = {
      method: 'POST',
      timeoutMs: 10_000,
      retries: 3,
      retryBaseMs: 1_000,
      ...this.options.http,
      headers: { 'content-type': 'application/json', ...this.options.http?.headers }
    };

    switch (channel.type) {
      case 'discord':
        await httpRequest(channel.url, {
          ...http,
          body: JSON.stringify({
            username: 'FluxFlow',
            embeds: [
              {
                title: rule.name,
                description: text,
                url: `https://explorer.runonflux.io/tx/${flow.txid}`,
                color:
                  flow.flowType === 'selling'
                    ? 0xe5484d
                    : flow.flowType === 'buying'
                      ? 0x30a46c
                      : 0x8e8e8e,
                timestamp: new Date(flow.time * 1000).toISOString()
              }
            ]
          })
        });
        return;

      case 'telegram':
        await httpRequest(`https://api.telegram.org/bot${channel.botToken}/sendMessage`, {
          ...http,
          body: JSON.stringify({ chat_id: channel.chatId, text: `${rule.name}\n${text}` })
        });
        return;

      case 'webhook':
        await httpRequest(channel.url, {
          ...http,
          headers: { ...http.headers, ...channel.headers },
          body: JSON.stringify({
            rule: rule.name,
            text,
            flow: { ...flow, amount: flow.sat / SATS_PER_FLUX }
          })
        });
        return;
    }
  }

  /** Resolve `env:NAME` values; a channel with a missing secret is disabled, not half-sent. */
  private resolveSecrets(name: string, channel: Channel): Channel | null {
    const env = this.options.env ?? process.env;
    const missing: string[] = [];

    const resolve = (value: string): string => {
      if (!value.startsWith('env:')) return value;
      const key = value.slice(4);
      const found = env[key];
      if (!found) missing.push(key);
      return found ?? '';
    };

    let resolved: Channel;
    switch (channel.type) {
      case 'telegram':
        resolved = {
          ...channel,
          botToken: resolve(channel.botToken),
          chatId: resolve(channel.chatId)
        };
        break;
      case 'webhook':
        resolved = {
          ...channel,
          url: resolve(channel.url),
          ...(channel.headers
            ? {
                headers: Object.fromEntries(
                  Object.entries(channel.headers).map(([key, value]) => [key, resolve(value)])
                )
              }
            : {})
        };
        break;
      case 'discord':
        resolved = { ...channel, url: resolve(channel.url) };
        break;
    }

    if (missing.length > 0) {
      this.options.log.warn(
        { channel: name, missing },
        'alert channel disabled: environment variable not set'
      );
      return null;
    }

    return resolved;
  }
}

/** One line a human can act on: direction, amount, who, where. */
export function describeFlow(flow: FlowRow): string {
  const amount = (flow.sat / SATS_PER_FLUX).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const short = (address: string) =>
    address.length > 14 ? `${address.slice(0, 7)}…${address.slice(-5)}` : address;

  const what =
    flow.flowType === 'selling'
      ? `SELL ${amount} FLUX to ${flow.exchange ?? 'an exchange'} from ${flow.fromKind.replace('_', ' ')} ${short(flow.fromAddress)}`
      : flow.flowType === 'buying'
        ? `BUY ${amount} FLUX from ${flow.exchange ?? 'an exchange'} to ${flow.toKind.replace('_', ' ')} ${short(flow.toAddress)}`
        : `TRANSFER ${amount} FLUX ${short(flow.fromAddress)} -> ${short(flow.toAddress)}`;

  return `${what} (block ${flow.height.toLocaleString('en-US')})`;
}
