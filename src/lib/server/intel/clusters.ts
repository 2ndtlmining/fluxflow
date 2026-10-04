/**
 * Exchange coverage: clustering and candidate labels (#20).
 *
 * Only a handful of exchange addresses are known, so most exchange activity is invisible:
 * a deposit into a per-user deposit address looks like a transfer between strangers, and
 * only the later sweep into a known hot wallet registers — as a "sale" by the deposit
 * address. Two local heuristics find more:
 *
 *  - **Common-input ownership.** Addresses spent together as inputs of one transaction are
 *    controlled by one owner (they had to sign together). Union-find over `tx_deltas`.
 *    CoinJoin-shaped transactions — many inputs and several identical outputs — break the
 *    assumption and are skipped.
 *  - **Sweeps.** A transaction whose inputs are several unlabelled addresses and whose value
 *    goes (almost) entirely to one known exchange address is that exchange consolidating its
 *    deposit addresses.
 *
 * Both produce **candidates**, never labels. A candidate changes no total until someone
 * accepts it (`POST /api/admin/labels/candidates/accept`), which turns it into an
 * `address_labels` row with `source = 'accepted'` and re-derives the affected flows.
 */

import type { Db } from '../db/database.js';
import type { LabelLookup } from '../labels.js';

/** Skip a transaction as CoinJoin-like with at least this many inputs… */
const COINJOIN_MIN_INPUTS = 5;
/** …and at least this many outputs of exactly the same value. */
const COINJOIN_MIN_EQUAL_OUTPUTS = 3;
/** A sweep sends at least this share of its value to one exchange address. */
const SWEEP_MIN_SHARE = 0.95;
/** A sweep consolidates at least this many inputs. */
const SWEEP_MIN_INPUTS = 2;

export const CANDIDATE_CONFIDENCE = {
  commonInput: 0.6,
  sweep: 0.5
} as const;

export interface Candidate {
  readonly address: string;
  readonly kind: 'exchange';
  readonly name: string;
  readonly method: 'common_input' | 'sweep' | 'forwarder';
  readonly confidence: number;
  readonly evidence: Record<string, unknown>;
}

