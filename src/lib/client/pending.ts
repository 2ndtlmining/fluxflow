/**
 * Endpoints being built in strand B (#28, #29, #30), wired here once their shapes are final.
 *
 * Every function returns `null` until then, and the UI hides or degrades the section that
 * needs it. Nothing here calls a server route that does not exist yet.
 *
 * TODO(#29): GET /api/flow/:period/series — net flow over time.
 * TODO(#28): richer leaderboards — per-exchange split, previous-period delta, kind filter.
 * TODO(#30): GET /api/wallets/:address and GET /api/wallets/search?q=.
 */

import type { PeriodId } from '$lib/shared/constants';

export interface SeriesPoint {
  /** Bucket start, unix seconds. */
  readonly t: number;
  readonly buying: number;
  readonly selling: number;
}

export interface WalletProfile {
  readonly address: string;
  readonly kind: string;
  readonly label: string | null;
  readonly bought: number;
  readonly sold: number;
  readonly firstSeen: number | null;
  readonly lastSeen: number | null;
}

export interface WalletMatch {
  readonly address: string;
  readonly label: string | null;
}

// TODO(#29): replace with cachedFetch(`/flow/${period}/series`, signal) once it exists.
export async function fetchSeries(
  period: PeriodId,
  signal?: AbortSignal
): Promise<SeriesPoint[] | null> {
  void period;
  void signal;
  return null;
}

// TODO(#30): replace with cachedFetch(`/wallets/${address}`, signal) once it exists.
export async function fetchWallet(
  address: string,
  signal?: AbortSignal
): Promise<WalletProfile | null> {
  void address;
  void signal;
  return null;
}

// TODO(#30): replace with apiFetch(`/wallets/search?q=…`) once it exists.
export async function searchWallets(
  query: string,
  signal?: AbortSignal
): Promise<WalletMatch[] | null> {
  void query;
  void signal;
  return null;
}
