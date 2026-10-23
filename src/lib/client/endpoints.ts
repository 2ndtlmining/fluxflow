/**
 * Typed calls for the dashboard's data endpoints (contract: docs/api.md).
 *
 * Paths are built here so components never assemble query strings by hand, and every call
 * takes an `AbortSignal` so a superseded view can cancel what it no longer needs (#26).
 */

import type { PeriodId } from '$lib/shared/constants';
import { apiFetch, cachedFetch } from './api';
import type {
  AppPayments,
  BalanceHistory,
  BehaviourTagName,
  ClusterSummary,
  Counterparty,
  EntityList,
  EntityReport,
  EventsPage,
  FlowGraph,
  PathResult,
  Foundation,
  HopsResponse,
  FlowSummary,
  FlowType,
  Leaderboard,
  SearchResponse,
  Series,
  TxDetail,
  WalletCounterparties,
  WalletFunds,
  WalletProfile
} from './types';
import { withRange, type BoardKind, type Certainty, type TimeSpan } from './urlState';

/** `path`, with the picked span (#29) as a query when there is one. */
function spanned(path: string, range: TimeSpan | null): string {
  const query = withRange(new URLSearchParams(), range).toString();
  return query ? `${path}?${query}` : path;
}

export function summaryPath(period: PeriodId, range: TimeSpan | null = null): string {
  return spanned(`/flow/${period}`, range);
}

export function boardPath(
  period: PeriodId,
  side: 'buyers' | 'sellers',
  who: BoardKind,
  sure: Certainty = '',
  tag: BehaviourTagName | '' = '',
  range: TimeSpan | null = null
): string {
  const params = new URLSearchParams({ limit: '10' });
  if (who) params.set('kind', who);
  if (sure) params.set('minConfidence', sure);
  if (tag) params.set('tag', tag);
  withRange(params, range);
  return `/flow/${period}/${side}?${params.toString()}`;
}

export function hopsPath(period: PeriodId, range: TimeSpan | null = null): string {
  return spanned(`/flow/${period}/hops`, range);
}

export function foundationPath(period: PeriodId): string {
  return `/foundation?period=${period}`;
}

export const fetchApps = (period: PeriodId, signal?: AbortSignal) =>
  cachedFetch<AppPayments>(`/apps?period=${period}`, signal);

export const fetchCounterparties = (address: string, signal?: AbortSignal) =>
  cachedFetch<WalletCounterparties>(
    `/wallets/${encodeURIComponent(address)}/counterparties?limit=15`,
    signal
  );

/** Source (`in`) or destination (`out`) of a wallet's funds, `hops` wallets deep (#64). */
export const fetchFunds = (
  address: string,
  direction: 'in' | 'out',
  hops: number,
  signal?: AbortSignal
) =>
  cachedFetch<WalletFunds>(
    `/wallets/${encodeURIComponent(address)}/${direction === 'in' ? 'sources' : 'destinations'}?hops=${hops}`,
    signal
  );

/** One wallet's senders and/or recipients for the fund-flow graph (#63). */
export function fetchGraph(
  query: {
    address: string;
    direction: 'in' | 'out' | 'both';
    period: PeriodId | null;
    minAmount: number;
  },
  signal?: AbortSignal
): Promise<FlowGraph> {
  const params = new URLSearchParams({ address: query.address, direction: query.direction });
  if (query.period) params.set('period', query.period);
  if (query.minAmount > 0) params.set('minAmount', String(query.minAmount));
  return cachedFetch<FlowGraph>(`/graph?${params.toString()}`, signal);
}

/** Entities (#65), largest first, optionally matching a name. */
export const fetchEntities = (query: string, signal?: AbortSignal) =>
  cachedFetch<EntityList>(
    `/entities?limit=500${query ? `&q=${encodeURIComponent(query)}` : ''}`,
    signal
  );

export const entityPath = (id: string, period: PeriodId) =>
  `/entities/${encodeURIComponent(id)}?period=${period}`;

export const fetchEntity = (id: string, period: PeriodId, signal?: AbortSignal) =>
  cachedFetch<EntityReport>(entityPath(id, period), signal);

export const fetchClusters = (unnamed: boolean, signal?: AbortSignal) =>
  cachedFetch<{ clusters: ClusterSummary[] }>(
    `/clusters?limit=25${unnamed ? '&unnamed=1' : ''}`,
    signal
  );

export const fetchHops = (period: PeriodId, range: TimeSpan | null, signal?: AbortSignal) =>
  cachedFetch<HopsResponse>(hopsPath(period, range), signal);

export const fetchFoundation = (period: PeriodId, signal?: AbortSignal) =>
  cachedFetch<Foundation>(foundationPath(period), signal);

export function seriesPath(period: PeriodId): string {
  return `/flow/${period}/series`;
}

export const fetchSummary = (period: PeriodId, range: TimeSpan | null, signal?: AbortSignal) =>
  cachedFetch<FlowSummary>(summaryPath(period, range), signal);

export const fetchBoard = async (
  period: PeriodId,
  side: 'buyers' | 'sellers',
  who: BoardKind,
  sure: Certainty,
  tag: BehaviourTagName | '',
  range: TimeSpan | null,
  signal?: AbortSignal
): Promise<Leaderboard> =>
  normaliseBoard(
    await cachedFetch<Leaderboard>(boardPath(period, side, who, sure, tag, range), signal),
    side
  );

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
    change: row.change ?? Number.NaN,
    confidence: row.confidence ?? null,
    level: row.level ?? null,
    labelSource: row.labelSource ?? null,
    tags: row.tags ?? []
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

/** What the path finder (#70) is asked: two wallets and how hard to look. */
export interface PathQuery {
  readonly src: string;
  readonly dst: string;
  readonly maxHops: number;
  readonly throughExchanges: boolean;
  readonly period: PeriodId | null;
}

export function pathPath(query: PathQuery): string {
  const params = new URLSearchParams({
    src: query.src,
    dst: query.dst,
    maxHops: String(query.maxHops)
  });
  if (query.throughExchanges) params.set('through', 'exchanges');
  if (query.period) params.set('period', query.period);
  return `/path?${params.toString()}`;
}

export const fetchPath = (query: PathQuery, signal?: AbortSignal) =>
  cachedFetch<PathResult>(pathPath(query), signal);

export function search(query: string, signal?: AbortSignal): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query, limit: '10' });
  return apiFetch<SearchResponse>(`/search?${params.toString()}`, signal ? { signal } : {});
}

/** FLUX transparent address: `t1`/`t3` + 33 base58 characters. Mirrors the server's check. */
/** A wallet's current balance and daily balance history (#67). Not cached: it reads the node. */
export function fetchBalance(address: string, signal?: AbortSignal): Promise<BalanceHistory> {
  return apiFetch<BalanceHistory>(
    `/wallets/${encodeURIComponent(address)}/balance`,
    signal ? { signal } : {}
  );
}

/** An entity's combined balance history (#67). */
export function fetchEntityBalance(id: string, signal?: AbortSignal): Promise<BalanceHistory> {
  return apiFetch<BalanceHistory>(
    `/entities/${encodeURIComponent(id)}/balance`,
    signal ? { signal } : {}
  );
}

/** One transaction's parties, funder shares, flows and hop legs (#66). */
export function fetchTx(txid: string, signal?: AbortSignal): Promise<TxDetail> {
  return cachedFetch<TxDetail>(`/tx/${encodeURIComponent(txid)}`, signal);
}

export function isAddress(value: string): boolean {
  return /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/.test(value);
}

export function isTxid(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}
