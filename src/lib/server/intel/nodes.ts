/**
 * Node operators, from data we already hold (#18, #19).
 *
 * v1 guessed "node operator" from external API calls and wallet-history heuristics, which
 * produced confident labels for addresses that had never run a node. Here the evidence is
 * the chain itself:
 *
 *  - **`node_list` — confirmed.** The address is a payment address on the current
 *    deterministic FluxNode list. Read from your own node when `FLUX_NODE_URL` is set,
 *    otherwise from the explorer.
 *  - **`node_rewards` — likely.** The address received coinbase rewards in blocks we stored
 *    but is not on the list now: it ran nodes and stopped. Valid until 30 days after its last
 *    reward, so a sale long after it shut its nodes down is not "node operator selling".
 *  - **`forwarding` — likely or possible.** Up to two hops from node payout addresses: a
 *    wallet whose inbound value is nearly all node money (operators sweep rewards into one
 *    before selling), or that sends nearly all its value to node addresses (buying FLUX to
 *    stand nodes up). `possible` is shown with evidence but never changes a flow.
 *
 * Excluded: an address paid in at least half of all blocks. That is a protocol payout (a
 * development fund paid every block), not a node — the live data has exactly one, paid in
 * every single block.
 */

import type { Db } from '../db/database.js';
import { httpJson, type HttpRequestOptions } from '../http.js';
import { APPLY_MIN_CONFIDENCE, CONFIDENCE, type LabelInput } from '../labels.js';
import type { AddressKind } from '../ingest/datasource/types.js';

/** After its last reward, an address stays a node operator for this long. */
export const NODE_GRACE_SECONDS = 30 * 86_400;

/** Paid in at least this share of all stored blocks: a protocol payout, not a node. */
export const PROTOCOL_PAYOUT_SHARE = 0.5;

/**
 * Forwarding thresholds.
 *
 * "Likely" needs nearly all of a wallet's inbound to be node money and none of it bought on
 * an exchange, but no longer a transfer count: operators sweep weekly or monthly, so three
 * transfers inside the raw window left 67 of 74 forwarding wallets at "possible" — never
 * applied — and node operators showed no selling at all.
 */
export const FORWARDING = {
  likelyShare: 0.9,
  /** Minimum node money before a wallet is "likely" (dust says nothing). */
  likelyMinFlux: 100,
  possibleShare: 0.5,
  /** Rounds: node → W1 is round 1, W1 → W2 round 2. */
  rounds: 2,
  /** Confidence per round; both at or above "likely" so they apply. */
  confidence: [CONFIDENCE.likely - 0.05, CONFIDENCE.likely - 0.08],
  /** Node funding: share of a wallet's outflow that goes to node operators. */
  fundingShare: 0.9,
  /** At least one Cumulus collateral. */
  fundingMinFlux: 1_000
} as const;

export interface NodeListEntry {
  readonly nodes: number;
  readonly tiers: Record<string, number>;
}

/** Payment addresses on the deterministic list, with how many nodes and of which tiers. */
export type NodeList = ReadonlyMap<string, NodeListEntry>;

/**
 * Parse `viewdeterministicfluxnodelist` (daemon, FluxOS envelope) or the explorer's
 * `getFluxNodes`. Both carry `payment_address` and `tier` per node; the wrappers differ.
 */
export function parseNodeList(payload: unknown): Map<string, NodeListEntry> {
  const list = new Map<string, { nodes: number; tiers: Record<string, number> }>();

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value === null || typeof value !== 'object') return;

    const record = value as Record<string, unknown>;
    for (const [key, nested] of Object.entries(record)) {
      if (/^(data|nodes?|flux_?nodes?|result)$/i.test(key)) visit(nested);
    }

    const address = [record.payment_address, record.paymentAddress, record.payment_addr].find(
      (candidate): candidate is string =>
        typeof candidate === 'string' && /^t[13]\w{20,40}$/.test(candidate)
    );
    if (!address) return;

    const tier = typeof record.tier === 'string' ? record.tier.toUpperCase() : 'UNKNOWN';
    const entry = list.get(address) ?? { nodes: 0, tiers: {} };
    entry.nodes++;
    entry.tiers[tier] = (entry.tiers[tier] ?? 0) + 1;
    list.set(address, entry);
  };

  visit(payload);
  return list;
}