export interface ClusterResult {
  readonly clusters: number;
  readonly clusteredAddresses: number;
  readonly largest: number;
  readonly skippedCoinjoins: number;
  readonly conflicts: { clusterId: string; exchanges: string[] }[];
  readonly candidates: Candidate[];
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  find(address: string): string {
    if (!this.parent.has(address)) {
      this.parent.set(address, address);
      return address;
    }

    let root = address;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;

    // Path compression.
    let node = address;
    while (node !== root) {
      const next = this.parent.get(node)!;
      this.parent.set(node, root);
      node = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    // Deterministic: the lexically smaller root wins, so cluster ids are stable.
    if (rootA < rootB) this.parent.set(rootB, rootA);
    else this.parent.set(rootA, rootB);
  }

  addresses(): string[] {
    return [...this.parent.keys()];
  }
}

/**
 * Rebuild `address_clusters` and propose exchange candidates.
 *
 * Bounded by the multi-input transactions in the raw window — a few per thousand blocks on
 * FLUX — so it runs in memory in one pass.
 */
export function clusterAddresses(db: Db, labels: LabelLookup): ClusterResult {
  const inputs = db
    .prepare<[], { txid: string; address: string; satIn: number; satOut: number }>(
      `SELECT d.txid, d.address, d.sat_in AS satIn, d.sat_out AS satOut
       FROM tx_deltas d
       WHERE d.txid IN (
         SELECT txid FROM tx_deltas WHERE sat_in > 0 GROUP BY txid HAVING COUNT(*) >= 2
       )
       ORDER BY d.txid`
    )
    .all();

  const byTx = new Map<string, { address: string; satIn: number; satOut: number }[]>();
  for (const row of inputs) {
    const list = byTx.get(row.txid);
    if (list) list.push(row);
    else byTx.set(row.txid, [row]);
  }

  const union = new UnionFind();
  const evidenceTxs = new Map<string, string[]>();
  const candidates = new Map<string, Candidate>();
  let skippedCoinjoins = 0;

  for (const [txid, deltas] of byTx) {
    const funders = deltas.filter((delta) => delta.satIn > 0);
    const received = deltas.filter((delta) => delta.satOut - delta.satIn > 0);

    if (isCoinjoinLike(funders.length, received)) {
      skippedCoinjoins++;
      continue;
    }

    for (const funder of funders.slice(1)) union.union(funders[0]!.address, funder.address);
    const root = union.find(funders[0]!.address);
    const sample = evidenceTxs.get(root) ?? [];
    if (sample.length < 5) sample.push(txid);
    evidenceTxs.set(root, sample);

    proposeSweep(txid, funders, received, labels, candidates);
  }

  // Group into clusters.
  const members = new Map<string, string[]>();
  for (const address of union.addresses()) {
    const root = union.find(address);
    const list = members.get(root);
    if (list) list.push(address);
    else members.set(root, [address]);
  }

  const conflicts: ClusterResult['conflicts'] = [];
  let largest = 0;
  let clusteredAddresses = 0;

  for (const [root, addresses] of members) {
    if (addresses.length < 2) continue;
    largest = Math.max(largest, addresses.length);
    clusteredAddresses += addresses.length;

    const exchanges = new Set<string>();
    const anchors: string[] = [];
    for (const address of addresses) {
      const label = labels.labelOf(address);
      if (label?.kind === 'exchange' && label.name) {
        exchanges.add(label.name);
        anchors.push(address);
      }
    }

    // Two exchanges in one cluster means the heuristic broke (or a mislabel): propose nothing.
    if (exchanges.size > 1) {
      conflicts.push({ clusterId: root, exchanges: [...exchanges].sort() });
      continue;
    }
    if (exchanges.size === 0) continue;

    const name = [...exchanges][0]!;
    for (const address of addresses) {
      if (labels.labelOf(address)) continue;
      candidates.set(`${address}|${name}`, {
        address,
        kind: 'exchange',
        name,
        method: 'common_input',
        confidence: CANDIDATE_CONFIDENCE.commonInput,
        evidence: {
          clusterId: root,
          clusterSize: addresses.length,
          anchors: anchors.slice(0, 5),
          sharedTxs: evidenceTxs.get(root) ?? []
        }
      });
    }
  }

  db.transaction(() => {
    db.prepare(`DELETE FROM address_clusters`).run();
    const insert = db.prepare(
      `INSERT INTO address_clusters (address, cluster_id, size) VALUES (?, ?, ?)`
    );
    for (const [root, addresses] of members) {
      if (addresses.length < 2) continue;
      for (const address of addresses) insert.run(address, root, addresses.length);
    }
  })();

  return {
    clusters: [...members.values()].filter((list) => list.length >= 2).length,
    clusteredAddresses,
    largest,
    skippedCoinjoins,
    conflicts,
    candidates: [...candidates.values()]
  };
}

function isCoinjoinLike(
  inputs: number,
  received: readonly { satIn: number; satOut: number }[]
): boolean {
  if (inputs < COINJOIN_MIN_INPUTS) return false;

  const counts = new Map<number, number>();
  for (const output of received) {
    const value = output.satOut - output.satIn;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values()) >= COINJOIN_MIN_EQUAL_OUTPUTS;
}

/** Unlabelled inputs consolidated into one known exchange address are its deposit addresses. */
function proposeSweep(
  txid: string,
  funders: readonly { address: string; satIn: number; satOut: number }[],
  received: readonly { address: string; satIn: number; satOut: number }[],
  labels: LabelLookup,
  candidates: Map<string, Candidate>
): void {
  if (funders.length < SWEEP_MIN_INPUTS) return;

  const total = received.reduce((sum, output) => sum + output.satOut - output.satIn, 0);
  if (total <= 0) return;

  const target = [...received].sort((a, b) => b.satOut - b.satIn - (a.satOut - a.satIn))[0]!;
  const label = labels.labelOf(target.address);
  if (label?.kind !== 'exchange' || !label.name) return;
  if ((target.satOut - target.satIn) / total < SWEEP_MIN_SHARE) return;

  // Mixed with the exchange's own known inputs is fine; mixed with any other label is not.
  const unlabelled = funders.filter((funder) => !labels.labelOf(funder.address));
  const own = funders.filter((funder) => labels.labelOf(funder.address)?.name === label.name);
  if (unlabelled.length === 0 || unlabelled.length + own.length !== funders.length) return;

  for (const funder of unlabelled) {
    const key = `${funder.address}|${label.name}`;
    if (candidates.has(key)) continue;
    candidates.set(key, {
      address: funder.address,
      kind: 'exchange',
      name: label.name,
      method: 'sweep',
      confidence: CANDIDATE_CONFIDENCE.sweep,
      evidence: { sweepTx: txid, into: target.address, inputs: funders.length }
    });
  }
}

/**
 * Store candidates. A decided candidate (accepted or rejected) keeps its decision; a pending
 * one gets fresh evidence.
 */
export function storeCandidates(db: Db, candidates: readonly Candidate[]): number {
  const upsert = db.prepare(
    `INSERT INTO label_candidates (address, kind, name, method, confidence, evidence)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (address, kind, name) DO UPDATE SET
       method = excluded.method,
       confidence = MAX(confidence, excluded.confidence),
       evidence = excluded.evidence
     WHERE status = 'pending'`
  );

  let written = 0;
  db.transaction(() => {
    for (const candidate of candidates) {
      written += upsert.run(
        candidate.address,
        candidate.kind,
        candidate.name,
        candidate.method,
        candidate.confidence,
        JSON.stringify(candidate.evidence)
      ).changes;
    }
  })();

  return written;
}

export interface StoredCandidate {
  readonly address: string;
  readonly kind: string;
  readonly name: string;
  readonly method: string;
  readonly confidence: number;
  readonly evidence: unknown;
  readonly status: string;
  readonly createdAt: number;
  readonly decidedAt: number | null;
}

export function listCandidates(
  db: Db,
  options: { status?: string; address?: string; limit?: number } = {}
): StoredCandidate[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  if (options.address) {
    where.push('address = ?');
    params.push(options.address);
  }
  params.push(Math.min(Math.max(1, options.limit ?? 100), 500));

  return db
    .prepare<
      (string | number)[],
      {
        address: string;
        kind: string;
        name: string;
        method: string;
        confidence: number;
        evidence: string | null;
        status: string;
        created_at: number;
        decided_at: number | null;
      }
    >(
      `SELECT * FROM label_candidates
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY confidence DESC, name, address
       LIMIT ?`
    )
    .all(...params)
    .map((row) => ({
      address: row.address,
      kind: row.kind,
      name: row.name,
      method: row.method,
      confidence: row.confidence,
      evidence: row.evidence ? (JSON.parse(row.evidence) as unknown) : null,
      status: row.status,
      createdAt: row.created_at,
      decidedAt: row.decided_at
    }));
}

export interface CandidateKey {
  readonly address: string;
  readonly kind: string;
  readonly name: string;
}

/**
 * Record one decision and its label, without refreshing the label book. Callers run it
 * inside a transaction and refresh once afterwards: {@link decideCandidate} for one, the
 * review's bulk decide (`review.ts`) for any number.
 *
 * @returns false when there is no such candidate.
 */
export function applyDecision(
  db: Db,
  key: CandidateKey,
  decision: 'accepted' | 'rejected'
): boolean {
  const updated = db
    .prepare(
      `UPDATE label_candidates
       SET status = ?, decided_at = CAST(strftime('%s','now') AS INTEGER)
       WHERE address = ? AND kind = ? AND name = ?`
    )
    .run(decision, key.address, key.kind, key.name).changes;
  if (updated === 0) return false;

  if (decision === 'accepted') {
    db.prepare(
      `INSERT INTO address_labels (address, kind, name, source, confidence, evidence, updated_at)
       SELECT address, kind, name, 'accepted', 0.9,
              json_object('method', method, 'evidence', json(evidence)),
              CAST(strftime('%s','now') AS INTEGER)
       FROM label_candidates WHERE address = ? AND kind = ? AND name = ?
       ON CONFLICT (address, kind, source) DO UPDATE SET
         name = excluded.name, confidence = excluded.confidence,
         evidence = excluded.evidence, updated_at = excluded.updated_at`
    ).run(key.address, key.kind, key.name);
  } else {
    db.prepare(
      `DELETE FROM address_labels
       WHERE address = ? AND kind = ? AND source = 'accepted' AND name = ?`
    ).run(key.address, key.kind, key.name);
  }

  return true;
}

/**
 * Accept or reject a candidate. Accepting writes an `accepted` label (confidence 0.9) and
 * refreshes the label book, which queues the address for re-derivation; rejecting removes any
 * label an earlier acceptance created.
 *
 * @returns false when there is no such candidate.
 */
export function decideCandidate(
  db: Db,
  labels: LabelLookup,
  key: CandidateKey,
  decision: 'accepted' | 'rejected'
): boolean {
  const changed = db.transaction(() => applyDecision(db, key, decision))();
  if (changed) labels.refresh(`candidate ${decision}`);
  return changed;
}
