import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type Db } from '../testkit.js';
import { replaceSourceLabels, type LabelLookup } from '../labels.js';
import { BlockWriter } from '../ingest/writer.js';
import {
  computeNodeOperatorLabels,
  NODE_GRACE_SECONDS,
  parseNodeList,
  type NodeListEntry
} from './nodes.js';
import { clusterAddresses, decideCandidate, listCandidates, storeCandidates } from './clusters.js';
import { detectHops, listHops, summariseHops } from './hops.js';
import { foundationReport } from './foundation.js';
import { precisionReport } from './precision.js';
import { blockTime, labelBook, writeChain, type SimpleTx } from './testchain.js';

const KUCOIN = 't1kucoinHot';
const COINEX = 't1coinexHot';
const LABELS = {
  exchanges: [
    { name: 'Kucoin', addresses: [KUCOIN, 't1kucoinCold'] },
    { name: 'Coinex', addresses: [COINEX] }
  ],
  foundation: {
    name: 'Flux Foundation',
    addresses: ['t1found1'],
    wallets: [{ name: 'Treasury', addresses: ['t1treasury'] }]
  }
};

function coinbase(height: number, payees: string[]): SimpleTx {
  return { height, txid: `cb-${height}`, kind: 'coinbase', outputs: payees.map((p) => [p, 1]) };
}

describe('node operators (#18, #19)', () => {
  let db: Db;
  let labels: LabelLookup;

  beforeEach(() => {
    db = createTestDb();
    labels = labelBook(db, LABELS);
  });

  afterEach(() => db.close());

  it('parses the daemon node list and the explorer shape', () => {
    const daemon = parseNodeList({
      status: 'success',
      data: [
        { payment_address: 't1X1hKAb9rYmsikPKVJXBHueJU4VeuV7Tbb', tier: 'CUMULUS' },
        { payment_address: 't1X1hKAb9rYmsikPKVJXBHueJU4VeuV7Tbb', tier: 'STRATUS' },
        { payment_address: 'not-an-address', tier: 'NIMBUS' }
      ]
    });
    expect(daemon.get('t1X1hKAb9rYmsikPKVJXBHueJU4VeuV7Tbb')).toEqual({
      nodes: 2,
      tiers: { CUMULUS: 1, STRATUS: 1 }
    });
    expect(daemon.size).toBe(1);

    const explorer = parseNodeList({
      fluxNodes: [{ payment_address: 't3hPu1YDeGUCp8m7BQCnnNUmRMJBa5RadyA', tier: 'nimbus' }]
    });
    expect(explorer.size).toBe(1);
  });

  it('confirms list addresses, rates past earners likely, and excludes protocol payouts', () => {
    // 120 blocks: the dev fund is paid in every one; op1 sometimes; gone1 early on only.
    const chain: SimpleTx[] = [];
    for (let height = 1; height <= 120; height++) {
      const payees = ['t3devfund'];
      if (height % 10 === 0) payees.push('t1op1');
      if (height < 5) payees.push('t1gone1');
      chain.push(coinbase(height, payees));
    }
    writeChain(db, labels, chain);

    const list = new Map<string, NodeListEntry>([
      ['t1op1', { nodes: 2, tiers: { CUMULUS: 2 } }],
      ['t1listonly', { nodes: 1, tiers: { STRATUS: 1 } }]
    ]);
    const result = computeNodeOperatorLabels(db, list);

    expect(result.protocolPayouts.map((payout) => payout.address)).toEqual(['t3devfund']);
    expect(result.nodeList!.map((row) => [row.address, row.confidence])).toEqual([
      ['t1op1', 1],
      ['t1listonly', 1]
    ]);
    expect(result.nodeRewards).toHaveLength(1);
    expect(result.nodeRewards[0]).toMatchObject({
      address: 't1gone1',
      confidence: 0.8,
      validTo: blockTime(4) + NODE_GRACE_SECONDS
    });
  });

  it('labels a wallet fed mostly by node payouts, conservatively', () => {
    const chain: SimpleTx[] = [coinbase(1, ['t1op1', 't1op2'])];
    // t1sweep: 3 transfers from operators, nothing else -> likely.
    for (let index = 0; index < 3; index++) {
      chain.push({
        height: 10 + index,
        txid: `s${index}`,
        inputs: [[index % 2 ? 't1op1' : 't1op2', 10]],
        outputs: [['t1sweep', 9.9]]
      });
    }
    // t1mixed: one operator transfer and one bigger one from a stranger -> not labelled.
    chain.push({ height: 20, txid: 'm1', inputs: [['t1op1', 5]], outputs: [['t1mixed', 4.9]] });
    chain.push({
      height: 21,
      txid: 'm2',
      inputs: [['t1stranger', 50]],
      outputs: [['t1mixed', 49]]
    });
    writeChain(db, labels, chain);

    const forwarding = computeNodeOperatorLabels(db, null).forwarding;
    expect(forwarding.map((row) => [row.address, row.confidence >= 0.7])).toEqual([
      ['t1sweep', true]
    ]);
  });
});

