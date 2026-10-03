/**
 * Typed calls for the dashboard's data endpoints (contract: docs/api.md).
 *
 * Paths are built here so components never assemble query strings by hand, and every call
 * takes an `AbortSignal` so a superseded view can cancel what it no longer needs (#26).
 */

import type { PeriodId } from '$lib/shared/constants';
import { apiFetch, cachedFetch } from './api';
import type {
  Counterparty,
  EventsPage,
  FlowSummary,
  FlowType,
  Leaderboard,
  SearchResponse,
  Series,
  WalletProfile
} from './types';
import type { BoardKind } from './urlState';

export function summaryPath(period: PeriodId): string {
  return `/flow/${period}`;
}

export function boardPath(period: PeriodId, side: 'buyers' | 'sellers', who: BoardKind): string {
  const params = new URLSearchParams({ limit: '10' });
  if (who) params.set('kind', who);
  return `/flow/${period}/${side}?${params.toString()}`;
}

export function seriesPath(period: PeriodId): string {
  return `/flow/${period}/series`;
}

export const fetchSummary = (period: PeriodId, signal?: AbortSignal) =>
  cachedFetch<FlowSummary>(summaryPath(period), signal);

export const fetchBoard = async (
  period: PeriodId,
  side: 'buyers' | 'sellers',
  who: BoardKind,
  signal?: AbortSignal
): Promise<Leaderboard> =>
  normaliseBoard(await cachedFetch<Leaderboard>(boardPath(period, side, who), signal), side);

/**
 * Fill in leaderboard fields an older server does not send (#28 added rank, share,
 * per-exchange totals and the previous-period comparison).
 *
 * During a rolling update the UI can briefly talk to the previous API; a missing field must
 * read as "not known" rather than render as `undefined` or `NaN`.
 */
export function normaliseBoard(board: Leaderboard, side: 'buyers' | 'sellers'): Leaderboard {
  const rows = (board[side] ?? []) as Partial<Counterparty>[];
  const total =
    typeof board.total === 'number'
      ? board.total
      : rows.reduce((sum, r) => sum + (r.total ?? 0), 0);

  const normalised: Counterparty[] = rows.map((row, index) => ({
    rank: row.rank ?? index + 1,
    address: row.address ?? '',
    name: row.name ?? null,
    kind: row.kind ?? 'unknown',
    total: row.total ?? 0,
    count: row.count ?? 0,
    share: row.share ?? (total > 0 ? (row.total ?? 0) / total : 0),
    exchanges: (row.exchanges ?? []).map((entry) =>
      typeof entry === 'string' ? { name: entry, total: Number.NaN, count: 0 } : entry
    ),
    lastSeen: row.lastSeen ?? null,
    previousTotal: row.previousTotal ?? Number.NaN,
    change: row.change ?? Number.NaN
  }));

  return { ...board, total, [side]: normalised };
}

export const fetchSeries = (period: PeriodId, signal?: AbortSignal) =>
  cachedFetch<Series>(seriesPath(period), signal);

export function fetchWallet(address: string, signal?: AbortSignal): Promise<WalletProfile> {
  return cachedFetch<WalletProfile>(`/wallets/${encodeURIComponent(address)}`, signal);
}

export function fetchWalletEvents(
  address: string,
  options: { cursor?: string | null; type?: FlowType | null; limit?: number },
  signal?: AbortSignal
): Promise<EventsPage> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 50) });
  if (options.type) params.set('type', options.type);
  if (options.cursor) params.set('cursor', options.cursor);
  return apiFetch<EventsPage>(
    `/wallets/${encodeURIComponent(address)}/events?${params.toString()}`,
    signal ? { signal } : {}
  );
}

export function search(query: string, signal?: AbortSignal): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query, limit: '10' });
  return apiFetch<SearchResponse>(`/search?${params.toString()}`, signal ? { signal } : {});
}

/** FLUX transparent address: `t1`/`t3` + 33 base58 characters. Mirrors the server's check. */
export function isAddress(value: string): boolean {
  return /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/.test(value);
}

export function isTxid(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}
