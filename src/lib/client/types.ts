/**
 * Shapes of the API responses the UI reads.
 *
 * Declared here rather than imported from `$lib/server`, which must never reach the browser
 * bundle. Only the fields the UI uses are listed.
 */

import type { PeriodId } from '$lib/shared/constants';

export type FlowType = 'buying' | 'selling' | 'p2p';
export type AddressKind = 'exchange' | 'foundation' | 'node_operator' | 'app_hosting' | 'unknown';

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
  /** The span the figures cover when one was picked on the chart (#29), as clamped. */
  readonly range?: { readonly from: number; readonly to: number } | null;
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
  /** Behaviour tags (#68); empty from an older server. */
  readonly tags: BehaviourTagName[];
}

/** How a wallet behaves (#68): informational, never part of its kind. */
export type BehaviourTagName =
  'recurring_payer' | 'automated' | 'collateral_amounts' | 'dormant_waking' | 'peel_chain';

export interface BehaviourTag {
  readonly tag: BehaviourTagName;
  readonly evidence: Record<string, unknown>;
  readonly updatedAt: number;
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
  /** Paid as Flux app hosting fees; absent from a server older than the app-hosting kind. */
  readonly apps?: number;
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
  /** The entity this address belongs to (#65), if any. */
  readonly entity?: EntityRef | null;
  /** Behaviour tags with their evidence (#68); absent from an older server. */
  readonly tags?: BehaviourTag[];
  /** The reader's own note and tags (#69), and the cases this wallet is in. */
  readonly note?: WalletNote | null;
  readonly cases?: { readonly id: string; readonly name: string }[];
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
  | {
      type: 'wallet';
      address: string;
      name: string | null;
      kind: AddressKind;
      /** The reader's note, when the wallet has one (#69). */
      note?: WalletNote | null;
    }
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

/** A counterparty of a wallet, or of the app hosting addresses. */
export interface Party {
  readonly address: string;
  readonly kind: AddressKind;
  readonly name: string | null;
  readonly total: number;
  readonly count: number;
  /** Fraction of that side's total. */
  readonly share: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
}

export interface CounterpartySide {
  readonly total: number;
  readonly count: number;
  readonly distinct: number;
  readonly parties: Party[];
}

export interface WalletCounterparties {
  readonly address: string;
  readonly incoming: CounterpartySide;
  readonly outgoing: CounterpartySide;
  readonly firstFunder: {
    readonly address: string;
    readonly kind: AddressKind;
    readonly name: string | null;
    readonly txid: string;
    readonly time: number;
    readonly amount: number;
  } | null;
  readonly appPayments: { readonly total: number; readonly count: number };
  /**
   * A Foundation wallet's moves to and from the Foundation's other wallets, which are never
   * flows; null for other wallets, absent from an older server.
   */
  readonly foundationMoves?: {
    readonly incoming: CounterpartySide;
    readonly outgoing: CounterpartySide;
  } | null;
}

/** A wallet kind, or coinbase rewards (source of funds), or money a wallet kept (destination). */
export type FundsKind = AddressKind | 'node_rewards' | 'held';

/** FLUX (or, in `fundingOfPayments`, fractions) by the kind of wallet. */
export type KindMix = Partial<Record<FundsKind, number>>;

/** `/api/wallets/:address/sources` and `/destinations` (#64). */
export interface WalletFunds {
  readonly address: string;
  readonly direction: 'in' | 'out';
  readonly hops: number;
  readonly total: number;
  readonly byKind: KindMix;
  readonly byExchange: Record<string, number>;
  readonly endpoints: {
    readonly address: string;
    readonly kind: AddressKind;
    readonly name: string | null;
    readonly amount: number;
    readonly hop: number;
  }[];
  readonly untraced: number;
  readonly truncated: boolean;
}

export interface AppPayer {
  readonly address: string;
  readonly kind: AddressKind;
  readonly name: string | null;
  readonly total: number;
  readonly count: number;
  readonly share: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly fundedBy: { readonly received: number; readonly mix: KindMix };
  readonly topFunders: {
    readonly address: string;
    readonly kind: AddressKind;
    readonly name: string | null;
    readonly total: number;
  }[];
}

export interface AppPayments {
  readonly period: PeriodId;
  readonly label: string;
  readonly fromTime: number;
  readonly toTime: number;
  readonly hosting: { readonly address: string; readonly name: string | null }[];
  readonly total: number;
  readonly count: number;
  readonly payers: number;
  readonly byPayerKind: KindMix;
  readonly series: { readonly time: number; readonly total: number; readonly count: number }[];
  readonly topPayers: AppPayer[];
  readonly fundingOfPayments: KindMix;
  readonly outflows: { readonly total: number; readonly recipients: Party[] };
}

/** `/api/graph` (#63): one wallet's neighbourhood. */
export interface GraphNode {
  readonly address: string;
  readonly kind: AddressKind;
  readonly name: string | null;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly total: number;
  readonly count: number;
  readonly first: number;
  readonly last: number;
}

export interface GraphSide {
  readonly more: number;
  readonly sampled: boolean;
}

export interface FlowGraph {
  readonly root: string;
  readonly direction: 'in' | 'out' | 'both';
  readonly depth: number;
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  readonly expanded: Record<string, { in?: GraphSide; out?: GraphSide }>;
  readonly truncated: boolean;
}

/** One owner behind many addresses (#65): from labels, or named on the review page. */
export interface EntityRef {
  readonly id: string;
  readonly name: string;
  readonly kind: AddressKind;
  readonly source: 'label' | 'stored';
  readonly members: number;
}

export type MemberSource = 'label' | 'manual' | 'cluster';

export interface EntityParty {
  readonly entity: { readonly id: string; readonly members: number } | null;
  readonly address: string;
  readonly name: string | null;
  readonly kind: AddressKind;
  readonly total: number;
  readonly count: number;
  readonly share: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
}

export interface EntityReport {
  readonly period: PeriodId;
  readonly label: string;
  readonly fromTime: number;
  readonly toTime: number;
  readonly entity: EntityRef;
  readonly totals: Foundation['totals'];
  readonly series: Foundation['series'];
  readonly recent: FoundationMovement[];
  readonly wallets: (FoundationWallet & { readonly source: MemberSource })[];
  readonly memberSources: Record<MemberSource, number>;
  readonly incoming: { readonly total: number; readonly parties: EntityParty[] };
  readonly outgoing: { readonly total: number; readonly parties: EntityParty[] };
  readonly appPayments: { readonly total: number; readonly count: number };
}

export interface EntityList {
  readonly total: number;
  readonly entities: EntityRef[];
}

export interface ClusterSummary {
  readonly anchor: string;
  readonly size: number;
  readonly sample: string[];
  readonly entities: {
    readonly id: string;
    readonly name: string;
    readonly kind: AddressKind;
    readonly members: number;
  }[];
  readonly unassigned: number;
  readonly received: number;
  readonly sent: number;
}

/** One transaction as FluxFlow classified it (#66). */
export interface TxParty {
  readonly address: string;
  /** Current classification. */
  readonly kind: AddressKind;
  readonly name: string | null;
  readonly label: {
    readonly source: string;
    readonly confidence: number;
    readonly level: ConfidenceLevel;
    readonly subLabel: string | null;
  } | null;
  readonly entity: { readonly id: string; readonly name: string } | null;
  readonly sent: number;
  readonly received: number;
  readonly net: number;
  readonly role: 'funder' | 'recipient' | 'change';
  /** A funder's part of all net input. */
  readonly share: number | null;
}

export interface TxFlow {
  readonly vout: number;
  readonly fromAddress: string;
  readonly toAddress: string;
  /** As classified when the row was derived. */
  readonly fromKind: AddressKind;
  readonly toKind: AddressKind;
  readonly exchange: string | null;
  readonly flowType: FlowType;
  readonly amount: number;
  /** This row's part of what the recipient received. */
  readonly share: number;
  readonly stale: boolean;
}

export interface TxHop {
  readonly leg: 'buy' | 'sell';
  readonly address: string;
  readonly fromExchange: string;
  readonly toExchange: string;
  readonly withdrawn: number;
  readonly deposited: number;
  readonly otherTxid: string;
  readonly blocksApart: number;
}

export interface TxDetail {
  readonly txid: string;
  readonly height: number;
  readonly time: number;
  readonly totalIn: number;
  readonly totalOut: number;
  readonly fee: number;
  readonly parties: TxParty[];
  readonly flows: TxFlow[];
  readonly hops: TxHop[];
  readonly note: string | null;
}

/** What a wallet or entity holds, and held over the stored window (#67). */
export interface BalanceHistory {
  /** Current balance, or null when no node answered. */
  readonly balance: number | null;
  /** When `balance` was read, ms. */
  readonly asOf: number | null;
  /** What it held before the first stored day. */
  readonly opening: number | null;
  /** Days with activity, oldest first. */
  readonly series: {
    readonly time: number;
    readonly net: number;
    readonly change: number;
    readonly balance: number | null;
  }[];
  /** False when the rebuilt history would dip below zero: data is missing. */
  readonly consistent: boolean;
  readonly tipHeight: number | null;
}

/** One hop of a path between two wallets (#70). */
export interface PathHop {
  readonly from: string;
  readonly to: string;
  readonly total: number;
  readonly count: number;
  readonly first: number;
  readonly last: number;
  /** A move between Foundation wallets, never counted as a transfer elsewhere. */
  readonly internal: boolean;
}

export interface PathResult {
  readonly src: string;
  readonly dst: string;
  readonly maxHops: number;
  readonly throughExchanges: boolean;
  readonly paths: { readonly hops: PathHop[]; readonly bottleneck: number }[];
  readonly nodes: Record<string, { readonly kind: AddressKind; readonly name: string | null }>;
  readonly explored: { readonly forward: number; readonly backward: number };
  readonly trimmed: number;
  readonly truncated: boolean;
}

/** A wallet's note and custom tags (#69): the reader's own words, never a label. */
export interface WalletNote {
  readonly address: string;
  readonly note: string;
  readonly tags: string[];
  readonly updatedAt: number;
}

/** The fund-flow graph view saved with a case (#69). */
export interface CaseGraph {
  readonly root: string;
  readonly period: string | null;
  readonly min: number;
  /** Expansions to replay, `address:in` or `address:out`, in order. */
  readonly expand: string[];
}

export interface CaseSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly count: number;
  readonly updatedAt: number;
}

export interface CaseDetail {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly addresses: string[];
  readonly graph: CaseGraph | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly members: {
    readonly address: string;
    readonly kind: AddressKind;
    readonly name: string | null;
    readonly note: WalletNote | null;
  }[];
}
