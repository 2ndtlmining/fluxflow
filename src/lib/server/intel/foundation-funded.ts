/**
 * Foundation-funded wallets (#62): wallets that may be the Foundation's own, proposed for
 * review.
 *
 * The live data has a cluster of them: an unlabelled t3 treasury that gets most of its money
 * from three Foundation wallets (and Flux app hosting fees), and t1 wallets it and the
 * Foundation fund, which pay thousands of app fees. Unlabelled, Foundation → treasury moves
 * read as Foundation outflow, and the Foundation paying for its own apps reads as demand.
 *
 * Nobody outside the Foundation can confirm who controls a wallet, so these are only
 * *candidates* (`label_candidates`, method `foundation_funded`): shown on the review page with
 * their evidence, applied only when the owner accepts them. The rule:
 *
 *  - at least 60% of what it received came from Foundation wallets, or from wallets already
 *    proposed by this rule, in at least 2 payments and at least 10,000 FLUX;
 *  - at most 10% of what it sent went to exchanges: a contributor paid by the Foundation
 *    sells, a Foundation wallet does not;
 *  - it has no label yet, and the owner has not rejected it.
 *
 * "Already proposed" makes it transitive: a wallet funded only by the treasury is found on the
 * second pass, one funded only by that one on the third. Passes stop at
 * {@link FOUNDATION_FUNDED.maxHops}, and a wallet that only qualifies through other proposals
 * gets a lower confidence than one the Foundation funded directly. A rejected wallet is never
 * built on, so rejecting one prunes everything only reachable through it.
 *
 * Read from `tx_deltas`, not `flows`, like `intermediaries.ts`: the evidence does not move
 * when labels change, and a funder's share of a transaction is its share of the inputs.
 */

import type { Db } from '../db/database.js';
import { SATS_PER_FLUX } from '../ingest/datasource/types.js';
import type { LabelLookup } from '../labels.js';
import type { Candidate } from './clusters.js';

export const FOUNDATION_FUNDED = {
  method: 'foundation_funded',
  minShareFromFoundation: 0.6,
  minPayments: 2,
  minFlux: 10_000,
  maxToExchanges: 0.1,
  maxHops: 3,
  confidence: {
    /** The Foundation's own payments alone meet the share. */
    direct: 0.6,
    /** Only with money from other proposed wallets. */
    indirect: 0.5
  },
  /** Funders listed in the evidence. */
  funders: 5
} as const;

interface Delta {
  txid: string;
  address: string;
  net: number;
}

interface Funding {
  inbound: number;
  fromFoundation: number;
  direct: number;
  payments: number;
  outbound: number;
  toExchanges: number;
  toApps: number;
  funders: Map<string, number>;
}

