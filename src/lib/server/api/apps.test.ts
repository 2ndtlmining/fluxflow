import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type Db } from '../testkit.js';
import type { LabelLookup } from '../labels.js';
import { labelBook, writeChain, type SimpleTx } from '../intel/testchain.js';
import { traceFoundation } from '../intel/destinations.js';
import { appPayments, walletCounterparties } from './apps.js';

const FOUND = 't1found1';
const KUCOIN = 't1kucoinHot';
const HOSTING = 't3appHosting';
const TREASURY = 't3treasury';
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

/**
 * The live shape that prompted this: the Foundation funds a wallet that pays app fees in
 * many small payments and passes money on to a second payer; a retail wallet pays from an
 * exchange withdrawal; the hosting address sweeps to a treasury.
 */
const CHAIN: SimpleTx[] = [
  pay(10, 'wage', FOUND, 1_000, [['t1payerA', 1_000]]),
  pay(11, 'withdraw', KUCOIN, 100, [['t1retail', 100]]),
  pay(20, 'a1', 't1payerA', 100, [[HOSTING, 100]]),
  pay(21, 'a2', 't1payerA', 50, [[HOSTING, 50]]),
  pay(22, 'pass', 't1payerA', 400, [['t1payerB', 400]]),
  pay(30, 'b1', 't1payerB', 300, [[HOSTING, 300]]),
  pay(31, 'r1', 't1retail', 50, [[HOSTING, 50]]),
  pay(40, 'sweep', HOSTING, 500, [[TREASURY, 500]])
];

describe('app payments', () => {
  let db: Db;
  let labels: LabelLookup;

  beforeEach(() => {
    db = createTestDb();
    labels = labelBook(db, LABELS);
    writeChain(db, labels, CHAIN);
  });

  afterEach(() => db.close());

  it('labels the hosting address from the config file and keeps payments wallet-to-wallet', () => {
    expect(labels.kindOf(HOSTING)).toBe('app_hosting');
    expect(labels.nameOf(HOSTING)).toBe('Flux App Hosting');
    expect(labels.stats().appHosting).toBe(1);

    const rows = db
      .prepare(`SELECT flow_type AS type, to_kind AS kind FROM flows WHERE to_address = ?`)
      .all(HOSTING);
    expect(rows).toHaveLength(4);
    expect(rows).toEqual(expect.arrayContaining([{ type: 'p2p', kind: 'app_hosting' }]));
    expect(new Set(rows.map((row) => (row as { type: string }).type))).toEqual(new Set(['p2p']));
  });

  it('totals the payments, the payers and where the hosting address sent the money', () => {
    const result = appPayments(db, labels, ALL);

    expect(result).toMatchObject({
      hosting: [{ address: HOSTING, name: 'Flux App Hosting' }],
      total: 500,
      count: 4,
      payers: 3,
      byPayerKind: { unknown: 500 }
    });
    expect(result.topPayers.map((payer) => [payer.address, payer.total, payer.count])).toEqual([
      ['t1payerB', 300, 1],
      ['t1payerA', 150, 2],
      ['t1retail', 50, 1]
    ]);
    expect(result.series.reduce((sum, day) => sum + day.total, 0)).toBe(500);
    expect(result.outflows).toMatchObject({
      total: 500,
      recipients: [{ address: TREASURY, total: 500, share: 1 }]
    });
  });

  it('traces how each payer was funded, two hops up', () => {
    const payers = new Map(appPayments(db, labels, ALL).topPayers.map((p) => [p.address, p]));

    // Directly from the Foundation.
    expect(payers.get('t1payerA')!.fundedBy).toEqual({
      received: 1_000,
      mix: { foundation: 1_000 }
    });
    // From an unlabelled wallet, which was itself Foundation-funded: followed one hop more.
    expect(payers.get('t1payerB')!.fundedBy).toEqual({ received: 400, mix: { foundation: 400 } });
    expect(payers.get('t1payerB')!.topFunders).toMatchObject([
      { address: 't1payerA', kind: 'unknown', total: 400 }
    ]);
    expect(payers.get('t1retail')!.fundedBy).toEqual({ received: 100, mix: { exchange: 100 } });
  });

  it('weights the funding mix by what each payer spent on apps', () => {
    const { fundingOfPayments } = appPayments(db, labels, ALL);
    // 450 of the 500 FLUX paid traces to the Foundation, 50 to an exchange.
    expect(fundingOfPayments.foundation).toBeCloseTo(0.9, 9);
    expect(fundingOfPayments.exchange).toBeCloseTo(0.1, 9);
  });

  it('counts only the window, and nothing at all without a hosting label', () => {
    expect(appPayments(db, labels, { fromHeight: 25, toHeight: 35 })).toMatchObject({
      total: 350,
      payers: 2
    });

    const bare = labelBook(db, { exchanges: [], foundation: LABELS.foundation });
    expect(appPayments(db, bare, ALL)).toMatchObject({ hosting: [], total: 0, topPayers: [] });
  });

  it('counts Foundation money that ends up paying for apps as spent on apps', () => {
    const result = traceFoundation(db, labels, { fromTime: 0, toTime: 2e9 });
    // 150 paid by payerA directly, 300 via payerB; 450 still held across the two.
    expect(result.apps).toBeCloseTo(450, 6);
    expect(result.recipients[0]).toMatchObject({ address: 't1payerA', received: 1_000 });
    expect(result.recipients[0]!.apps).toBeCloseTo(450, 6);
  });
});

