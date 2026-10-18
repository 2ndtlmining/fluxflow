import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type Db } from '../testkit.js';
import type { LabelLookup } from '../labels.js';
import { labelBook, writeChain, type SimpleTx } from '../intel/testchain.js';
import { GRAPH_LIMITS, flowGraph } from './graph.js';

const FOUND = 't1found1';
const KUCOIN = 't1kucoinHot';
const HOSTING = 't3appHosting';
const LABELS = {
  exchanges: [{ name: 'Kucoin', addresses: [KUCOIN] }],
  foundation: { name: 'Flux Foundation', addresses: [FOUND] },
  appHosting: [{ name: 'Flux App Hosting', addresses: [HOSTING] }]
};
const ALL = { fromHeight: 0, toHeight: 1_000_000 };

const pay = (
  height: number,
  txid: string,
  from: string,
  amount: number,
  to: readonly (readonly [string, number])[]
): SimpleTx => ({ height, txid, inputs: [[from, amount]], outputs: to });

/** The shape #63 asks to see: Foundation -> processor -> payer -> hosting -> treasury. */
const CHAIN: SimpleTx[] = [
  pay(10, 'fund', FOUND, 1_000, [['t1processor', 1_000]]),
  pay(11, 'p1', 't1processor', 300, [['t1payer', 300]]),
  pay(12, 'p2', 't1processor', 100, [['t1payer', 100]]),
  pay(13, 'k1', KUCOIN, 50, [['t1payer', 50]]),
  pay(20, 'fee', 't1payer', 400, [[HOSTING, 400]]),
  pay(30, 'sweep', HOSTING, 400, [['t3treasury', 400]]),
  pay(40, 'dep', 't3treasury', 100, [[KUCOIN, 100]])
];

describe('fund-flow graph', () => {
  let db: Db;
  let labels: LabelLookup;

  beforeEach(() => {
    db = createTestDb();
    labels = labelBook(db, LABELS);
    writeChain(db, labels, CHAIN);
  });

  afterEach(() => db.close());

  it("returns a wallet's senders and recipients as aggregated edges", () => {
    const graph = flowGraph(db, labels, 't1payer', ALL);

    expect(graph.nodes.map((node) => node.address).sort()).toEqual(
      ['t1payer', 't1processor', KUCOIN, HOSTING].sort()
    );
    expect(graph.nodes.find((node) => node.address === HOSTING)).toEqual({
      address: HOSTING,
      kind: 'app_hosting',
      name: 'Flux App Hosting'
    });
    // Two transfers from the processor, one edge.
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ from: 't1processor', to: 't1payer', total: 400, count: 2 })
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ from: 't1payer', to: HOSTING, total: 400, count: 1 })
    );
    expect(graph.expanded['t1payer']).toEqual({
      in: { more: 0, sampled: false },
      out: { more: 0, sampled: false }
    });
    expect(graph.truncated).toBe(false);
  });

  it('reaches the whole chain from the hosting address in two expansions', () => {
    const start = flowGraph(db, labels, HOSTING, ALL);
    const back = flowGraph(db, labels, 't1payer', ALL, { direction: 'in' });
    const back2 = flowGraph(db, labels, 't1processor', ALL, { direction: 'in' });

    const edges = new Set(
      [start, back, back2].flatMap((g) => g.edges.map((edge) => `${edge.from}>${edge.to}`))
    );
    for (const hop of [
      `${FOUND}>t1processor`,
      't1processor>t1payer',
      `t1payer>${HOSTING}`,
      `${HOSTING}>t3treasury`
    ]) {
      expect(edges).toContain(hop);
    }
  });

  it('follows unlabelled wallets to the given depth and stops at labelled ones', () => {
    const graph = flowGraph(db, labels, HOSTING, ALL, { direction: 'in', depth: 3 });
    expect(graph.nodes.map((node) => node.address).sort()).toEqual(
      [HOSTING, 't1payer', 't1processor', KUCOIN, FOUND].sort()
    );
    // Kucoin is labelled: never expanded, however busy.
    expect(graph.expanded[KUCOIN]).toBeUndefined();

    const forward = flowGraph(db, labels, HOSTING, ALL, { direction: 'out', depth: 2 });
    expect(forward.edges).toContainEqual(
      expect.objectContaining({ from: 't3treasury', to: KUCOIN, total: 100 })
    );
  });

  it('leaves out small edges and counts what it left out', () => {
    const graph = flowGraph(db, labels, 't1payer', ALL, { direction: 'in', minAmount: 100 });
    expect(graph.nodes.map((node) => node.address).sort()).toEqual(['t1payer', 't1processor']);
    expect(graph.expanded['t1payer']).toEqual({ in: { more: 1, sampled: false } });

    const one = flowGraph(db, labels, 't1payer', ALL, { direction: 'in', fanout: 1 });
    expect(one.edges).toHaveLength(1);
    expect(one.expanded['t1payer']!.in!.more).toBe(1);
  });

  it('counts only the window', () => {
    const graph = flowGraph(db, labels, 't1payer', { fromHeight: 12, toHeight: 20 });
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ from: 't1processor', to: 't1payer', total: 100, count: 1 })
    );
  });

  it('caps the fan-out and counts the rest', () => {
    const many: SimpleTx[] = Array.from({ length: GRAPH_LIMITS.nodes + 10 }, (_, i) =>
      pay(100 + i, `fan${i}`, `t1src${i}`, 1, [['t1sink', 1]])
    );
    writeChain(db, labels, many);
    const graph = flowGraph(db, labels, 't1sink', ALL, { fanout: 50 });
    expect(graph.nodes.length).toBeLessThanOrEqual(GRAPH_LIMITS.nodes);
    expect(graph.expanded['t1sink']!.in!.more).toBe(GRAPH_LIMITS.nodes + 10 - 50);
  });
});
