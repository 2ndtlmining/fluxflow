/**
 * Foundation-funded wallets (#62): wallets that may be the Foundation's own, proposed for
 * review.
 *
 * The live data has a cluster of them: an unlabelled t3 treasury that gets most of its money
 * from three Foundation wallets (and Flux app hosting fees), and t1 wallets it and the
 * Foundation fund, which pay thousands of app fees. Unlabelled, Foundation â†’ treasury moves
 * read as Foundation outflow, and the Foundation paying for its own apps reads as demand.
 *
 * Nobody outside the Foundation can confirm who controls a wallet, so these are only
 * *candidates* (`label_candidates`, method `foundation_funded`): shown on the review page with
 * their evidence, applied only when the owner accepts them. A wallet is proposed when:
 *
 *  - **funding**: at least 60% of what it received came from Foundation wallets, or from other
 *    proposed wallets, in at least 2 payments and at least 10,000 FLUX;
 *  - **behaviour**: it acts like the Foundation, not like someone the Foundation pays. Either
 *    at least 25% of what it sent went to app hosting, the Foundation or other proposed
 *    wallets, or it holds Foundation-scale money (250,000 FLUX or more from the Foundation).
 *    On the live data this is what separates the treasury and app-payer cluster from ~25
 *    contributor wallets paid a few tens of thousands each, which only hold;
 *  - at most 10% of what it sent went to exchanges, and it sent at most 1.1× what it
 *    received: a wallet spending far more is spending its own (mined, say) money, and what it
 *    funds is not the Foundation's;
 *  - it has no label yet, and the owner has not rejected it.
 *
 * "Other proposed wallets" makes it transitive, in two phases. Expansion finds everything the
 * funding rule reaches, pass by pass (a wallet funded only by the treasury on the second pass,
 * one funded only by that one on the third, up to {@link FOUNDATION_FUNDED.maxHops}). Pruning
 * then drops wallets that fail either rule *with only the survivors counted*, until nothing
 * changes: a contributor forwarding wages to their own savings wallet does not qualify through
 * that savings wallet, because the savings wallet only holds and is pruned first.
 *
 * A wallet the Foundation funded directly gets a higher confidence than one that qualifies
 * only through other proposals. A rejected wallet is never built on, so rejecting one prunes
 * everything only reachable through it.
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
  /** Share of outflow to app hosting, the Foundation or other proposals. */
  minOperations: 0.25,
  /** Received from the Foundation: enough to qualify without spending like it. */
  treasuryFlux: 250_000,
  maxToExchanges: 0.1,
  /** Sending more than this multiple of what it received is spending one's own. */
  maxPassThrough: 1.1,
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
  toFoundation: number;
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
  // Pruning reads the same wallets several times.
  const historyCache = new Map<string, Delta[]>();
  const history = (address: string) => {
    let rows = historyCache.get(address);
    if (!rows) {
      rows = ofAddress.all(address);
      historyCache.set(address, rows);
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

  /** `address`'s money in and out, counting `foundation` as the Foundation. */
  const fundingOf = (address: string, foundation: ReadonlySet<string>): Funding => {
    const funding: Funding = {
      inbound: 0,
      fromFoundation: 0,
      direct: 0,
      payments: 0,
      outbound: 0,
      toExchanges: 0,
      toApps: 0,
      toFoundation: 0,
      funders: new Map()
    };

    for (const own of history(address)) {
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
          const portion = row.net * share;
          const kind = labels.kindOf(row.address);
          if (kind === 'exchange') funding.toExchanges += portion;
          else if (kind === 'app_hosting') funding.toApps += portion;
          else if (foundation.has(row.address)) funding.toFoundation += portion;
        }
      }
    }

    return funding;
  };

  const funded = (funding: Funding) =>
    funding.inbound > 0 &&
    funding.fromFoundation / funding.inbound >= FOUNDATION_FUNDED.minShareFromFoundation &&
    funding.payments >= FOUNDATION_FUNDED.minPayments &&
    funding.fromFoundation >= FOUNDATION_FUNDED.minFlux * SATS_PER_FLUX &&
    funding.outbound <= funding.inbound * FOUNDATION_FUNDED.maxPassThrough &&
    (funding.outbound === 0 ||
      funding.toExchanges / funding.outbound <= FOUNDATION_FUNDED.maxToExchanges);

  const behaves = (funding: Funding) =>
    funding.fromFoundation >= FOUNDATION_FUNDED.treasuryFlux * SATS_PER_FLUX ||
    (funding.outbound > 0 &&
      (funding.toApps + funding.toFoundation) / funding.outbound >=
        FOUNDATION_FUNDED.minOperations);

  // Expansion: everything the funding rule reaches, and on which pass.
  const hopsOf = new Map<string, number>();
  // Everyone the Foundation or a proposal paid. A wallet passed over on one pass is looked at
  // again on the next, when more of its funders may count.
  const pool = recipientsOf(base);

  for (let hops = 1; hops <= FOUNDATION_FUNDED.maxHops; hops++) {
    const foundation = new Set([...base, ...hopsOf.keys()]);
    const added: string[] = [];
    for (const address of pool) {
      if (hopsOf.has(address) || !funded(fundingOf(address, foundation))) continue;
      hopsOf.set(address, hops);
      added.push(address);
    }
    if (added.length === 0) break;
    for (const address of recipientsOf(added)) pool.add(address);
  }

  // Pruning: both rules, with only the survivors counted, until nothing changes.
  const kept = new Map<string, Funding>();
  let survivors = new Set(hopsOf.keys());
  for (;;) {
    const foundation = new Set([...base, ...survivors]);
    kept.clear();
    for (const address of survivors) {
      const funding = fundingOf(address, foundation);
      if (funded(funding) && behaves(funding)) kept.set(address, funding);
    }
    if (kept.size === survivors.size) break;
    survivors = new Set(kept.keys());
  }

  return [...kept]
    .map(([address, funding]): Candidate => {
      const direct = funding.direct / funding.inbound;
      const share = (amount: number) =>
        funding.outbound > 0 ? round(amount / funding.outbound) : 0;
      return {
        address,
        kind: 'foundation',
        name: 'Flux Foundation',
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
          hops: hopsOf.get(address)!,
          toAppsShare: share(funding.toApps),
          toFoundationShare: share(funding.toFoundation),
          toExchangeShare: share(funding.toExchanges),
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

/**
 * Remove pending proposals of this method that the latest pass no longer makes. The rule
 * reads behaviour, which changes; a decided proposal keeps its decision.
 * @returns how many were removed.
 */
export function dropStaleFoundationFunded(db: Db, current: readonly Candidate[]): number {
  const keep = new Set(current.map((candidate) => candidate.address));
  const pending = db
    .prepare<[string], { address: string }>(
      `SELECT address FROM label_candidates WHERE method = ? AND status = 'pending'`
    )
    .all(FOUNDATION_FUNDED.method)
    .filter((row) => !keep.has(row.address));
  const remove = db.prepare(
    `DELETE FROM label_candidates WHERE address = ? AND method = ? AND status = 'pending'`
  );
  db.transaction(() => {
    for (const row of pending) remove.run(row.address, FOUNDATION_FUNDED.method);
  })();
  return pending.length;
}