describe('wallet counterparties', () => {
  let db: Db;
  let labels: LabelLookup;

  beforeEach(() => {
    db = createTestDb();
    labels = labelBook(db, LABELS);
    writeChain(db, labels, CHAIN);
  });

  afterEach(() => db.close());

  it('lists the largest senders and recipients with their labels', () => {
    const result = walletCounterparties(db, labels, 't1payerA');

    expect(result.incoming).toMatchObject({
      total: 1_000,
      count: 1,
      distinct: 1,
      parties: [{ address: FOUND, kind: 'foundation', name: 'Flux Foundation', share: 1 }]
    });
    expect(result.outgoing).toMatchObject({ total: 550, count: 3, distinct: 2 });
    expect(
      result.outgoing.parties.map((party) => [party.address, party.total, party.count])
    ).toEqual([
      ['t1payerB', 400, 1],
      [HOSTING, 150, 2]
    ]);
    expect(result.outgoing.parties[1]).toMatchObject({ kind: 'app_hosting' });
  });

  it('names the first funder and what the wallet paid for apps', () => {
    expect(walletCounterparties(db, labels, 't1payerB')).toMatchObject({
      firstFunder: { address: 't1payerA', txid: 'pass', amount: 400 },
      appPayments: { total: 300, count: 1 }
    });
    expect(walletCounterparties(db, labels, 't1nobody')).toMatchObject({
      firstFunder: null,
      incoming: { total: 0, count: 0, parties: [] },
      appPayments: { total: 0, count: 0 }
    });
  });

  it('caps the list', () => {
    const result = walletCounterparties(db, labels, HOSTING, { limit: 2 });
    expect(result.incoming.parties).toHaveLength(2);
    expect(result.incoming.distinct).toBe(3);
  });
});

it('counts app payments as soon as the hosting label exists, before any re-derivation', () => {
  // The live deploy: flows synced while the hosting address was still unlabelled.
  const db = createTestDb();
  writeChain(
    db,
    labelBook(db, { exchanges: LABELS.exchanges, foundation: LABELS.foundation }),
    CHAIN
  );
  const labels = labelBook(db, LABELS);

  expect(walletCounterparties(db, labels, 't1payerA').appPayments).toEqual({
    total: 150,
    count: 2
  });
  expect(appPayments(db, labels, ALL)).toMatchObject({ total: 500, payers: 3 });
  db.close();
});
