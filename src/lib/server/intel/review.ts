/**
 * Reviewing label candidates (#20): the evidence a person needs to accept or reject one, and
 * deciding many at once.
 *
 * A candidate's own evidence (the sweep it was seen in, the cluster it belongs to) says why it
 * was proposed. What decides it is what the address actually did: whether it forwards to the
 * exchange it is proposed for, how much, from how many senders. That comes from the stored
 * flows, through the address indexes, so a review of a few hundred candidates stays cheap.
 *
 * Methods are open-ended. Clustering proposes `sweep` and `common_input`; other passes add
 * their own (a deposit-address `forwarder`, for one). Nothing here depends on the method.
 */

import type { Db } from '../db/database.js';
import { SATS_PER_FLUX } from '../ingest/datasource/types.js';
import type { LabelLookup } from '../labels.js';
import {
  applyDecision,
  listCandidates,
  type CandidateKey,
  type StoredCandidate
} from './clusters.js';

export interface CandidateActivity {
  /** Transactions the address took part in: what accepting it re-derives. */
  readonly txs: number;
  readonly firstSeen: number | null;
  readonly lastSeen: number | null;
  readonly received: {
    readonly flux: number;
    readonly transfers: number;
    readonly senders: number;
    /** Transfers in from node-operator wallets: an operator selling through a deposit address. */
    readonly fromNodeOperators: number;
  };
  readonly sent: {
    readonly flux: number;
    readonly transfers: number;
    /** FLUX sent to the exchange the candidate is proposed for. */
    readonly toClaimed: number;
    /** `toClaimed / flux`, or null when the address has sent nothing yet. */
    readonly toClaimedShare: number | null;
    readonly exchanges: { readonly name: string; readonly flux: number }[];
  };
}

export interface ReviewCandidate extends StoredCandidate {
  readonly activity: CandidateActivity;
  /** The label the address carries now, if any: accepting may change what it is. */
  readonly currentLabel: { kind: string; name: string | null; source: string } | null;
  /** 0–1, for ordering; see {@link strengthOf}. */
  readonly strength: number;
}

/**
 * How strongly the evidence supports accepting, from 0 to 1.
 *
 * The method's own confidence, scaled by how much of what the address sent went to the
 * proposed exchange: a deposit address forwards everything to it, a personal wallet that
 * happened to share a transaction does not. An address that has sent nothing yet is neutral
 * (0.75 of its confidence). One already labelled as something else is halved: accepting would
 * overrule an existing label, which deserves a closer look.
 */
export function strengthOf(
  confidence: number,
  toClaimedShare: number | null,
  conflicting: boolean
): number {
  const agreement = toClaimedShare ?? 0.5;
  const strength = confidence * (0.5 + 0.5 * agreement) * (conflicting ? 0.5 : 1);
  return Math.round(strength * 1000) / 1000;
}

/** Candidates with their activity, strongest first. */
export function reviewCandidates(
  db: Db,
  labels: LabelLookup,
  options: { status?: string; limit?: number } = {}
): ReviewCandidate[] {
  const seen = db.prepare<[string], { txs: number; first: number | null; last: number | null }>(
    `SELECT COUNT(*) AS txs, MIN(time) AS first, MAX(time) AS last
     FROM tx_deltas WHERE address = ?`
  );
  const inbound = db.prepare<
    [string],
    { sat: number | null; transfers: number; senders: number; fromNodes: number | null }
  >(
    `SELECT SUM(sat) AS sat, COUNT(*) AS transfers, COUNT(DISTINCT from_address) AS senders,
            SUM(from_kind = 'node_operator') AS fromNodes
     FROM flows WHERE to_address = ?`
  );
  const outbound = db.prepare<
    [string],
    { exchange: string | null; sat: number; transfers: number }
  >(
    `SELECT CASE WHEN to_kind = 'exchange' THEN exchange END AS exchange,
            SUM(sat) AS sat, COUNT(*) AS transfers
     FROM flows WHERE from_address = ?
     GROUP BY 1`
  );

  const reviewed = listCandidates(db, options).map((candidate): ReviewCandidate => {
    const span = seen.get(candidate.address)!;
    const received = inbound.get(candidate.address)!;
    const sent = outbound.all(candidate.address);

    const sentSat = sent.reduce((sum, row) => sum + row.sat, 0);
    const toClaimedSat = sent
      .filter((row) => row.exchange !== null && row.exchange === candidate.name)
      .reduce((sum, row) => sum + row.sat, 0);
    const toClaimedShare = sentSat > 0 ? toClaimedSat / sentSat : null;

    const current = labels.labelOf(candidate.address);
    const currentLabel = current
      ? { kind: current.kind, name: current.name, source: current.source }
      : null;
    const conflicting =
      currentLabel !== null &&
      currentLabel.source !== 'accepted' &&
      (currentLabel.kind !== candidate.kind || (currentLabel.name ?? '') !== candidate.name);

    return {
      ...candidate,
      activity: {
        txs: span.txs,
        firstSeen: span.first,
        lastSeen: span.last,
        received: {
          flux: (received.sat ?? 0) / SATS_PER_FLUX,
          transfers: received.transfers,
          senders: received.senders,
          fromNodeOperators: received.fromNodes ?? 0
        },
        sent: {
          flux: sentSat / SATS_PER_FLUX,
          transfers: sent.reduce((sum, row) => sum + row.transfers, 0),
          toClaimed: toClaimedSat / SATS_PER_FLUX,
          toClaimedShare: toClaimedShare === null ? null : Math.round(toClaimedShare * 1000) / 1000,
          exchanges: sent
            .filter((row): row is typeof row & { exchange: string } => row.exchange !== null)
            .map((row) => ({ name: row.exchange, flux: row.sat / SATS_PER_FLUX }))
            .sort((a, b) => b.flux - a.flux)
        }
      },
      currentLabel,
      strength: strengthOf(candidate.confidence, toClaimedShare, conflicting)
    };
  });

  return reviewed.sort(
    (a, b) =>
      b.strength - a.strength ||
      b.activity.sent.flux - a.activity.sent.flux ||
      a.address.localeCompare(b.address)
  );
}