describe('clustering and exchange candidates (#20)', () => {
  let db: Db;
  let labels: LabelLookup;

  beforeEach(() => {
    db = createTestDb();
    labels = labelBook(db, LABELS);
  });

  afterEach(() => db.close());

  it('proposes addresses co-spent with a known exchange wallet, and applies none of them', () => {
    writeChain(db, labels, [
      {
        height: 1,
        txid: 'co1',
        inputs: [
          [KUCOIN, 10],
          ['t1kucoinUnknown', 10]
        ],
        outputs: [['t1customer', 19.9]]
      }
    ]);

    const result = clusterAddresses(db, labels);
    expect(result.clusters).toBe(1);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        address: 't1kucoinUnknown',
        name: 'Kucoin',
        method: 'common_input'
      })
    ]);

    storeCandidates(db, result.candidates);
    expect(labels.kindOf('t1kucoinUnknown')).toBe('unknown');
  });

  it('proposes deposit addresses swept into a known exchange wallet', () => {
    writeChain(db, labels, [
      {
        height: 1,
        txid: 'sweep',
        inputs: [
          ['t1dep1', 5],
          ['t1dep2', 7],
          ['t1dep3', 3]
        ],
        outputs: [[COINEX, 14.99]]
      }
    ]);

    const candidates = clusterAddresses(db, labels).candidates.filter(
      (candidate) => candidate.method === 'sweep'
    );
    expect(candidates.map((candidate) => [candidate.address, candidate.name])).toEqual([
      ['t1dep1', 'Coinex'],
      ['t1dep2', 'Coinex'],
      ['t1dep3', 'Coinex']
    ]);
  });

  it('skips CoinJoin-shaped transactions and refuses clusters spanning two exchanges', () => {
    writeChain(db, labels, [
      {
        height: 1,
        txid: 'coinjoin',
        inputs: [1, 2, 3, 4, 5].map((n) => [`t1cj${n}`, 10] as const),
        outputs: [1, 2, 3, 4, 5].map((n) => [`t1cjout${n}`, 9.9] as const)
      },
      {
        height: 2,
        txid: 'both',
        inputs: [
          [KUCOIN, 1],
          [COINEX, 1],
          ['t1between', 1]
        ],
        outputs: [['t1x', 2.9]]
      }
    ]);

    const result = clusterAddresses(db, labels);
    expect(result.skippedCoinjoins).toBe(1);
    expect(result.conflicts).toEqual([
      expect.objectContaining({ exchanges: ['Coinex', 'Kucoin'] })
    ]);
    expect(result.candidates.filter((c) => c.method === 'common_input')).toEqual([]);
  });

  it('applies a candidate only when accepted, and withdraws it when rejected', () => {
    writeChain(db, labels, [
      {
        height: 1,
        txid: 'co1',
        inputs: [
          [KUCOIN, 10],
          ['t1kucoinUnknown', 10]
        ],
        outputs: [['t1customer', 19.9]]
      }
    ]);
    storeCandidates(db, clusterAddresses(db, labels).candidates);
    const key = { address: 't1kucoinUnknown', kind: 'exchange', name: 'Kucoin' };

    expect(decideCandidate(db, labels, key, 'accepted')).toBe(true);
    expect(labels.labelOf('t1kucoinUnknown')).toMatchObject({
      kind: 'exchange',
      source: 'accepted',
      level: 'likely'
    });
    expect(listCandidates(db, { status: 'accepted' })).toHaveLength(1);

    // A later clustering pass does not reset the decision.
    storeCandidates(db, clusterAddresses(db, labels).candidates);
    expect(listCandidates(db, { status: 'accepted' })).toHaveLength(1);

    expect(decideCandidate(db, labels, key, 'rejected')).toBe(true);
    expect(labels.kindOf('t1kucoinUnknown')).toBe('unknown');
    expect(decideCandidate(db, labels, { ...key, name: 'nope' }, 'accepted')).toBe(false);
  });
});

