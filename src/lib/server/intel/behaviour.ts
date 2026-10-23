/**
 * Behaviour tags (#68): how a wallet acts, not who it is.
 *
 * Labels answer "whose wallet is this?"; these answer "what does it do?". Patterns like
 * `t1Mzja…`'s ~10,000 near-identical app payments were only visible to someone who opened
 * that wallet. Tags are informational: they live in their own table and never change a
 * label, a kind or a flow.
 *
 * Every detector reads local data only and keeps its evidence. The thresholds were set
 * against the live database (October 2026): `t1Mzja…` sent 10,069 payments to the
 * app-hosting address, 78% of them exactly 0.02 FLUX, around the clock (hour-of-day entropy
 * 4.54 of a possible 4.58 bits); `t1XktDZ9…` sent 3,114 with varied amounts, equally
 * around the clock.
 *
 *  - **recurring_payer** — at least 20 payments to one counterparty on at least 10 days,
 *    that counterparty taking at least half of the wallet's payments. Amounts may vary (app
 *    prices do); the most common amount and its share are part of the evidence.
 *  - **automated** — at least 100 sends, active in at least 22 hours of the UTC day with an
 *    hour-of-day entropy of at least 4.2 bits. People sleep; scripts do not.
 *  - **collateral_amounts** — at least two sends of exactly a node collateral (1,000,
 *    12,500 or 40,000 FLUX), as when standing nodes up.
 *  - **dormant_waking** — a spend of at least 1,000 FLUX after at least 90 days without any
 *    activity. Only the stored window can be seen, so a wallet quiet since before it is
 *    not caught.
 *  - **peel_chain** — at least four hops in a row, each spending one wallet's coins into a
 *    small payment and a remainder (at least 80%) sent to a never-seen address, which is
 *    spent the same way within a day. Every hop's spender is tagged.
 */

import type { Db } from '../db/database.js';
import { SATS_PER_FLUX } from '../ingest/datasource/types.js';

export type BehaviourTagName =
  'recurring_payer' | 'automated' | 'collateral_amounts' | 'dormant_waking' | 'peel_chain';

export const BEHAVIOUR_TAGS: readonly BehaviourTagName[] = [
  'recurring_payer',
  'automated',
  'collateral_amounts',
  'dormant_waking',
  'peel_chain'
];

export interface BehaviourTag {
  readonly address: string;
  readonly tag: BehaviourTagName;
  readonly evidence: Record<string, unknown>;
}

export const BEHAVIOUR = {
  recurring: { minPayments: 20, minDays: 10, minShare: 0.5 },
  automated: { minSends: 100, minHours: 22, minEntropy: 4.2 },
  collateral: { minSends: 2, amounts: [1_000, 12_500, 40_000] },
  dormant: { minQuietSeconds: 90 * 86_400, minFlux: 1_000 },
  peel: { minHops: 4, minChangeShare: 0.8, maxGapBlocks: 2_880 }
} as const;

const DAY = 86_400;
const flux = (sat: number) => sat / SATS_PER_FLUX;
const round = (value: number, digits = 4) => Number(value.toFixed(digits));

/** Every detector, by the tag it produces. */
export const DETECTORS: Record<BehaviourTagName, (db: Db) => BehaviourTag[]> = {
  recurring_payer: (db) => recurringPayers(db),
  automated: (db) => automated(db),
  collateral_amounts: (db) => collateralAmounts(db),
  dormant_waking: (db) => dormantWaking(db),
  peel_chain: (db) => peelChains(db)
};

/** Run every detector over the stored window. */
export function detectBehaviour(db: Db): BehaviourTag[] {
  return BEHAVIOUR_TAGS.flatMap((tag) => DETECTORS[tag](db));
}

