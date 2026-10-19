import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type Db } from '../testkit.js';
import type { LabelLookup } from '../labels.js';
import { EntityIndex } from '../intel/entities.js';
import { detectHops } from '../intel/hops.js';
import { blockTime, labelBook, writeChain, type SimpleTx } from '../intel/testchain.js';
import { TXID_PATTERN, txDetail } from './tx.js';

const GATEIO = 't1gateioHot';
const KUCOIN = 't1kucoinHot';
const COINEX = 't1coinexHot';
const FOUND_A = 't1foundA';
const FOUND_B = 't1foundB';
const LABELS = {
  exchanges: [
    { name: 'Gate.io', addresses: [GATEIO] },
    { name: 'Kucoin', addresses: [KUCOIN] },
    { name: 'Coinex', addresses: [COINEX] }
  ],
  foundation: { name: 'Flux Foundation', addresses: [FOUND_A, FOUND_B] }
};

/** Three deposit addresses swept into Gate.io in one transaction, 1 FLUX fee. */
const SWEEP: SimpleTx = {
  height: 10,
  txid: 'sweep',
  inputs: [
    ['t1depositA', 6_000],
    ['t1depositB', 3_000],
    ['t1depositC', 1_001]
  ],
  outputs: [[GATEIO, 10_000]]
};

describe('transaction detail', () => {
  let db: Db;
  let labels: LabelLookup;
  const detail = (txid: string) => txDetail(db, labels, EntityIndex.build(db, labels), txid);

  beforeEach(() => {
    db = createTestDb();
    labels = labelBook(db, LABELS);
  });

  afterEach(() => db.close());

  it('credits each funder of a sweep its proportional share (the #66 acceptance case)', () => {
    writeChain(db, labels, [SWEEP]);
    const tx = detail('sweep')!;

    expect(tx).toMatchObject({ height: 10, time: blockTime(10), totalIn: 10_001, fee: 1 });
    expect(tx.parties.map((party) => [party.address, party.role])).toEqual([
      ['t1depositA', 'funder'],
      ['t1depositB', 'funder'],
      ['t1depositC', 'funder'],
      [GATEIO, 'recipient']
    ]);
    expect(tx.parties[0]!.share).toBeCloseTo(6_000 / 10_001, 9);
    expect(tx.parties[3]).toMatchObject({ kind: 'exchange', name: 'Gate.io', net: 10_000 });

    // One selling row per funder, carrying that funder's share of the output.
    expect(tx.flows.map((flow) => [flow.fromAddress, flow.flowType, flow.exchange])).toEqual([
      ['t1depositA', 'selling', 'Gate.io'],
      ['t1depositB', 'selling', 'Gate.io'],
      ['t1depositC', 'selling', 'Gate.io']
    ]);
    expect(tx.flows.reduce((sum, flow) => sum + flow.amount, 0)).toBeCloseTo(10_000, 8);
    expect(tx.flows[0]!.share).toBeCloseTo(6_000 / 10_001, 6);
    expect(tx.flows.every((flow) => !flow.stale)).toBe(true);
    expect(tx.note).toBeNull();
  });

  it('accepts an upper-case txid and returns null for an unknown one', () => {
    writeChain(db, labels, [{ ...SWEEP, txid: 'ab'.repeat(32) }]);
    expect(detail('AB'.repeat(32))?.txid).toBe('ab'.repeat(32));
    expect(detail('cd'.repeat(32))).toBeNull();
    expect(TXID_PATTERN.test('AB'.repeat(32))).toBe(true);
    expect(TXID_PATTERN.test('sweep')).toBe(false);
  });

  it('shows change as its own role and leaves it out of the funder shares', () => {
    writeChain(db, labels, [
      {
        height: 5,
        txid: 'pay',
        inputs: [['t1payer', 100]],
        outputs: [
          ['t1shop', 30],
          ['t1payer', 69.9]
        ]
      }
    ]);
    const tx = detail('pay')!;

    expect(tx.parties.find((party) => party.address === 't1payer')).toMatchObject({
      role: 'funder',
      sent: 100,
      received: 69.9,
      share: 1
    });
    expect(tx.parties.find((party) => party.address === 't1payer')!.net).toBeCloseTo(-30.1, 8);
    expect(tx.flows).toHaveLength(1);
    expect(tx.flows[0]).toMatchObject({ toAddress: 't1shop', flowType: 'p2p', share: 1 });
  });

  it('explains why a transfer produced no flows', () => {
    writeChain(db, labels, [
      { height: 1, txid: 'self', inputs: [['t1me', 50]], outputs: [['t1me', 50]] },
      { height: 2, txid: 'internal', inputs: [[FOUND_A, 500]], outputs: [[FOUND_B, 499.9]] }
    ]);

    expect(detail('self')).toMatchObject({ flows: [], note: expect.stringContaining('self') });
    expect(detail('self')!.parties[0]!.role).toBe('change');
    expect(detail('internal')).toMatchObject({
      flows: [],
      note: expect.stringContaining('Foundation')
    });
  });

  it('marks a flow stale when a side has been relabelled since it was derived', () => {
    writeChain(db, labels, [
      { height: 3, txid: 'dep', inputs: [['t1seller', 40]], outputs: [['t1newHot', 39.9]] }
    ]);
    expect(detail('dep')!.flows[0]).toMatchObject({ toKind: 'unknown', stale: false });

    labels = labelBook(db, {
      ...LABELS,
      exchanges: [...LABELS.exchanges, { name: 'Bitmart', addresses: ['t1newHot'] }]
    });
    const tx = detail('dep')!;

    // The row still says what it was classified as; the party says what it is now.
    expect(tx.flows[0]).toMatchObject({ flowType: 'p2p', toKind: 'unknown', stale: true });
    expect(tx.parties.find((party) => party.address === 't1newHot')).toMatchObject({
      kind: 'exchange',
      name: 'Bitmart',
      label: expect.objectContaining({ source: 'config', level: 'confirmed' })
    });
  });

  it('lists the hop legs a transaction belongs to', () => {
    writeChain(db, labels, [
      { height: 100, txid: 'w', inputs: [[COINEX, 7_866.1]], outputs: [['t1arb', 7_866]] },
      { height: 113, txid: 'd', inputs: [['t1arb', 7_860.1]], outputs: [[KUCOIN, 7_860]] }
    ]);
    detectHops(db, 0);

    expect(detail('w')!.hops).toEqual([
      {
        leg: 'buy',
        address: 't1arb',
        fromExchange: 'Coinex',
        toExchange: 'Kucoin',
        withdrawn: 7_866,
        deposited: 7_860,
        otherTxid: 'd',
        blocksApart: 13
      }
    ]);
    expect(detail('d')!.hops).toMatchObject([{ leg: 'sell', otherTxid: 'w' }]);
  });
});
