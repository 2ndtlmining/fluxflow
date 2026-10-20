/**
 * One transaction, the way FluxFlow sees it (#66).
 *
 * The block explorer shows inputs and outputs; this shows what FluxFlow made of them: every
 * address's net position (inputs from one address are already collapsed in `tx_deltas`), who
 * counted as a funder and with what share, the flow rows derived from it, and whether any of
 * them is half of an exchange hop. That is what answers "why is this a sale?", especially for
 * multi-input sweeps, where each funder is credited its proportional share of every output
 * (`splitByFunder` in `ingest/derive.ts`).
 *
 * Labels are shown twice on purpose. A flow row keeps the kinds it was classified with; the
 * party list carries the label as it is now. When they disagree the row is `stale`: it will be
 * re-derived on the next relabel pass.
 *
 * Everything is read through primary keys (`tx_deltas`, `flows` lead with `txid`) and the
 * `exchange_hops` keys, so the cost is the size of the transaction, not of the database.
 */

import type { Db } from '../db/database.js';
import type { AddressKind } from '../ingest/datasource/types.js';
import { SATS_PER_FLUX } from '../ingest/datasource/types.js';
import { confidenceLevel, type ConfidenceLevel, type LabelLookup } from '../labels.js';
import type { EntityIndex } from '../intel/entities.js';

/** A transaction id: 64 hex characters. Checked before it reaches a query (#21). */
export const TXID_PATTERN = /^[0-9a-fA-F]{64}$/;

export type PartyRole = 'funder' | 'recipient' | 'change';

export interface TxParty {
  readonly address: string;
  /** Current classification, as a flow derived now would use it. */
  readonly kind: AddressKind;
  readonly name: string | null;
  /** The applied label behind `kind`, or `null` for an unlabelled wallet. */
  readonly label: {
    readonly source: string;
    readonly confidence: number;
    readonly level: ConfidenceLevel;
    readonly subLabel: string | null;
  } | null;
  readonly entity: { readonly id: string; readonly name: string } | null;
  /** FLUX spent from this address's inputs, and received in its outputs. */
  readonly sent: number;
  readonly received: number;
  /** `received - sent`. Positive for a recipient, negative for a funder. */
  readonly net: number;
  /** A funder paid in more than it got back; `change` nets to exactly zero. */
  readonly role: PartyRole;
  /** A funder's part of all net input: the share of every output credited to it. */
  readonly share: number | null;
}

export interface TxFlow {
  readonly vout: number;
  readonly fromAddress: string;
  readonly toAddress: string;
  /** The kinds this row was classified with when it was derived. */
  readonly fromKind: AddressKind;
  readonly toKind: AddressKind;
  readonly exchange: string | null;
  readonly flowType: 'buying' | 'selling' | 'p2p';
  readonly amount: number;
  /** This row's part of what the recipient received in the transaction. */
  readonly share: number;
  /** Either side is labelled differently now; a relabel pass will re-derive it. */
  readonly stale: boolean;
}

export interface TxHop {
  /** This transaction is the withdrawal (`buy`) or the deposit (`sell`) of the hop. */
  readonly leg: 'buy' | 'sell';
  readonly address: string;
  readonly fromExchange: string;
  readonly toExchange: string;
  readonly withdrawn: number;
  readonly deposited: number;
  /** The transaction of the other leg. */
  readonly otherTxid: string;
  readonly blocksApart: number;
}

export interface TxDetail {
  readonly txid: string;
  readonly height: number;
  readonly time: number;
  readonly totalIn: number;
  readonly totalOut: number;
  /** Inputs minus outputs: the miner fee, as far as transparent addresses show it. */
  readonly fee: number;
  readonly parties: TxParty[];
  readonly flows: TxFlow[];
  readonly hops: TxHop[];
  /**
   * Why there are no flows, when there are none: a self-transfer, a move between Foundation
   * wallets (never a flow, #31), or a coinbase.
   */
  readonly note: string | null;
}