function recurringPayers(db: Db): BehaviourTag[] {
  const { minPayments, minDays, minShare } = BEHAVIOUR.recurring;

  const pairs = db
    .prepare<
      [number, number],
      {
        payer: string;
        counterparty: string;
        payments: number;
        days: number;
        first: number;
        last: number;
        all: number;
      }
    >(
      `WITH pair AS (
         SELECT from_address AS payer, to_address AS counterparty,
                COUNT(DISTINCT txid) AS payments, COUNT(DISTINCT time / ${DAY}) AS days,
                MIN(time) AS first, MAX(time) AS last
         FROM flows
         GROUP BY from_address, to_address
         HAVING payments >= ? AND days >= ?
       )
       SELECT pair.*, (SELECT COUNT(DISTINCT txid) FROM flows WHERE from_address = pair.payer) AS "all"
       FROM pair`
    )
    .all(minPayments, minDays);

  const common = db.prepare<[string, string], { sat: number; n: number }>(
    `SELECT sat, COUNT(*) AS n FROM flows WHERE from_address = ? AND to_address = ?
     GROUP BY sat ORDER BY n DESC, sat LIMIT 1`
  );

  // A payer with two qualifying counterparties keeps the larger one.
  const best = new Map<string, (typeof pairs)[number]>();
  for (const pair of pairs) {
    if (pair.payments / pair.all < minShare) continue;
    const current = best.get(pair.payer);
    if (!current || pair.payments > current.payments) best.set(pair.payer, pair);
  }

  return [...best.values()].map((pair) => {
    const mode = common.get(pair.payer, pair.counterparty)!;
    return {
      address: pair.payer,
      tag: 'recurring_payer',
      evidence: {
        counterparty: pair.counterparty,
        payments: pair.payments,
        days: pair.days,
        share: round(pair.payments / pair.all),
        commonAmount: flux(mode.sat),
        commonShare: round(mode.n / pair.payments),
        firstSeen: pair.first,
        lastSeen: pair.last
      }
    };
  });
}

function automated(db: Db): BehaviourTag[] {
  const { minSends, minHours, minEntropy } = BEHAVIOUR.automated;

  const rows = db
    .prepare<[number], { address: string; hour: number; sends: number }>(
      `SELECT from_address AS address, (time / 3600) % 24 AS hour, COUNT(DISTINCT txid) AS sends
       FROM flows
       WHERE from_address IN (
         SELECT from_address FROM flows GROUP BY from_address HAVING COUNT(DISTINCT txid) >= ?
       )
       GROUP BY from_address, hour`
    )
    .all(minSends);

  const byAddress = new Map<string, number[]>();
  for (const row of rows) {
    const hours = byAddress.get(row.address) ?? new Array<number>(24).fill(0);
    hours[row.hour] = row.sends;
    byAddress.set(row.address, hours);
  }

  const tags: BehaviourTag[] = [];
  for (const [address, hours] of byAddress) {
    // A send in two hours of one transaction cannot happen, so the hours sum to the sends.
    const sends = hours.reduce((sum, n) => sum + n, 0);
    const activeHours = hours.filter((n) => n > 0).length;
    const entropy = -hours
      .filter((n) => n > 0)
      .reduce((sum, n) => sum + (n / sends) * Math.log2(n / sends), 0);
    if (activeHours < minHours || entropy < minEntropy) continue;
    tags.push({
      address,
      tag: 'automated',
      evidence: { sends, activeHours, hourEntropy: round(entropy, 2) }
    });
  }
  return tags;
}

function collateralAmounts(db: Db): BehaviourTag[] {
  const { minSends, amounts } = BEHAVIOUR.collateral;
  const sats = amounts.map((amount) => amount * SATS_PER_FLUX);

  // Per transaction and recipient, so an output funded by two of the wallet's own addresses
  // is judged whole on the larger funder rather than missed.
  const rows = db
    .prepare<number[], { address: string; sat: number; n: number }>(
      `WITH output AS (
         SELECT txid, to_address, SUM(sat) AS sat,
                (SELECT f.from_address FROM flows f
                 WHERE f.txid = o.txid AND f.to_address = o.to_address
                 ORDER BY f.sat DESC, f.from_address LIMIT 1) AS sender
         FROM flows o
         GROUP BY txid, to_address
         HAVING SUM(sat) IN (${sats.map(() => '?').join(', ')})
       )
       SELECT sender AS address, sat, COUNT(*) AS n FROM output GROUP BY sender, sat`
    )
    .all(...sats);

  const byAddress = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const counts = byAddress.get(row.address) ?? {};
    counts[String(flux(row.sat))] = row.n;
    byAddress.set(row.address, counts);
  }

  return [...byAddress]
    .map(([address, byAmount]) => ({
      address,
      byAmount,
      sends: Object.values(byAmount).reduce((sum, n) => sum + n, 0)
    }))
    .filter((row) => row.sends >= minSends)
    .map(({ address, byAmount, sends }) => ({
      address,
      tag: 'collateral_amounts' as const,
      evidence: { sends, byAmount }
    }));
}