/**
 * The transactions that created a live node's collateral, from the same node-list payload.
 *
 * Each entry names its collateral outpoint (`txhash`, or `collateral: "COutPoint(txid, n)"`).
 * A payment in one of these transactions, of exactly a collateral amount, is node collateral
 * for certain rather than a round number that happens to match (#31).
 */
export function parseCollateralTxids(payload: unknown): Set<string> {
  const txids = new Set<string>();

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value === null || typeof value !== 'object') return;

    const record = value as Record<string, unknown>;
    for (const [key, nested] of Object.entries(record)) {
      if (/^(data|nodes?|flux_?nodes?|result)$/i.test(key)) visit(nested);
    }

    const fromOutpoint =
      typeof record.collateral === 'string'
        ? /COutPoint\(([0-9a-f]{64})/i.exec(record.collateral)?.[1]
        : undefined;
    const txid = typeof record.txhash === 'string' ? record.txhash : fromOutpoint;
    if (txid && /^[0-9a-f]{64}$/i.test(txid)) txids.add(txid.toLowerCase());
  };

  visit(payload);
  return txids;
}

/**
 * Fetch the current node list: your own node first, the explorer otherwise.
 * @returns `null` when neither answers — callers then keep the list they had.
 */
export async function fetchNodeList(options: {
  readonly ownNodeUrl?: string | undefined;
  readonly explorerUrl: string;
  readonly http?: Partial<HttpRequestOptions>;
}): Promise<{ list: NodeList; source: string; collateralTxids: Set<string> } | null> {
  const attempts = [
    ...(options.ownNodeUrl
      ? [
          {
            url: `${options.ownNodeUrl.replace(/\/+$/, '')}/daemon/viewdeterministicfluxnodelist`,
            source: 'own-node'
          }
        ]
      : []),
    { url: options.explorerUrl, source: 'explorer' }
  ];

  for (const attempt of attempts) {
    try {
      const payload = await httpJson<unknown>(attempt.url, {
        timeoutMs: 30_000,
        retries: 1,
        ...options.http
      });
      const list = parseNodeList(payload);
      // An empty or reshaped answer says nothing about the nodes; do not replace a list with it.
      if (list.size > 0) {
        return { list, source: attempt.source, collateralTxids: parseCollateralTxids(payload) };
      }
    } catch {
      // Try the next source.
    }
  }

  return null;
}

export interface NodeOperatorLabels {
  readonly nodeList: LabelInput[] | null;
  readonly nodeRewards: LabelInput[];
  readonly forwarding: LabelInput[];
  /** Addresses paid in so many blocks they must be a protocol payout. */
  readonly protocolPayouts: { address: string; rewards: number; share: number }[];
}

interface RewardRow {
  address: string;
  rewards: number;
  sat: number;
  firstHeight: number;
  lastHeight: number;
  lastTime: number;
}

/**
 * Compute node-operator labels from stored rewards, the node list (if known) and flows.
 *
 * Pure apart from reading: callers write each source with `replaceSourceLabels` and then
 * refresh the label book, which queues re-derivation for whatever changed.
 *
 * @param list the current node list, or `null` when it could not be fetched — then the
 *   `node_list` labels are left as they are and reward recipients are judged on rewards alone.
 * @param exclude addresses already labelled as something else (exchanges, Foundation), which
 *   forwarding must not claim.
 */