export function txDetail(
  db: Db,
  labels: LabelLookup,
  entities: EntityIndex,
  rawTxid: string
): TxDetail | null {
  const txid = rawTxid.toLowerCase();

  const deltas = db
    .prepare<
      [string],
      { address: string; height: number; time: number; satIn: number; satOut: number }
    >(
      `SELECT address, height, time, sat_in AS satIn, sat_out AS satOut
       FROM tx_deltas WHERE txid = ? ORDER BY address`
    )
    .all(txid);

  const flowRows = db
    .prepare<
      [string],
      {
        vout: number;
        height: number;
        time: number;
        fromAddress: string;
        fromKind: AddressKind;
        toAddress: string;
        toKind: AddressKind;
        exchange: string | null;
        flowType: TxFlow['flowType'];
        sat: number;
      }
    >(
      `SELECT vout, height, time, from_address AS fromAddress, from_kind AS fromKind,
              to_address AS toAddress, to_kind AS toKind, exchange, flow_type AS flowType, sat
       FROM flows WHERE txid = ? ORDER BY vout`
    )
    .all(txid);

  const first = deltas[0] ?? flowRows[0];
  if (!first) return null;
  const { height, time } = first;

  let satIn = 0;
  let satOut = 0;
  let funded = 0;
  for (const delta of deltas) {
    satIn += delta.satIn;
    satOut += delta.satOut;
    if (delta.satIn > delta.satOut) funded += delta.satIn - delta.satOut;
  }

  const received = new Map(
    deltas.map((delta) => [delta.address, Math.max(0, delta.satOut - delta.satIn)])
  );

  const parties: TxParty[] = deltas
    .map((delta) => {
      const net = delta.satOut - delta.satIn;
      const label = labels.labelOf(delta.address, time);
      const entity = entities.entityOf(delta.address);

      return {
        address: delta.address,
        kind: labels.kindOf(delta.address, time),
        name:
          labels.nameOf(delta.address, time) ?? (entity?.source === 'stored' ? entity.name : null),
        label: label
          ? {
              source: label.source,
              confidence: label.confidence,
              level: confidenceLevel(label.confidence),
              subLabel: label.subLabel
            }
          : null,
        entity: entity ? { id: entity.id, name: entity.name } : null,
        sent: delta.satIn / SATS_PER_FLUX,
        received: delta.satOut / SATS_PER_FLUX,
        net: net / SATS_PER_FLUX,
        role: (net < 0 ? 'funder' : net > 0 ? 'recipient' : 'change') as PartyRole,
        share: net < 0 && funded > 0 ? -net / funded : null
      };
    })
    // Funders first, largest first; then recipients, largest first.
    .sort(
      (a, b) =>
        roleOrder[a.role] - roleOrder[b.role] ||
        Math.abs(b.net) - Math.abs(a.net) ||
        (a.address < b.address ? -1 : 1)
    );

  const flows: TxFlow[] = flowRows.map((row) => {
    const total = received.get(row.toAddress) ?? 0;
    return {
      vout: row.vout,
      fromAddress: row.fromAddress,
      toAddress: row.toAddress,
      fromKind: row.fromKind,
      toKind: row.toKind,
      exchange: row.exchange,
      flowType: row.flowType,
      amount: row.sat / SATS_PER_FLUX,
      share: total > 0 ? row.sat / total : 1,
      stale:
        labels.kindOf(row.fromAddress, time) !== row.fromKind ||
        labels.kindOf(row.toAddress, time) !== row.toKind
    };
  });

  return {
    txid,
    height,
    time,
    totalIn: satIn / SATS_PER_FLUX,
    totalOut: satOut / SATS_PER_FLUX,
    fee: Math.max(0, satIn - satOut) / SATS_PER_FLUX,
    parties,
    flows,
    hops: txHops(db, txid),
    note: flows.length > 0 ? null : emptyReason(parties)
  };
}

const roleOrder: Record<PartyRole, number> = { funder: 0, recipient: 1, change: 2 };

function emptyReason(parties: readonly TxParty[]): string {
  if (parties.every((party) => party.sent === 0)) {
    return 'A coinbase: newly minted block and node rewards, not a transfer.';
  }
  if (parties.every((party) => party.role !== 'recipient')) {
    return 'Every address got back what it put in, less the fee: a self-transfer.';
  }
  const moving = parties.filter((party) => party.role !== 'change');
  if (moving.every((party) => party.kind === 'foundation')) {
    return 'Between Foundation wallets only, which FluxFlow never counts as a flow.';
  }
  return 'Nothing in it moved value between two different parties.';
}

/** Hops this transaction is a leg of, through the two `exchange_hops` keys. */
function txHops(db: Db, txid: string): TxHop[] {
  const rows = db
    .prepare<
      [string, string],
      {
        leg: 'buy' | 'sell';
        address: string;
        fromExchange: string;
        toExchange: string;
        buySat: number;
        sellSat: number;
        buyTxid: string;
        sellTxid: string;
        buyHeight: number;
        sellHeight: number;
      }
    >(
      `SELECT 'buy' AS leg, address, from_exchange AS fromExchange, to_exchange AS toExchange,
              buy_sat AS buySat, sell_sat AS sellSat, buy_txid AS buyTxid, sell_txid AS sellTxid,
              buy_height AS buyHeight, sell_height AS sellHeight
       FROM exchange_hops WHERE buy_txid = ?
       UNION ALL
       SELECT 'sell', address, from_exchange, to_exchange, buy_sat, sell_sat, buy_txid,
              sell_txid, buy_height, sell_height
       FROM exchange_hops INDEXED BY idx_hops_sell WHERE sell_txid = ?`
    )
    .all(txid, txid);

  return rows.map((row) => ({
    leg: row.leg,
    address: row.address,
    fromExchange: row.fromExchange,
    toExchange: row.toExchange,
    withdrawn: row.buySat / SATS_PER_FLUX,
    deposited: row.sellSat / SATS_PER_FLUX,
    otherTxid: row.leg === 'buy' ? row.sellTxid : row.buyTxid,
    blocksApart: row.sellHeight - row.buyHeight
  }));
}