export function detectFoundationFunded(db: Db, labels: LabelLookup): Candidate[] {
  const base = new Set(labels.addressesOf('foundation'));
  if (base.size === 0) return [];

  const rejected = new Set(
    db
      .prepare<[string], { address: string }>(
        `SELECT address FROM label_candidates
         WHERE kind = 'foundation' AND method = ? AND status = 'rejected'`
      )
      .all(FOUNDATION_FUNDED.method)
      .map((row) => row.address)
  );

  const byTx = db.prepare<[string], Delta>(
    `SELECT txid, address, sat_out - sat_in AS net FROM tx_deltas WHERE txid = ?`
  );
  const ofAddress = db.prepare<[string], Delta>(
    `SELECT txid, address, sat_out - sat_in AS net FROM tx_deltas WHERE address = ? ORDER BY height`
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

  const eligible = (address: string) =>
    !base.has(address) && !rejected.has(address) && labels.labelOf(address) === null;

  /** Who `funders` paid, that could be proposed. */
  const recipientsOf = (funders: Iterable<string>) => {
    const found = new Set<string>();
    for (const address of funders) {
      for (const own of ofAddress.all(address)) {
        if (own.net >= 0) continue;
        for (const row of tx(own.txid)) {
          if (row.net > 0 && eligible(row.address)) found.add(row.address);
        }
      }
    }
    return found;
  };

  const fundingOf = (address: string, foundation: ReadonlySet<string>): Funding => {
    const funding: Funding = {
      inbound: 0,
      fromFoundation: 0,
      direct: 0,
      payments: 0,
      outbound: 0,
      toExchanges: 0,
      toApps: 0,
      funders: new Map()
    };

    for (const own of ofAddress.all(address)) {
      const rows = tx(own.txid);
      const funded = rows.reduce((sum, row) => sum + Math.max(0, -row.net), 0);
      if (funded <= 0) continue;

      if (own.net > 0) {
        funding.inbound += own.net;
        let paid = false;
        for (const row of rows) {
          if (row.net >= 0 || !foundation.has(row.address)) continue;
          const portion = (own.net * -row.net) / funded;
          funding.fromFoundation += portion;
          if (base.has(row.address)) funding.direct += portion;
          funding.funders.set(row.address, (funding.funders.get(row.address) ?? 0) + portion);
          paid = true;
        }
        if (paid) funding.payments++;
        continue;
      }

      if (own.net < 0) {
        const share = -own.net / funded;
        funding.outbound -= own.net;
        for (const row of rows) {
          if (row.net <= 0 || row.address === address) continue;
          const kind = labels.kindOf(row.address);
          if (kind === 'exchange') funding.toExchanges += row.net * share;
          else if (kind === 'app_hosting') funding.toApps += row.net * share;
        }
      }
    }

    return funding;
  };

  const qualifies = (funding: Funding) =>
    funding.inbound > 0 &&
    funding.fromFoundation / funding.inbound >= FOUNDATION_FUNDED.minShareFromFoundation &&
    funding.payments >= FOUNDATION_FUNDED.minPayments &&
    funding.fromFoundation >= FOUNDATION_FUNDED.minFlux * SATS_PER_FLUX &&
    (funding.outbound === 0 ||
      funding.toExchanges / funding.outbound <= FOUNDATION_FUNDED.maxToExchanges);

  const found = new Map<string, { hops: number; funding: Funding }>();
  // Everyone the Foundation or a proposal paid. A wallet passed over on one pass is looked at
  // again on the next, when more of its funders may count.
  const pool = recipientsOf(base);

  for (let hops = 1; hops <= FOUNDATION_FUNDED.maxHops; hops++) {
    const foundation = new Set([...base, ...found.keys()]);
    const added: string[] = [];
    for (const address of pool) {
      if (found.has(address)) continue;
      const funding = fundingOf(address, foundation);
      if (!qualifies(funding)) continue;
      found.set(address, { hops, funding });
      added.push(address);
    }
    if (added.length === 0) break;
    for (const address of recipientsOf(added)) pool.add(address);
  }

  return [...found]
    .map(([address, { hops, funding }]): Candidate => {
      const direct = funding.direct / funding.inbound;
      return {
        address,
        kind: 'foundation',
        name: labels.nameOf([...base][0]!) ?? 'Flux Foundation',
        method: FOUNDATION_FUNDED.method,
        confidence:
          direct >= FOUNDATION_FUNDED.minShareFromFoundation
            ? FOUNDATION_FUNDED.confidence.direct
            : FOUNDATION_FUNDED.confidence.indirect,
        evidence: {
          shareFromFoundation: round(funding.fromFoundation / funding.inbound),
          directShare: round(direct),
          fluxFromFoundation: round(funding.fromFoundation / SATS_PER_FLUX),
          paymentsFromFoundation: funding.payments,
          hops,
          toExchangeShare: funding.outbound > 0 ? round(funding.toExchanges / funding.outbound) : 0,
          toAppsShare: funding.outbound > 0 ? round(funding.toApps / funding.outbound) : 0,
          funders: [...funding.funders]
            .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
            .slice(0, FOUNDATION_FUNDED.funders)
            .map(([funder]) => funder)
        }
      };
    })
    .sort((a, b) => (a.address < b.address ? -1 : 1));
}

const round = (value: number) => Number(value.toFixed(3));
