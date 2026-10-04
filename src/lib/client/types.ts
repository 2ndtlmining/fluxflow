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
  /** Exchange-to-exchange hops in the period, counted once each way in the totals (#20). */
  readonly exchangeHops?: { count: number; buyingExcluded: number; sellingExcluded: number };
  /** The headline totals with those hops left out. */
  readonly adjusted?: { buying: number; selling: number; netFlow: number };
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
  /** How sure the label behind `kind` is (#19); null for an unlabelled wallet. */
  readonly confidence: number | null;
  readonly level: ConfidenceLevel | null;
  /** Where the label came from, e.g. `node_list`, `forwarding`, `config`. */
  readonly labelSource: string | null;
}

/** Confidence bands (#19): confirmed ≥ 0.95, likely ≥ 0.7, possible ≥ 0.45. */
export type ConfidenceLevel = 'confirmed' | 'likely' | 'possible' | 'candidate';

export interface WalletLabel {
  readonly kind: string;
  readonly name: string | null;
  readonly subLabel?: string | null;
  readonly source: string;
  readonly confidence: number;
  readonly level?: ConfidenceLevel;
  /** Whether this label is the one that classifies the wallet's flows. */
  readonly applied?: boolean;
  readonly validFrom?: number | null;
  readonly validTo?: number | null;
  readonly evidence?: Record<string, unknown> | null;
}

/** A withdrawal re-deposited to another exchange by the same wallet soon after (#20). */
export interface ExchangeHop {
  readonly address: string;
  readonly fromExchange: string;
  readonly toExchange: string;
  /** FLUX withdrawn from `fromExchange`. */
  readonly withdrawn: number;
  /** FLUX deposited to `toExchange`. */
  readonly amount: number;
  readonly blocksApart: number;
  readonly buyTxid: string;
  readonly sellTxid: string;
  readonly sellHeight: number;
  readonly sellTime: number;
}

export interface HopsResponse {
  readonly period: PeriodId;
  readonly summary: { count: number; buyingExcluded: number; sellingExcluded: number };
  readonly hops: ExchangeHop[];
}

export interface FoundationWallet {
  readonly address: string;
  readonly name: string | null;
  readonly subLabel: string | null;
  /** Null when the server has no node with an address index to ask. */
  readonly balance: number | null;
  readonly inflow: number;
  readonly outflow: number;
  readonly net: number;
}

export interface FoundationMovement {
  readonly txid: string;
  readonly height: number;
  readonly time: number;
  /** Signed: negative left the Foundation, positive arrived. */
  readonly amount: number;
  readonly counterparty: string;
  readonly counterpartyName: string | null;
  readonly counterpartyKind: AddressKind;
  readonly wallets: string[];
}

export interface DestinationTotals {
  readonly exchange: number;
  readonly byExchange: Record<string, number>;
  readonly nodes: number;
  readonly collateral: {
    readonly payments: number;
    readonly amount: number;
    /** Exactly a collateral amount but not used by a live node; informational. */
    readonly unconfirmedPayments: number;
    readonly unconfirmedAmount: number;
  };
  readonly returned: number;
  readonly held: number;
  readonly untraced: number;
}

export interface RecipientDestinations extends DestinationTotals {
  readonly address: string;
  readonly name: string | null;
  readonly kind: AddressKind;
  readonly subLabel: string | null;
  readonly received: number;
  readonly hops: number;
}

/** Where Foundation outflows ended up, followed up to `maxHops` wallets deep. */
export interface FoundationDestinations extends DestinationTotals {
  readonly traced: number;
  readonly maxHops: number;
  readonly hopBlocks: number;
  readonly recipients: RecipientDestinations[];
  /** The trace hit its work budget; the remainder is in `untraced`. */
  readonly truncated?: boolean;
}

export interface Foundation {
  readonly period: PeriodId;
  readonly wallets: FoundationWallet[];
  readonly totals: {
    readonly balance: number | null;
    readonly inflow: number;
    readonly outflow: number;
    readonly net: number;
    readonly internalTransfers: number;
    readonly internalVolume: number;
  };
  readonly series: { time: number; net: number; balance: number | null }[];
  readonly recent: FoundationMovement[];
  readonly balancesAsOf: number | null;
  readonly destinations?: FoundationDestinations;
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
  /** The label that classifies this wallet's flows, if any. */
  readonly label?: WalletLabel | null;
  /** Every label on record, applied or not. */
  readonly labels: WalletLabel[];
  readonly cluster?: { clusterId: string; size: number; sample: string[] } | null;
  readonly candidates?: WalletLabel[];
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
    /** Still syncing towards the network tip (a fresh deploy syncs six months first). */
    readonly catchUp?: {
      readonly tip: number | null;
      readonly behindBlocks: number | null;
      readonly catchingUp: boolean;
      readonly progress: number | null;
      readonly dataFrom: number | null;
      readonly dataAsOf: number | null;
      readonly etaSeconds: number | null;
    };
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
