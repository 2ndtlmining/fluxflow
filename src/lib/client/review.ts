/**
 * The label review (#20), browser side: the admin token, typed calls, and the pure helpers
 * that group and describe candidates.
 *
 * The token lives in `sessionStorage` only: it survives a reload but not closing the tab, and
 * it is never put in a URL, a log line or `localStorage`.
 */

import { apiUrl } from './api';
import { formatCount, formatFlux, shortAddress } from './format';

export type CandidateStatus = 'pending' | 'accepted' | 'rejected';
export type Decision = 'accepted' | 'rejected';

export interface ReviewCandidate {
  address: string;
  kind: string;
  name: string;
  method: string;
  confidence: number;
  evidence: Record<string, unknown> | null;
  status: CandidateStatus;
  createdAt: number;
  decidedAt: number | null;
  strength: number;
  currentLabel: { kind: string; name: string | null; source: string } | null;
  activity: {
    txs: number;
    firstSeen: number | null;
    lastSeen: number | null;
    received: { flux: number; transfers: number; senders: number; fromNodeOperators: number };
    sent: {
      flux: number;
      transfers: number;
      toClaimed: number;
      toClaimedShare: number | null;
      exchanges: { name: string; flux: number }[];
    };
  };
}

export interface ReviewResponse {
  status: CandidateStatus;
  counts: Record<CandidateStatus, number>;
  candidates: ReviewCandidate[];
}

export interface BulkResult {
  success: true;
  decision: Decision;
  decided: number;
  changedAddresses: number;
  transactions: number;
  queued: number | null;
}

// ── Token ─────────────────────────────────────────────────────────────────────

export const TOKEN_KEY = 'fluxflow-admin-token';

/** `sessionStorage`, or nothing where it is unavailable (private mode, SSR). */
function session(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function readToken(storage: Storage | null = session()): string | null {
  try {
    return storage?.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function saveToken(token: string, storage: Storage | null = session()): void {
  try {
    storage?.setItem(TOKEN_KEY, token.trim());
  } catch {
    /* storage unavailable: the token lasts for this page only */
  }
}

export function clearToken(storage: Storage | null = session()): void {
  try {
    storage?.removeItem(TOKEN_KEY);
  } catch {
    /* nothing stored */
  }
}

// ── Calls ─────────────────────────────────────────────────────────────────────

export class AdminError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }

  /** The token was refused (or admin is switched off): ask for it again. */
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

async function adminFetch<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {})
      },
      // An admin answer is never worth caching.
      cache: 'no-store'
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new AdminError(0, 'Could not reach the server. Check that FluxFlow is running.');
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    const message =
      response.status === 401
        ? 'The admin token was not accepted.'
        : response.status === 503
          ? 'Admin is switched off on this server (ADMIN_TOKEN is not set).'
          : (body.message ?? `The server answered ${response.status}.`);
    throw new AdminError(response.status, message);
  }
  return (await response.json()) as T;
}

export function fetchReview(
  token: string,
  status: CandidateStatus,
  signal?: AbortSignal
): Promise<ReviewResponse> {
  return adminFetch(`/admin/labels/review?status=${status}`, token, signal ? { signal } : {});
}

export function decideBulk(
  token: string,
  decision: Decision,
  candidates: readonly Pick<ReviewCandidate, 'address' | 'kind' | 'name'>[]
): Promise<BulkResult> {
  return adminFetch('/admin/labels/candidates/decide-bulk', token, {
    method: 'POST',
    body: JSON.stringify({
      decision,
      candidates: candidates.map(({ address, kind, name }) => ({ address, kind, name }))
    })
  });
}

// ── Grouping ──────────────────────────────────────────────────────────────────

export interface CandidateGroup {
  /** `name|method|kind`: what one decision usually covers. */
  key: string;
  name: string;
  method: string;
  kind: string;
  items: ReviewCandidate[];
  strongest: number;
  sentFlux: number;
}

/** A candidate's identity, for selection sets. */
export function candidateId(candidate: Pick<ReviewCandidate, 'address' | 'kind' | 'name'>): string {
  return `${candidate.address}|${candidate.kind}|${candidate.name}`;
}

/**
 * Group by proposed party and method, strongest group first; inside a group, strongest
 * candidate first, then the one that moved the most.
 */