export function computeNodeOperatorLabels(
  db: Db,
  list: NodeList | null,
  exclude: ReadonlySet<string> = new Set()
): NodeOperatorLabels {
  const blocks = db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM blocks`).get()?.n ?? 0;

  const rewards = db
    .prepare<[], RewardRow>(
      `SELECT g.address, g.rewards, g.sat, g.firstHeight, g.lastHeight,
              COALESCE(b.time, g.lastDay) AS lastTime
       FROM (
         SELECT address, SUM(reward_count) AS rewards, SUM(sat) AS sat,
                MIN(height) AS firstHeight, MAX(height) AS lastHeight, MAX(day) AS lastDay
         FROM node_rewards
         GROUP BY address
       ) g
       LEFT JOIN blocks b ON b.height = g.lastHeight`
    )
    .all();

  const protocolPayouts: NodeOperatorLabels['protocolPayouts'] = [];
  const rewardBy = new Map<string, RewardRow>();

  for (const row of rewards) {
    const share = blocks > 0 ? row.rewards / blocks : 0;
    if (blocks >= 100 && share >= PROTOCOL_PAYOUT_SHARE) {
      protocolPayouts.push({ address: row.address, rewards: row.rewards, share });
      continue;
    }
    rewardBy.set(row.address, row);
  }

  const protocol = new Set(protocolPayouts.map((payout) => payout.address));

  const nodeList: LabelInput[] | null = list
    ? [...list]
        .filter(([address]) => !protocol.has(address))
        .map(([address, entry]) => {
          const reward = rewardBy.get(address);
          return {
            address,
            kind: 'node_operator' as AddressKind,
            confidence: CONFIDENCE.confirmed,
            evidence: {
              method: 'node_list',
              nodes: entry.nodes,
              tiers: entry.tiers,
              rewards: reward?.rewards ?? 0,
              lastRewardHeight: reward?.lastHeight ?? null
            }
          };
        })
    : null;

  const nodeRewards: LabelInput[] = [];
  for (const [address, reward] of rewardBy) {
    if (list?.has(address)) continue;

    nodeRewards.push({
      address,
      kind: 'node_operator',
      confidence: CONFIDENCE.likely,
      validTo: reward.lastTime + NODE_GRACE_SECONDS,
      evidence: {
        method: 'coinbase_rewards',
        rewards: reward.rewards,
        rewardsFlux: reward.sat / 1e8,
        firstRewardHeight: reward.firstHeight,
        lastRewardHeight: reward.lastHeight,
        onNodeList: list ? false : null
      }
    });
  }

  // Without a fresh list, the stored one still stands (its labels are kept, see above): a
  // failed fetch must not shrink the operator set and wipe every forwarding label with it.
  const listed = nodeList
    ? nodeList.map((row) => row.address)
    : db
        .prepare<[], { address: string }>(
          `SELECT address FROM address_labels WHERE source = 'node_list'`
        )
        .all()
        .map((row) => row.address)
        .filter((address) => !protocol.has(address));

  const operators = new Set([...listed, ...nodeRewards.map((row) => row.address)]);

  return {
    nodeList,
    nodeRewards,
    forwarding: forwardingLabels(db, operators, exclude),
    protocolPayouts
  };
}

/**
 * Wallets that belong to node operators without being on the list: the hops between a node
 * and an exchange, in either direction.
 *
 *  - **Reward forwarding** (node → W → exchange). W receives nearly all its value from node
 *    operators and never bought on an exchange. Two rounds, so node → W1 → W2 is found
 *    too: round 2 counts round 1's likely wallets as operators.
 *  - **Node funding** (exchange → W → node). W sends nearly all its value to node operators,
 *    at least a collateral's worth: a wallet buying FLUX to stand nodes up.
 *
 * Reads `flows`, which hold every transfer with each funder's share (`derive.ts`), so no
 * external history is needed. Addresses already labelled as something else are skipped.
 */
function forwardingLabels(
  db: Db,
  operators: ReadonlySet<string>,
  exclude: ReadonlySet<string>
): LabelInput[] {
  if (operators.size === 0) return [];

  const labels = new Map<string, LabelInput>();
  const known = new Set(operators);

  for (let round = 0; round < FORWARDING.rounds; round++) {
    const found = forwardingRound(db, known, exclude, round);
    for (const label of found) {
      const previous = labels.get(label.address);
      if (!previous || previous.confidence < label.confidence) labels.set(label.address, label);
    }

    const likely = found.filter((label) => label.confidence >= APPLY_MIN_CONFIDENCE);
    if (likely.length === 0) break;
    for (const label of likely) known.add(label.address);
  }

  for (const label of fundingLabels(db, operators, exclude)) {
    const previous = labels.get(label.address);
    if (!previous || previous.confidence < label.confidence) labels.set(label.address, label);
  }

  return [...labels.values()];
}

function withOperators<T>(db: Db, operators: ReadonlySet<string>, read: () => T): T {
  return db.transaction(() => {
    db.prepare(`CREATE TEMP TABLE IF NOT EXISTS operator_set (address TEXT PRIMARY KEY)`).run();
    db.prepare(`DELETE FROM operator_set`).run();
    const insert = db.prepare(`INSERT OR IGNORE INTO operator_set (address) VALUES (?)`);
    for (const address of operators) insert.run(address);
    return read();
  })();
}

function forwardingRound(
  db: Db,
  operators: ReadonlySet<string>,
  exclude: ReadonlySet<string>,
  round: number
): LabelInput[] {
  const rows = withOperators(db, operators, () =>
    db
      .prepare<
        [],
        {
          address: string;
          fromNodes: number;
          transfers: number;
          senders: number;
          inbound: number;
          fromExchanges: number;
        }
      >(
        `WITH fed AS (
           SELECT f.to_address AS address, SUM(f.sat) AS fromNodes, COUNT(*) AS transfers,
                  COUNT(DISTINCT f.from_address) AS senders
           FROM flows f JOIN operator_set o ON o.address = f.from_address
           WHERE f.to_address NOT IN (SELECT address FROM operator_set)
           GROUP BY f.to_address
         )
         SELECT fed.address, fed.fromNodes, fed.transfers, fed.senders,
                (SELECT SUM(sat) FROM flows WHERE to_address = fed.address) AS inbound,
                (SELECT COUNT(*) FROM flows
                 WHERE to_address = fed.address AND from_kind = 'exchange') AS fromExchanges
         FROM fed`
      )
      .all()
  );

  const labels: LabelInput[] = [];

  for (const row of rows) {
    if (exclude.has(row.address) || row.inbound <= 0) continue;

    const share = row.fromNodes / row.inbound;
    const likely =
      share >= FORWARDING.likelyShare &&
      row.fromNodes >= FORWARDING.likelyMinFlux * 1e8 &&
      row.fromExchanges === 0;
    if (!likely && share < FORWARDING.possibleShare) continue;

    labels.push({
      address: row.address,
      kind: 'node_operator',
      confidence: likely ? FORWARDING.confidence[round]! : CONFIDENCE.possible,
      evidence: {
        method: 'reward_forwarding',
        hops: round + 1,
        shareFromNodes: Number(share.toFixed(3)),
        transfersFromNodes: row.transfers,
        distinctNodeSenders: row.senders,
        fluxFromNodes: row.fromNodes / 1e8,
        boughtOnExchange: row.fromExchanges > 0
      }
    });
  }

  return labels;
}

function fundingLabels(
  db: Db,
  operators: ReadonlySet<string>,
  exclude: ReadonlySet<string>
): LabelInput[] {
  const rows = withOperators(db, operators, () =>
    db
      .prepare<[number], { address: string; toNodes: number; outbound: number; nodes: number }>(
        `WITH funds AS (
           SELECT f.from_address AS address, SUM(f.sat) AS toNodes,
                  COUNT(DISTINCT f.to_address) AS nodes
           FROM flows f JOIN operator_set o ON o.address = f.to_address
           WHERE f.from_address NOT IN (SELECT address FROM operator_set)
           GROUP BY f.from_address
           HAVING toNodes >= ?
         )
         SELECT funds.address, funds.toNodes, funds.nodes,
                (SELECT SUM(sat) FROM flows WHERE from_address = funds.address) AS outbound
         FROM funds`
      )
      .all(FORWARDING.fundingMinFlux * 1e8)
  );

  return rows
    .filter(
      (row) =>
        !exclude.has(row.address) &&
        row.outbound > 0 &&
        row.toNodes / row.outbound >= FORWARDING.fundingShare
    )
    .map((row) => ({
      address: row.address,
      kind: 'node_operator' as AddressKind,
      confidence: FORWARDING.confidence[0],
      evidence: {
        method: 'node_funding',
        shareToNodes: Number((row.toNodes / row.outbound).toFixed(3)),
        fluxToNodes: row.toNodes / 1e8,
        nodeAddresses: row.nodes
      }
    }));
}