function dormantWaking(db: Db): BehaviourTag[] {
  const { minQuietSeconds, minFlux } = BEHAVIOUR.dormant;

  const rows = db
    .prepare<
      [number, number],
      { address: string; txid: string; time: number; sat: number; before: number }
    >(
      `SELECT * FROM (
         SELECT d.address, d.txid, d.time, d.sat_in - d.sat_out AS sat,
                (SELECT p.time FROM tx_deltas p INDEXED BY idx_tx_deltas_address
                 WHERE p.address = d.address AND p.height < d.height
                 ORDER BY p.height DESC LIMIT 1) AS before
         FROM tx_deltas d
         WHERE d.sat_in - d.sat_out >= ?
       )
       WHERE before IS NOT NULL AND time - before >= ?`
    )
    .all(minFlux * SATS_PER_FLUX, minQuietSeconds);

  // The previous activity is the latest earlier row by height: one seek on the
  // (address, height) index. `MAX(time)` there read every earlier row of a busy wallet,
  // for each of its large spends — 210 s instead of seconds on a 6-month database.

  // The longest sleep per wallet.
  const best = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const current = best.get(row.address);
    if (!current || row.time - row.before > current.time - current.before) {
      best.set(row.address, row);
    }
  }

  return [...best.values()].map((row) => ({
    address: row.address,
    tag: 'dormant_waking',
    evidence: {
      txid: row.txid,
      amount: flux(row.sat),
      quietDays: Math.floor((row.time - row.before) / DAY),
      lastActive: row.before,
      wokeAt: row.time
    }
  }));
}

interface Hop {
  readonly txid: string;
  readonly height: number;
  readonly spender: string;
  readonly change: string;
  readonly peeled: number;
}

function peelChains(db: Db): BehaviourTag[] {
  const { minHops, minChangeShare, maxGapBlocks } = BEHAVIOUR.peel;

  // Transactions with one net spender and two net recipients, read with each recipient's
  // earliest stored appearance so a "fresh" address can be told from a reused one.
  const rows = db
    .prepare<
      [],
      { txid: string; height: number; address: string; net: number; firstHeight: number }
    >(
      `WITH shape AS (
         SELECT txid FROM tx_deltas
         GROUP BY txid
         HAVING SUM(sat_in > sat_out) = 1 AND SUM(sat_out > sat_in) = 2
       )
       SELECT d.txid, d.height, d.address, d.sat_out - d.sat_in AS net,
              (SELECT MIN(p.height) FROM tx_deltas p INDEXED BY idx_tx_deltas_address
               WHERE p.address = d.address) AS firstHeight
       FROM shape JOIN tx_deltas d ON d.txid = shape.txid`
    )
    .all();

  const byTx = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byTx.get(row.txid) ?? [];
    list.push(row);
    byTx.set(row.txid, list);
  }

  // A hop: the larger recipient takes most of the money and has never been seen before.
  const bySpender = new Map<string, Hop>();
  for (const [txid, parts] of byTx) {
    const spender = parts.find((part) => part.net < 0);
    const [change, payee] = parts
      .filter((part) => part.net > 0)
      .sort((a, b) => b.net - a.net || (a.address < b.address ? -1 : 1));
    if (!spender || !change || !payee) continue;
    if (change.net / -spender.net < minChangeShare) continue;
    if (change.firstHeight < change.height) continue;
    bySpender.set(spender.address, {
      txid,
      height: spender.height,
      spender: spender.address,
      change: change.address,
      peeled: payee.net
    });
  }

  const next = (hop: Hop): Hop | undefined => {
    const following = bySpender.get(hop.change);
    return following && following.height - hop.height <= maxGapBlocks ? following : undefined;
  };
  const byChange = new Map([...bySpender.values()].map((hop) => [hop.change, hop] as const));

  const tags: BehaviourTag[] = [];
  for (const start of bySpender.values()) {
    // Walk only from the head of a chain: a spender that is nobody's linked change.
    const previous = byChange.get(start.spender);
    if (previous && next(previous) === start) continue;

    const chain = [start];
    for (let hop = next(start); hop && !chain.includes(hop); hop = next(hop)) chain.push(hop);
    if (chain.length < minHops) continue;

    const evidence = {
      hops: chain.length,
      start: start.spender,
      peeled: flux(chain.reduce((sum, hop) => sum + hop.peeled, 0)),
      firstTxid: chain[0]!.txid,
      lastTxid: chain[chain.length - 1]!.txid,
      firstHeight: chain[0]!.height,
      lastHeight: chain[chain.length - 1]!.height
    };
    for (const hop of chain) tags.push({ address: hop.spender, tag: 'peel_chain', evidence });
  }
  return tags;
}

