/**
 * Foundation intermediaries (#31): wallets the Foundation pays through, not people it pays.
 *
 * The live data has one: an unlabelled wallet that received 1.92M FLUX from the Foundation
 * in 20 payments and passed every coin on as exact 40,000 FLUX Stratus collateral to a node
 * address. Reported naively, that is the Foundation "sending 1.92M to an unknown wallet" —
 * 95% of its outflow for the week — when the money actually went to node collateral.
 *
 * An intermediary is labelled `foundation` (source `foundation_intermediary`), so the rest of
 * the system treats it as one of the Foundation's own wallets: derivation already drops
 * Foundation → Foundation transfers, the report nets them as internal, and the
 * intermediary's onward payments become the Foundation's real outflows, to their real
 * destinations.
 *
 * That label is strong — an intermediary's sales would count as Foundation selling — so the
 * applied (`likely`) rule is deliberately narrow:
 *
 *  - at least 95% of what it received came from Foundation wallets, in at least 2 payments;
 *  - it passed at least 90% of that on, and not much more (at most 110%): a wallet spending
 *    far more than the Foundation gave it is spending its own money, like a contributor
 *    paying from savings, and its payments are not the Foundation's;
 *  - at least 90% of what it passed on went to *confirmed* node operators (the node list or
 *    their own rewards), or as collateral that a live node uses (its transaction is a
 *    collateral outpoint on the node list). Inferred node labels (`forwarding`) do not
 *    count: they are themselves guesses about where money went, and stacking guesses
 *    turned two contributors' own spending into Foundation outflow;
 *  - at most 5% went to exchanges.
 *
 * A wallet that matches the first two but sends its money elsewhere — a contributor who
 * forwards wages to their own savings, say — is only `possible`: shown with its evidence,
 * never applied. Its destinations are still traced (`destinations.ts`).
 *
 * Read from `tx_deltas`, not `flows`: once the label applies, Foundation → intermediary
 * flows stop existing, and evidence read from flows would remove the label again on the
 * next pass. The deltas do not depend on labels, so the result is stable.
 */

import type { Db } from '../db/database.js';
import { SATS_PER_FLUX } from '../ingest/datasource/types.js';
import { APPLY_MIN_CONFIDENCE, CONFIDENCE, type LabelInput, type LabelLookup } from '../labels.js';

export const INTERMEDIARY_SOURCE = 'foundation_intermediary';

/** Node collateral by tier, in satoshis: CUMULUS, NIMBUS, STRATUS. */
export const COLLATERAL_SAT: ReadonlySet<number> = new Set(
  [1_000, 12_500, 40_000].map((flux) => flux * SATS_PER_FLUX)
);

export const INTERMEDIARY = {
  minShareFromFoundation: 0.95,
  minPayments: 2,
  minPassedOn: 0.9,
  /** Sending more than this multiple of the Foundation's money is spending one's own. */
  maxPassThrough: 1.1,
  minToNodes: 0.9,
  maxToExchanges: 0.05
} as const;

export const INTERMEDIARY_SUB_LABEL = 'Pays node collateral (detected)';

/**
 * Inferred sources an intermediary may override. They describe where a wallet's money goes
 * (to node operators, to an exchange), which an intermediary also does; anything else — a
 * hand label, the config, an accepted candidate, the node list or the wallet's own rewards —
 * is more authoritative and keeps the address out of detection.
 */
/** Node-operator evidence an intermediary's payments must reach: observed, not inferred. */
const CONFIRMED_NODE_SOURCES: ReadonlySet<string> = new Set(['node_list', 'node_rewards']);

const OVERRIDABLE_SOURCES: ReadonlySet<string> = new Set([
  INTERMEDIARY_SOURCE,
  'forwarding',
  'forwarder'
]);

function blocked(labels: LabelLookup, address: string): boolean {
  return labels
    .allLabels(address)
    .some((row) => row.confidence >= APPLY_MIN_CONFIDENCE && !OVERRIDABLE_SOURCES.has(row.source));
}

interface Delta {
  txid: string;
  address: string;
  height: number;
  time: number;
  net: number;
}

/**
 * The addresses that define "the Foundation" for detection: every Foundation label except
 * the ones this module wrote. Keeps detection from feeding on its own output.
 */
export function baseFoundation(labels: LabelLookup): Set<string> {
  return new Set(
    labels
      .addressesOf('foundation')
      .filter((address) => labels.labelOf(address)?.source !== INTERMEDIARY_SOURCE)
  );
}

