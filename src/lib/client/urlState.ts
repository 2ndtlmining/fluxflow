/**
 * Dashboard state that lives in the URL (#26, #27).
 *
 * The period and every transaction filter are query parameters, so a view can be shared,
 * bookmarked and refreshed without losing its place. Defaults are left out of the URL, which
 * keeps the plain `/` link canonical.
 */

import { DEFAULT_PERIOD, isPeriodId, type PeriodId } from '$lib/shared/constants';
import type { AddressKind, FlowType } from './types';

export interface TxFilters {
  readonly type: FlowType | '';
  readonly kind: AddressKind | '';
  readonly exchange: string;
  /** Minimum amount in FLUX; 0 means no minimum. */
  readonly min: number;
}

export interface DashboardState {
  readonly period: PeriodId;
  readonly filters: TxFilters;
}

export const EMPTY_FILTERS: TxFilters = { type: '', kind: '', exchange: '', min: 0 };

const FLOW_TYPES: readonly string[] = ['buying', 'selling', 'p2p'];
const KINDS: readonly string[] = ['exchange', 'foundation', 'node_operator', 'unknown'];

/** Parse, ignoring anything malformed rather than failing: a bad link still opens the page. */
export function readState(params: URLSearchParams): DashboardState {
  const period = (params.get('period') ?? '').toUpperCase();
  const type = params.get('type') ?? '';
  const kind = params.get('kind') ?? '';
  const exchange = (params.get('exchange') ?? '').slice(0, 40);
  const min = Number(params.get('min'));

  return {
    period: isPeriodId(period) ? period : DEFAULT_PERIOD,
    filters: {
      type: FLOW_TYPES.includes(type) ? (type as FlowType) : '',
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
  if (state.filters.type) params.set('type', state.filters.type);
  if (state.filters.kind) params.set('kind', state.filters.kind);
  if (state.filters.exchange) params.set('exchange', state.filters.exchange);
  if (state.filters.min > 0) params.set('min', String(state.filters.min));
  return params.toString();
}

/** The events endpoint path for a period, filter set and page. */
export function eventsPath(
  period: PeriodId,
  filters: TxFilters,
  options: { cursor?: string | null; limit?: number } = {}
): string {
  const params = new URLSearchParams();
  if (filters.type) params.set('type', filters.type);
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.exchange) params.set('exchange', filters.exchange);
  if (filters.min > 0) params.set('minAmount', String(filters.min));
  params.set('limit', String(options.limit ?? 50));
  if (options.cursor) params.set('cursor', options.cursor);
  return `/flow/${period}/events?${params.toString()}`;
}

export function hasFilters(filters: TxFilters): boolean {
  return Boolean(filters.type || filters.kind || filters.exchange || filters.min > 0);
}