describe('exchange hops (#20)', () => {
  let db: Db;
  let labels: LabelLookup;

  beforeEach(() => {
    db = createTestDb();
    labels = labelBook(db, LABELS);
  });

  afterEach(() => db.close());

  const hopChain: SimpleTx[] = [
    // Withdraw 7,866 from Coinex, deposit 7,860 into Kucoin 13 blocks later: a hop.
    { height: 100, txid: 'w', inputs: [[COINEX, 7_866.1]], outputs: [['t1arb', 7_866]] },
    { height: 113, txid: 'd', inputs: [['t1arb', 7_860.1]], outputs: [[KUCOIN, 7_860]] },
    // A real buyer who sells half much later: not a hop.
    { height: 200, txid: 'b', inputs: [[KUCOIN, 100.1]], outputs: [['t1holder', 100]] },
    { height: 900, txid: 's', inputs: [['t1holder', 99.9]], outputs: [[COINEX, 99.8]] }
  ];

  it('matches a withdrawal re-deposited shortly after, and nothing else', () => {
    writeChain(db, labels, hopChain);
    expect(detectHops(db, 0).hops).toBe(1);

    expect(listHops(db, 0, 2e9)).toEqual([
      expect.objectContaining({
        address: 't1arb',
        fromExchange: 'Coinex',
        toExchange: 'Kucoin',
        blocksApart: 13
      })
    ]);
    expect(summariseHops(db, 0, 2e9)).toMatchObject({
      count: 1,
      buyingExcluded: 7_866,
      sellingExcluded: 7_860
    });
  });

  it('is incremental, and drops a hop when a leg is rolled back', () => {
    writeChain(db, labels, hopChain);
    detectHops(db, 0);
    detectHops(db, 150);
    expect(summariseHops(db, 0, 2e9).count).toBe(1);

    new BlockWriter(db).rollbackFrom(113);
    expect(summariseHops(db, 0, 2e9).count).toBe(0);
  });
});

describe('Foundation report (#31)', () => {
  it('nets internal moves out and reports flows per wallet, with balance history', () => {
    const db = createTestDb();
    const labels = labelBook(db, LABELS);

    writeChain(db, labels, [
      { height: 1, txid: 'in', inputs: [['t1donor', 500.1]], outputs: [['t1found1', 500]] },
      {
        height: 2,
        txid: 'internal',
        inputs: [['t1found1', 400]],
        outputs: [['t1treasury', 399.999]]
      },
      { height: 3000, txid: 'out', inputs: [['t1treasury', 100]], outputs: [[KUCOIN, 99.9]] }
    ]);

    const balances = {
      at: Date.now(),
      sat: new Map([
        ['t1found1', 100 * 1e8],
        ['t1treasury', 299.999 * 1e8]
      ])
    };
    const report = foundationReport(db, labels, { fromTime: 0, toTime: 2e9 }, balances);

    expect(report.totals).toMatchObject({ inflow: 500, outflow: 100, internalTransfers: 1 });
    expect(report.wallets.find((w) => w.address === 't1treasury')).toMatchObject({
      subLabel: 'Treasury',
      outflow: 100,
      inflow: 0
    });
    expect(report.recent.map((m) => [m.txid, m.counterpartyName])).toEqual([
      ['out', 'Kucoin'],
      ['in', null]
    ]);
    // Day 1 closes at 500 (the internal move nets ~0); day 2 at 400 after the outflow.
    expect(report.series.map((point) => Math.round(point.balance!))).toEqual([500, 400]);
    db.close();
  });
});

describe('precision report (#19)', () => {
  it('meets the thresholds on a fixture', () => {
    const db = createTestDb();
    const labels = labelBook(db, LABELS);

    const chain: SimpleTx[] = [];
    for (let height = 1; height <= 200; height++) {
      const payees = ['t3devfund', `t1op${height % 20}`];
      if (height === 7) payees.push('t1retired');
      chain.push(coinbase(height, payees));
    }
    chain.push({
      height: 300,
      txid: 'co',
      inputs: [
        [KUCOIN, 1],
        ['t1kucoinCold', 1]
      ],
      outputs: [['t1someone', 1.9]]
    });
    writeChain(db, labels, chain);
    replaceSourceLabels(db, 'manual', []);
    clusterAddresses(db, labels);

    const list = new Map(
      Array.from({ length: 20 }, (_, n) => [`t1op${n}`, { nodes: 1, tiers: { CUMULUS: 1 } }])
    );
    const exchanges = new Map([
      [KUCOIN, 'Kucoin'],
      ['t1kucoinCold', 'Kucoin'],
      [COINEX, 'Coinex']
    ]);

    const report = precisionReport(db, list, exchanges);
    const byMethod = Object.fromEntries(report.methods.map((m) => [m.method, m]));

    // 20 operators on the list + 1 retired, judged on rewards alone: 20/21.
    expect(byMethod.node_rewards!.precision).toBeGreaterThanOrEqual(0.9);
    expect(byMethod.exchange_clustering!.precision).toBeGreaterThanOrEqual(0.9);
    expect(report.coverage.protocolPayouts).toBe(1);
    db.close();
  });
});
