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
  readonly address: string;
  readonly kind: AddressKind;
  readonly total: number;
  readonly count: number;
  readonly exchanges: string[];
}

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
