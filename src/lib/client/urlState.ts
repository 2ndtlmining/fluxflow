/**
 * Dashboard state that lives in the URL (#26, #27).
 *
 * The period, the leaderboard filter and every transaction filter are query parameters, so
 * a view can be shared, bookmarked and refreshed without losing its place. Defaults are left
 * out of the URL, which keeps the plain `/` link canonical.
 */

import { DEFAULT_PERIOD, isPeriodId, type PeriodId } from '$lib/shared/constants';
import type { AddressKind, BehaviourTagName, FlowType } from './types';

/**
 * What the transactions explorer lists. `exchange` (the default) is buying and selling
 * together, merged client-side; `all` adds wallet-to-wallet transfers.
 */
export type TxView = 'exchange' | 'all' | FlowType;

/** Leaderboards can be narrowed to one kind of counterparty (#28). */
export type BoardKind = '' | 'unknown' | 'node_operator' | 'foundation';

/** Minimum label confidence for a labelled leaderboard (#19); '' means any. */
export type Certainty = '' | 'confirmed' | 'likely' | 'possible';

export interface TxFilters {
  readonly type: TxView;
  readonly kind: AddressKind | '';
  readonly exchange: string;
  /** Minimum amount in FLUX; 0 means no minimum. */
  readonly min: number;
}

/** A span picked on the over-time chart (#29): `[from, to)` in unix seconds. */
export interface TimeSpan {
  readonly from: number;
  readonly to: number;
}

export interface DashboardState {
  readonly period: PeriodId;
  readonly who: BoardKind;
  /** Only meaningful for labelled kinds; ignored (and dropped from the URL) for unlabelled. */
  readonly sure: Certainty;
  /** Leave exchange-to-exchange hops out of the headline and breakdowns (#20). */
  readonly noHops: boolean;
  /** Narrow the leaderboards to wallets with one behaviour tag (#68); '' means any. */
  readonly tag: BehaviourTagName | '';
  /** A span inside the period that narrows everything but the chart (#29); null for all of it. */
  readonly range: TimeSpan | null;
  readonly filters: TxFilters;
}

export const EMPTY_FILTERS: TxFilters = { type: 'exchange', kind: '', exchange: '', min: 0 };

const VIEWS: readonly string[] = ['exchange', 'all', 'buying', 'selling', 'p2p'];
const KINDS: readonly string[] = [
  'exchange',
  'foundation',
  'node_operator',
  'app_hosting',
  'unknown'
];
const BOARD_KINDS: readonly string[] = ['unknown', 'node_operator', 'foundation'];
const CERTAINTIES: readonly string[] = ['confirmed', 'likely', 'possible'];
const TAGS: readonly string[] = [
  'recurring_payer',
  'automated',
  'collateral_amounts',
  'dormant_waking',
  'peel_chain'
];

/** Parse, ignoring anything malformed rather than failing: a bad link still opens the page. */
export function readState(params: URLSearchParams): DashboardState {
  const period = (params.get('period') ?? '').toUpperCase();
  const type = params.get('type') ?? '';
  const kind = params.get('kind') ?? '';
  const who = params.get('who') ?? '';
  const sure = params.get('minConfidence') ?? '';
  const tag = params.get('tag') ?? '';
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));
  const exchange = (params.get('exchange') ?? '').slice(0, 40);
  const min = Number(params.get('min'));

  return {
    period: isPeriodId(period) ? period : DEFAULT_PERIOD,
    who: BOARD_KINDS.includes(who) ? (who as BoardKind) : '',
    // A confidence filter on unlabelled wallets would always be empty, so it needs a kind.
    sure: CERTAINTIES.includes(sure) && who && who !== 'unknown' ? (sure as Certainty) : '',
    noHops: params.get('hops') === 'exclude',
    tag: TAGS.includes(tag) ? (tag as BehaviourTagName) : '',
    range:
      Number.isInteger(from) && Number.isInteger(to) && from > 0 && from < to ? { from, to } : null,
    filters: {
      type: VIEWS.includes(type) ? (type as TxView) : 'exchange',
      kind: KINDS.includes(kind) ? (kind as AddressKind) : '',
      exchange,
      min: Number.isFinite(min) && min > 0 ? min : 0
    }
  };
}

/** The query string for a state, without the leading `?`; empty for all defaults. */
export function writeState(state: DashboardState): string {
  const params = new URLSearchParams();
  if (state.period !== DEFAULT_PERIOD) params.set('period', state.period);
  if (state.who) params.set('who', state.who);
  if (state.sure && state.who && state.who !== 'unknown') params.set('minConfidence', state.sure);
  if (state.noHops) params.set('hops', 'exclude');
  if (state.tag) params.set('tag', state.tag);
  if (state.range) {
    params.set('from', String(state.range.from));
    params.set('to', String(state.range.to));
  }
  if (state.filters.type !== 'exchange') params.set('type', state.filters.type);
  if (state.filters.kind) params.set('kind', state.filters.kind);
  if (state.filters.exchange) params.set('exchange', state.filters.exchange);
  if (state.filters.min > 0) params.set('min', String(state.filters.min));
  return params.toString();
}

/**
 * A link to the transfers behind one breakdown number (#28): the same period and
 * leaderboard view, with the transaction filters replaced by `filters`, scrolled to the
 * transfers list.
 */
export function transfersHref(state: DashboardState, filters: Partial<TxFilters>): string {
  const query = writeState({ ...state, filters: { ...EMPTY_FILTERS, ...filters } });
  return `/${query ? `?${query}` : ''}#tx-heading`;
}

/**
 * The directions to request for a view: two for `exchange`, none (unfiltered) for `all`.
 * Each entry becomes one stream for the merged pager.
 */
export function directionsFor(view: TxView): (FlowType | null)[] {
  if (view === 'exchange') return ['buying', 'selling'];
  if (view === 'all') return [null];
  return [view];
}

/** The events endpoint path for one direction, filter set and page. */
export function eventsPath(
  period: PeriodId,
  direction: FlowType | null,
  filters: TxFilters,
  options: { cursor?: string | null; limit?: number; range?: TimeSpan | null } = {}
): string {
  const params = new URLSearchParams();
  withRange(params, options.range ?? null);
  if (direction) params.set('type', direction);
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.exchange) params.set('exchange', filters.exchange);
  if (filters.min > 0) params.set('minAmount', String(filters.min));
  params.set('limit', String(options.limit ?? 50));
  if (options.cursor) params.set('cursor', options.cursor);
  return `/flow/${period}/events?${params.toString()}`;
}

/** Add a picked span (#29) to an API query. */
export function withRange(params: URLSearchParams, range: TimeSpan | null): URLSearchParams {
  if (range) {
    params.set('from', String(range.from));
    params.set('to', String(range.to));
  }
  return params;
}

export function hasFilters(filters: TxFilters): boolean {
  return Boolean(
    filters.type !== 'exchange' || filters.kind || filters.exchange || filters.min > 0
  );
}
