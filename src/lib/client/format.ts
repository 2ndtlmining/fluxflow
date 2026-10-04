/** Display formatting. Pure functions, so they are unit-tested without a browser. */

import type { AddressKind, FlowType } from './types';

const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1
});
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const precise = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/**
 * A FLUX amount for reading at a glance: `1.2M`, `48.7K`, `912`, `0.02`.
 *
 * Below 1,000 the figure is shown in full, because "0.02" and "912" are already short and
 * rounding them to "0" or "1K" would hide what the row is.
 */
export function formatFlux(amount: number): string {
  const abs = Math.abs(amount);
  // Dust would round to "0", which reads as "nothing moved".
  if (abs > 0 && abs < 0.01) return amount < 0 ? '>−0.01' : '<0.01';
  if (abs >= 10_000) return compact.format(amount);
  if (abs >= 1_000) return whole.format(amount);
  return precise.format(amount);
}

/** A FLUX amount in full, for tooltips, tables and exports. */
export function formatFluxFull(amount: number): string {
  return precise.format(amount);
}

/** A signed amount: `+12.3K` / `−4.1K`, with a true minus sign. */
export function formatSigned(amount: number): string {
  if (amount === 0) return '0';
  const sign = amount > 0 ? '+' : '−';
  return `${sign}${formatFlux(Math.abs(amount))}`;
}

export function formatCount(count: number): string {
  return whole.format(count);
}

/** `t1Tohz…ocehj`: both ends, which is how people recognise an address. */
export function shortAddress(address: string, keep = 6): string {
  return address.length <= keep * 2 + 1
    ? address
    : `${address.slice(0, keep)}…${address.slice(-5)}`;
}

/** Relative time from a unix timestamp in seconds, against `now` in milliseconds. */
export function timeAgo(unixSeconds: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round(now / 1000 - unixSeconds));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** A date without the time, e.g. "14 May 2026". */
export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

/** A rough remaining time: "under a minute", "about 35 min", "about 3 h". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `about ${minutes} min`;
  return `about ${Math.round(minutes / 60)} h`;
}

/** Absolute local time for a unix timestamp in seconds. */
export function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

const KIND_LABELS: Record<AddressKind, string> = {
  exchange: 'Exchange',
  foundation: 'Flux Foundation',
  node_operator: 'Node operator',
  unknown: 'Unlabelled wallet'
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind as AddressKind] ?? kind;
}

const FLOW_LABELS: Record<FlowType, string> = {
  buying: 'Withdrawn from exchange',
  selling: 'Deposited to exchange',
  p2p: 'Wallet to wallet'
};

export function flowLabel(flowType: string): string {
  return FLOW_LABELS[flowType as FlowType] ?? flowType;
}

const SOURCE_TEXT: Record<string, string> = {
  node_list: 'Runs nodes on the current FluxNode list',
  rewards: 'Has received FluxNode rewards',
  forwarding: 'Regularly receives funds forwarded from node-reward wallets',
  cluster: 'Spends together with a labelled wallet (shared inputs)',
  config: "Listed in FluxFlow's address labels",
  manual: 'Labelled by hand',
  deposit: 'Forwards everything it receives to one exchange (a deposit address)',
  foundation_intermediary: 'Receives Foundation money and pays it on as node collateral'
};

/** Plain-language reason for a label, from its source. */
export function sourceText(source: string | null | undefined): string {
  if (!source) return 'No label on record';
  return SOURCE_TEXT[source] ?? `Labelled from ${source.replace(/_/g, ' ')}`;
}

const EVIDENCE_TEXT: Record<string, (value: unknown) => string | null> = {
  nodes: (v) => `${formatCount(Number(v))} nodes`,
  tiers: (v) =>
    v && typeof v === 'object'
      ? Object.entries(v as Record<string, number>)
          .map(([tier, n]) => `${n} ${tier.charAt(0)}${tier.slice(1).toLowerCase()}`)
          .join(', ')
      : null,
  rewards: (v) => `${formatCount(Number(v))} rewards received`,
  lastRewardHeight: (v) => `last reward at block ${formatCount(Number(v))}`,
  forwards: (v) => `${formatCount(Number(v))} forwards`,
  sharedInputs: (v) => `${formatCount(Number(v))} shared-input transactions`
};

/**
 * Evidence objects differ by source; show the parts people can read and skip internals
 * such as `method`, which `sourceText` already explains.
 */
export function evidenceText(evidence: Record<string, unknown> | null | undefined): string[] {
  if (!evidence) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(evidence)) {
    if (key === 'method' || value === null || value === undefined) continue;
    const describe = EVIDENCE_TEXT[key];
    const text = describe
      ? describe(value)
      : typeof value === 'number' || typeof value === 'string'
        ? `${key.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${value}`
        : null;
    if (text) out.push(text);
  }
  return out;
}
