/**
 * How often is each heuristic right? (#19)
 *
 * Every inferred label is checked against independent ground truth:
 *
 *  - **Node rewards → node operator.** Ground truth: the deterministic node list. Precision is
 *    the share of reward recipients (judged on rewards alone) that are payment addresses on
 *    the list. Recipients that left the list are counted as misses, so this is a lower bound.
 *  - **Exchange candidates (clustering, sweeps).** Ground truth: the exchange addresses in
 *    the config. Each known address is held out in turn and the heuristics are asked to
 *    recover it from the others; a recovered address under the wrong exchange, or one that
 *    is actually on the node list, is a false positive.
 *  - **Reward forwarding.** No independent ground truth exists for "this wallet belongs to a
 *    node operator", so it is reported as unvalidated, with how many of its labels collide
 *    with a known exchange or Foundation address (which would be wrong).
 *
 * `npm run precision -- <db>` prints the report for a database; CI asserts thresholds on a
 * fixture (`precision.test.ts`).
 */

import type { Db } from '../db/database.js';
import type { NodeList } from './nodes.js';
import { computeNodeOperatorLabels } from './nodes.js';

export interface MethodReport {
  readonly method: string;
  /** Labels this method produced. */
  readonly labels: number;
  /** Of those, how many could be checked against ground truth. */
  readonly checked: number;
  readonly correct: number;
  /** `correct / checked`, or null when nothing could be checked. */
  readonly precision: number | null;
  readonly notes?: string;
}

export interface PrecisionReport {
  readonly generatedAt: number;
  readonly ground: { nodeListAddresses: number; configExchanges: number };
  readonly methods: MethodReport[];
  readonly coverage: {
    /** Node-list payment addresses that received a reward in the stored blocks. */
    readonly nodeListWithRewards: number;
    readonly protocolPayouts: number;
  };
}

function ratio(correct: number, checked: number): number | null {
  return checked > 0 ? Number((correct / checked).toFixed(4)) : null;
}

/**
 * @param list the current node list (ground truth for node operators)
 * @param configExchanges known exchange addresses → exchange name (ground truth for exchanges)
 */
export function precisionReport(
  db: Db,
  list: NodeList,
  configExchanges: ReadonlyMap<string, string>
): PrecisionReport {
  // Judge rewards alone: compute as if the list were unknown, then compare with it.
  const blind = computeNodeOperatorLabels(db, null);
  const rewardRecipients = blind.nodeRewards.map((row) => row.address);
  const onList = rewardRecipients.filter((address) => list.has(address)).length;
  const rewarded = new Set(rewardRecipients);

  const forwarding = computeNodeOperatorLabels(db, list).forwarding;
  const collisions = forwarding.filter((row) => configExchanges.has(row.address)).length;

  const holdout = exchangeHoldout(db, list, configExchanges);

  return {
    generatedAt: Date.now(),
    ground: { nodeListAddresses: list.size, configExchanges: configExchanges.size },
    methods: [
      {
        method: 'node_rewards',
        labels: rewardRecipients.length,
        checked: rewardRecipients.length,
        correct: onList,
        precision: ratio(onList, rewardRecipients.length),
        notes: 'lower bound: operators who left the node list count as misses'
      },
      {
        method: 'reward_forwarding',
        labels: forwarding.length,
        checked: collisions > 0 ? collisions : 0,
        correct: 0,
        precision: null,
        notes:
          collisions > 0
            ? `${collisions} label(s) collide with a known exchange address`
            : 'unvalidated: no independent ground truth; no collisions with known exchanges'
      },
      holdout
    ],
    coverage: {
      nodeListWithRewards: [...list.keys()].filter((address) => rewarded.has(address)).length,
      protocolPayouts: blind.protocolPayouts.length
    }
  };
}

/**
 * Hold each known exchange address out and see whether the clustering evidence recovers it.
 *
 * Uses `address_clusters` (rebuilt by the clustering pass): an address is recovered when its
 * cluster contains another known address. Correct when that address belongs to the same
 * exchange; a false positive when it belongs to another exchange or is a node payment address.
 */
function exchangeHoldout(
  db: Db,
  list: NodeList,
  configExchanges: ReadonlyMap<string, string>
): MethodReport {
  const clusterOf = db.prepare<[string], { cluster_id: string }>(
    `SELECT cluster_id FROM address_clusters WHERE address = ?`
  );
  const membersOf = db.prepare<[string], { address: string }>(
    `SELECT address FROM address_clusters WHERE cluster_id = ?`
  );

  let checked = 0;
  let correct = 0;

  for (const [address, name] of configExchanges) {
    const cluster = clusterOf.get(address);
    if (!cluster) continue;

    const anchors = membersOf
      .all(cluster.cluster_id)
      .map((row) => row.address)
      .filter((member) => member !== address && configExchanges.has(member));
    if (anchors.length === 0) continue;

    checked++;
    const agrees = anchors.every((anchor) => configExchanges.get(anchor) === name);
    if (agrees && !list.has(address)) correct++;
  }

  // Candidates that are actually node payment addresses are wrong whatever the exchange.
  const candidates = db
    .prepare<[], { address: string }>(
      `SELECT address FROM label_candidates WHERE kind = 'exchange'`
    )
    .all();
  const onNodeList = candidates.filter((row) => list.has(row.address)).length;

  return {
    method: 'exchange_clustering',
    labels: candidates.length,
    checked: checked + onNodeList,
    correct,
    precision: ratio(correct, checked + onNodeList),
    notes:
      checked === 0
        ? `no known exchange address shares a cluster with another (${candidates.length} candidates, ${onNodeList} on the node list)`
        : `${checked} known address(es) recoverable by hold-out; ${onNodeList} candidate(s) are node payment addresses`
  };
}