/**
 * Store `tags` in place of every tag stored before. Returns false, and writes nothing, when
 * they are the same as what is stored: a write bumps the data version and empties caches.
 */
export function replaceBehaviourTags(db: Db, tags: readonly BehaviourTag[]): boolean {
  const key = (address: string, tag: string, evidence: string) =>
    `${address}\u0000${tag}\u0000${evidence}`;
  const stored = new Set(
    db
      .prepare<[], { address: string; tag: string; evidence: string }>(
        `SELECT address, tag, evidence FROM behaviour_tags`
      )
      .all()
      .map((row) => key(row.address, row.tag, row.evidence))
  );
  const next = tags.map((row) => ({ ...row, json: JSON.stringify(row.evidence) }));
  if (
    next.length === stored.size &&
    next.every((row) => stored.has(key(row.address, row.tag, row.json)))
  ) {
    return false;
  }

  const insert = db.prepare<[string, string, string]>(
    `INSERT OR REPLACE INTO behaviour_tags (address, tag, evidence) VALUES (?, ?, ?)`
  );
  db.transaction(() => {
    db.exec(`DELETE FROM behaviour_tags`);
    for (const row of next) insert.run(row.address, row.tag, row.json);
  })();
  return true;
}

export interface StoredTag {
  readonly tag: BehaviourTagName;
  readonly evidence: Record<string, unknown>;
  readonly updatedAt: number;
}

/** One wallet's tags, in the order of {@link BEHAVIOUR_TAGS}. */
export function tagsOf(db: Db, address: string): StoredTag[] {
  return db
    .prepare<[string], { tag: BehaviourTagName; evidence: string; updatedAt: number }>(
      `SELECT tag, evidence, updated_at AS updatedAt FROM behaviour_tags WHERE address = ?`
    )
    .all(address)
    .map((row) => ({ ...row, evidence: JSON.parse(row.evidence) as Record<string, unknown> }))
    .sort((a, b) => BEHAVIOUR_TAGS.indexOf(a.tag) - BEHAVIOUR_TAGS.indexOf(b.tag));
}

/** Tag names for many wallets at once, for leaderboards. */
export function tagNamesOf(db: Db, addresses: readonly string[]): Map<string, BehaviourTagName[]> {
  const result = new Map<string, BehaviourTagName[]>();
  if (addresses.length === 0) return result;
  const rows = db
    .prepare<string[], { address: string; tag: BehaviourTagName }>(
      `SELECT address, tag FROM behaviour_tags WHERE address IN (${addresses.map(() => '?').join(', ')})`
    )
    .all(...addresses);
  for (const row of rows) {
    const list = result.get(row.address) ?? [];
    list.push(row.tag);
    result.set(row.address, list);
  }
  for (const list of result.values()) {
    list.sort((a, b) => BEHAVIOUR_TAGS.indexOf(a) - BEHAVIOUR_TAGS.indexOf(b));
  }
  return result;
}
