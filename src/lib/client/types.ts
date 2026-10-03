/**
 * Shapes of the API responses the UI reads.
 *
 * Declared here rather than imported from `$lib/server`, which must never reach the browser
 * bundle. Only the fields the UI uses are listed.
 */

import type { PeriodId } from '$lib/shared/constants';

export type FlowType = 'buying' | 'selling' | 'p2p';
export type AddressKind = 'exchange' | 'foundation' | 'node_operator' | 'unknown';

export interface ExchangeTotal {
  readonly name: string;
  readonly total: number;
  readonly count: number;
}

export interface Direction {
  readonly total: number;
  readonly count: number;
  /** Keys are `to*` for buying and `from*` for selling: NodeOperators, Unknown, Foundation, Exchanges. */
  readonly breakdown: Record<string, number>;
  readonly byExchange: Record<string, ExchangeTotal>;
}

export interface FlowSummary {
  readonly period: PeriodId;
  readonly label?: string;
  readonly ready: boolean;
  readonly partial: boolean;
  readonly partialWarning?: string | null;
  readonly message?: string;
  readonly progress: number;
  readonly blocksNeeded: number;
  readonly blocksSynced: number;
  readonly blockRange?: { newest: number; oldest: number; count: number };
  readonly buying?: Direction;
  readonly selling?: Direction;
  readonly netFlow?: number;
  /** Totals by counterparty kind, keyed `unknown`, `node_operator`, `foundation`. */
  readonly byType?: { buying: Record<string, number>; selling: Record<string, number> };
  /** The equally long window before this one, for comparisons. */
  readonly previousPeriod?: {
    readonly from: number;
    readonly to: number;
    readonly buying: { total: number; count: number };
    readonly selling: { total: number; count: number };
    readonly netFlow: number;
  };
}

export interface FlowEvent {
  readonly txid: string;
  readonly vout: number;
  readonly height: number;
  readonly time: number;
  readonly fromAddress: string;
  readonly fromKind: AddressKind;
  readonly toAddress: string;
  readonly toKind: AddressKind;
  readonly exchange: string | null;
  readonly flowType: FlowType;
  readonly amount: number;
}

export interface EventsPage {
  readonly events: FlowEvent[];
  readonly nextCursor: string | null;
}

export interface Counterparty {
  readonly rank: number;
  readonly address: string;
  readonly name: string | null;
  readonly kind: AddressKind;
  readonly total: number;
  readonly count: number;
  /** Fraction of the direction's total for the period, 0–1. */
  readonly share: number;
  readonly exchanges: ExchangeTotal[];
  readonly lastSeen: number | null;
  /** The same wallet and direction over the window before this one. */
  readonly previousTotal: number;
  readonly change: number;
}

export interface Leaderboard {
  readonly period: PeriodId;
  readonly flowType: 'buying' | 'selling';
  readonly total: number;
  readonly sellers?: Counterparty[];
  readonly buyers?: Counterparty[];
}

export interface SeriesPoint {
  /** Bucket start, unix seconds. */
  readonly time: number;
  readonly buying: number;
  readonly selling: number;
  readonly net: number;
  readonly cumulativeNet: number;
}

export interface Series {
  readonly period: PeriodId;
  readonly bucketSeconds: number;
  readonly points: SeriesPoint[];
}

export interface WalletProfile {
  readonly address: string;
  readonly kind: AddressKind;
  readonly name: string | null;
  readonly labels: { kind: string; name: string | null; source: string; confidence: number }[];
  readonly totals: {
    readonly bought: number;
    readonly sold: number;
    readonly net: number;
    readonly boughtCount: number;
    readonly soldCount: number;
    readonly p2pIn: number;
    readonly p2pOut: number;
  };
  readonly byExchange: { name: string; bought: number; sold: number; count: number }[];
  readonly firstSeen: number | null;
  readonly lastSeen: number | null;
  readonly series: { time: number; bought: number; sold: number }[];
  readonly recent: EventsPage;
}

export type SearchResult =
  | { type: 'wallet'; address: string; name: string | null; kind: AddressKind }
  | { type: 'tx'; txid: string; height: number };

export interface SearchResponse {
  readonly query: string;
  readonly results: SearchResult[];
}

/** Server-Sent Events from `GET /api/stream` (#32). */
export type LiveEvent =
  | { readonly type: 'sync'; readonly height: number | null; readonly dataVersion: number }
  | (Omit<FlowEvent, 'flowType'> & { readonly type: 'flow'; readonly flowType: FlowType });

export interface SourceStatus {
  readonly id: string;
  readonly description: string;
  readonly state: 'closed' | 'open' | 'half-open' | string;
}

export interface Status {
  readonly version?: string;
  readonly uptimeSeconds?: number;
  readonly sync: {
    readonly enabled: boolean;
    readonly latestHeight: number;
    readonly oldestHeight: number;
    readonly lastSuccessfulSyncAt: number | null;
    readonly degraded: boolean;
    readonly reason?: string;
  };
  readonly ingest?: { readonly blocksPerMinute: number; readonly running: boolean };
  readonly database: {
    readonly blocks: number;
    readonly flows: number;
    readonly missingBlocks: number;
    readonly sizeBytes: number;
  };
  readonly dataSources: { readonly active: string | null; readonly sources: SourceStatus[] };
}