export function groupCandidates(candidates: readonly ReviewCandidate[]): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>();

  for (const candidate of candidates) {
    const key = `${candidate.name}|${candidate.method}|${candidate.kind}`;
    const group = groups.get(key) ?? {
      key,
      name: candidate.name,
      method: candidate.method,
      kind: candidate.kind,
      items: [],
      strongest: 0,
      sentFlux: 0
    };
    group.items.push(candidate);
    group.strongest = Math.max(group.strongest, candidate.strength);
    group.sentFlux += candidate.activity.sent.flux;
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    group.items.sort(
      (a, b) =>
        b.strength - a.strength ||
        b.activity.sent.flux - a.activity.sent.flux ||
        a.address.localeCompare(b.address)
    );
  }

  return [...groups.values()].sort(
    (a, b) => b.strongest - a.strongest || b.sentFlux - a.sentFlux || a.key.localeCompare(b.key)
  );
}

// ── Describing ────────────────────────────────────────────────────────────────

const METHOD_TEXT: Record<string, string> = {
  sweep: 'Swept into a known exchange wallet together with other deposit addresses',
  common_input: 'Spent in the same transaction as a known exchange wallet (shared inputs)',
  forwarder: 'Sends everything it receives to one exchange (a deposit address)'
};

/** Plain words for a method; an unknown method is shown by its name, not hidden. */
export function methodText(method: string): string {
  return METHOD_TEXT[method] ?? `Proposed by ${method.replace(/_/g, ' ')}`;
}

/** Short method name for a group heading. */
export function methodName(method: string): string {
  const name = method.replace(/_/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const TXID = /^[0-9a-f]{64}$/i;
const ADDRESS = /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/;

export interface EvidenceItem {
  label: string;
  text: string;
  /** Present when the value is a transaction or an address. */
  href?: string;
  external?: boolean;
}

/** `sharedTxs` → `shared txs`. */
function words(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
}

function describeValue(label: string, value: unknown): EvidenceItem[] {
  if (typeof value === 'string') {
    if (TXID.test(value)) {
      return [
        {
          label,
          text: shortAddress(value, 8),
          href: `https://explorer.runonflux.io/tx/${value}`,
          external: true
        }
      ];
    }
    if (ADDRESS.test(value)) {
      return [{ label, text: shortAddress(value), href: `/wallet/${value}` }];
    }
    return [{ label, text: value }];
  }
  if (typeof value === 'number') return [{ label, text: formatCount(value) }];
  if (typeof value === 'boolean') return [{ label, text: value ? 'yes' : 'no' }];
  if (Array.isArray(value)) {
    // Lists of transactions or addresses become links; anything else is summarised.
    const linked = value.slice(0, 5).flatMap((item) => describeValue(label, item));
    if (linked.length > 0 && linked.every((item) => item.href)) {
      return value.length > 5
        ? [...linked, { label, text: `and ${formatCount(value.length - 5)} more` }]
        : linked;
    }
    return [{ label, text: `${formatCount(value.length)} items` }];
  }
  return [];
}

/**
 * A candidate's evidence as readable items, with links for transactions and addresses.
 * Generic on purpose: a method added later shows its evidence without a UI change.
 */
export function evidenceItems(evidence: Record<string, unknown> | null): EvidenceItem[] {
  if (!evidence) return [];
  return Object.entries(evidence)
    .filter(([key, value]) => key !== 'method' && value !== null && value !== undefined)
    .flatMap(([key, value]) => describeValue(words(key), value));
}

/** The one-line case for (or against) accepting, from what the address did. */
export function activityText(candidate: ReviewCandidate): string {
  const { received, sent } = candidate.activity;
  const parts: string[] = [];

  if (received.transfers > 0) {
    parts.push(
      `received ${formatFlux(received.flux)} FLUX from ${formatCount(received.senders)} ${
        received.senders === 1 ? 'wallet' : 'wallets'
      }${received.fromNodeOperators > 0 ? ` (${formatCount(received.fromNodeOperators)} from node operators)` : ''}`
    );
  }
  if (sent.transfers > 0) {
    const share = sent.toClaimedShare === null ? null : Math.round(sent.toClaimedShare * 100);
    parts.push(
      `sent ${formatFlux(sent.flux)} FLUX${share !== null ? `, ${share}% of it to ${candidate.name}` : ''}`
    );
  }

  if (parts.length === 0) return 'No transfers stored for this address yet.';
  const text = parts.join('; ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

/** What a decision will do, in words, before it is made. */
export function decisionPreview(decision: Decision, selected: readonly ReviewCandidate[]): string {
  const parties = [...new Set(selected.map((candidate) => candidate.name || candidate.kind))];
  const txs = selected.reduce((sum, candidate) => sum + candidate.activity.txs, 0);
  const who = parties.length === 1 ? parties[0] : `${parties.length} parties`;
  const count = `${formatCount(selected.length)} ${selected.length === 1 ? 'address' : 'addresses'}`;

  return decision === 'accepted'
    ? `Label ${count} as ${who}. About ${formatCount(txs)} transactions are re-derived.`
    : `Reject ${count} for ${who}. Any label an earlier acceptance created is removed.`;
}