export function detectIntermediaries(
  db: Db,
  labels: LabelLookup,
  collateralTxids: ReadonlySet<string> = new Set()
): LabelInput[] {
  const base = baseFoundation(labels);
  if (base.size === 0) return [];

  const byTx = db.prepare<[string], Delta>(
    `SELECT txid, address, height, time, sat_out - sat_in AS net FROM tx_deltas WHERE txid = ?`
  );
  const ofAddress = db.prepare<[string], Delta>(
    `SELECT txid, address, height, time, sat_out - sat_in AS net
     FROM tx_deltas WHERE address = ? ORDER BY height`
  );
  const txCache = new Map<string, Delta[]>();
  const tx = (txid: string) => {
    let rows = txCache.get(txid);
    if (!rows) {
      rows = byTx.all(txid);
      txCache.set(txid, rows);
    }
    return rows;
  };

  // Candidates: anyone a Foundation wallet paid, unless an authoritative label says otherwise.
  const candidates = new Set<string>();
  for (const address of base) {
    for (const own of ofAddress.all(address)) {
      if (own.net >= 0) continue;
      for (const row of tx(own.txid)) {
        if (row.net <= 0 || base.has(row.address) || blocked(labels, row.address)) continue;
        candidates.add(row.address);
      }
    }
  }

  const result: LabelInput[] = [];

  for (const address of candidates) {
    let inbound = 0;
    let fromFoundation = 0;
    let payments = 0;
    let outbound = 0;
    let toNodes = 0;
    let toExchanges = 0;
    let collateralPayments = 0;
    let collateralSized = 0;
    const name = new Set<string>();

    for (const own of ofAddress.all(address)) {
      const rows = tx(own.txid);
      const funded = rows.reduce((sum, row) => sum + Math.max(0, -row.net), 0);
      if (funded <= 0) continue;

      if (own.net > 0) {
        const foundationFunded = rows
          .filter((row) => row.net < 0 && base.has(row.address))
          .reduce((sum, row) => sum - row.net, 0);
        inbound += own.net;
        fromFoundation += own.net * Math.min(1, foundationFunded / funded);
        if (foundationFunded > 0) {
          payments++;
          for (const row of rows) {
            if (row.net < 0 && base.has(row.address)) {
              const funderName = labels.nameOf(row.address);
              if (funderName) name.add(funderName);
            }
          }
        }
        continue;
      }

      if (own.net < 0) {
        const share = -own.net / funded;
        outbound -= own.net;
        for (const row of rows) {
          if (row.net <= 0 || row.address === address) continue;
          const portion = row.net * share;
          const label = labels.labelOf(row.address, row.time);
          const confirmedNode =
            label?.kind === 'node_operator' && CONFIRMED_NODE_SOURCES.has(label.source);
          const sized = COLLATERAL_SAT.has(row.net);
          const collateral = sized && collateralTxids.has(row.txid);
          if (label?.kind === 'exchange') toExchanges += portion;
          else if (confirmedNode || collateral) toNodes += portion;
          if (collateral) collateralPayments++;
          if (sized) collateralSized++;
        }
      }
    }

    if (inbound <= 0 || outbound <= 0) continue;
    const shareFromFoundation = fromFoundation / inbound;
    const passedOn = Math.min(outbound, fromFoundation) / fromFoundation;
    if (
      shareFromFoundation < INTERMEDIARY.minShareFromFoundation ||
      payments < INTERMEDIARY.minPayments ||
      passedOn < INTERMEDIARY.minPassedOn ||
      outbound > fromFoundation * INTERMEDIARY.maxPassThrough
    ) {
      continue;
    }

    const toNodeShare = toNodes / outbound;
    const toExchangeShare = toExchanges / outbound;
    const likely =
      toNodeShare >= INTERMEDIARY.minToNodes && toExchangeShare <= INTERMEDIARY.maxToExchanges;

    result.push({
      address,
      kind: 'foundation',
      name: [...name][0] ?? 'Flux Foundation',
      subLabel: likely ? INTERMEDIARY_SUB_LABEL : 'Paid on by the Foundation (possible)',
      confidence: likely ? CONFIDENCE.likely : CONFIDENCE.possible,
      evidence: {
        method: INTERMEDIARY_SOURCE,
        shareFromFoundation: round(shareFromFoundation),
        paymentsFromFoundation: payments,
        fluxFromFoundation: round(fromFoundation / SATS_PER_FLUX),
        passedOn: round(passedOn),
        toNodeShare: round(toNodeShare),
        toExchangeShare: round(toExchangeShare),
        collateralPayments,
        collateralSized
      }
    });
  }

  return result.sort((a, b) => (a.address < b.address ? -1 : 1));
}

const round = (value: number) => Number(value.toFixed(3));