/** How many candidates are in each state, for the review's tabs. */
export function candidateCounts(db: Db): Record<'pending' | 'accepted' | 'rejected', number> {
  const counts = { pending: 0, accepted: 0, rejected: 0 };
  for (const row of db
    .prepare<[], { status: keyof typeof counts; n: number }>(
      `SELECT status, COUNT(*) AS n FROM label_candidates GROUP BY status`
    )
    .all()) {
    counts[row.status] = row.n;
  }
  return counts;
}

export interface BulkDecision {
  readonly decided: number;
  /** Keys with no such candidate. When any are missing, nothing was decided. */
  readonly missing: CandidateKey[];
  /** Addresses whose effective label changed, now queued for re-derivation. */
  readonly changedAddresses: number;
  /** Transactions those addresses took part in: the flows about to be re-derived. */
  readonly transactions: number;
}

/**
 * Accept or reject many candidates at once: all or nothing, one label refresh.
 *
 * Deciding one at a time refreshed the label book (a full re-read) per candidate; 25 sweep
 * addresses of one exchange are one decision. Idempotent: deciding a candidate the same way
 * again rewrites the same label and changes nothing.
 */
export function decideCandidates(
  db: Db,
  labels: LabelLookup,
  keys: readonly CandidateKey[],
  decision: 'accepted' | 'rejected'
): BulkDecision {
  const exists = db.prepare<[string, string, string], { n: number }>(
    `SELECT COUNT(*) AS n FROM label_candidates WHERE address = ? AND kind = ? AND name = ?`
  );

  const missing = db.transaction(() => {
    const absent = keys.filter((key) => exists.get(key.address, key.kind, key.name)!.n === 0);
    if (absent.length > 0) return absent;
    for (const key of keys) applyDecision(db, key, decision);
    return [];
  })();

  if (missing.length > 0) {
    return { decided: 0, missing, changedAddresses: 0, transactions: 0 };
  }

  const changed = labels.refresh(`${keys.length} candidates ${decision}`);
  return {
    decided: keys.length,
    missing: [],
    changedAddresses: changed.length,
    transactions: countTransactions(db, changed)
  };
}

function countTransactions(db: Db, addresses: readonly string[]): number {
  if (addresses.length === 0) return 0;

  return db.transaction(() => {
    db.prepare(`CREATE TEMP TABLE IF NOT EXISTS review_set (address TEXT PRIMARY KEY)`).run();
    db.prepare(`DELETE FROM review_set`).run();
    const insert = db.prepare(`INSERT OR IGNORE INTO review_set (address) VALUES (?)`);
    for (const address of addresses) insert.run(address);

    return db
      .prepare<[], { n: number }>(
        `SELECT COUNT(DISTINCT d.txid) AS n
         FROM tx_deltas d JOIN review_set r ON r.address = d.address`
      )
      .get()!.n;
  })();
}
