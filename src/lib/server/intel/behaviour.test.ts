import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type Db } from '../testkit.js';
import type { LabelLookup } from '../labels.js';
import { labelBook, writeChain, type SimpleTx } from './testchain.js';
import { detectBehaviour, replaceBehaviourTags, tagsOf, type BehaviourTag } from './behaviour.js';

/** Blocks per day and per hour at 30 s a block. */
const DAY = 2_880;
const HOUR = 120;
const HOSTING = 't3appHosting';

const pay = (height: number, txid: string, from: string, amount: number, to: string): SimpleTx => ({
  height,
  txid,
  inputs: [[from, amount]],
  outputs: [[to, amount]]
});

function tagged(tags: readonly BehaviourTag[], tag: string): string[] {
  return tags
    .filter((row) => row.tag === tag)
    .map((row) => row.address)
    .sort();
}

describe('behaviour tags (#68)', () => {
  let db: Db;
  let labels: LabelLookup;

  beforeEach(() => {
    db = createTestDb();
    labels = labelBook(db, {
      exchanges: [],
      foundation: { name: 'Flux Foundation', addresses: [] },
      appHosting: [{ name: 'Flux App Hosting', addresses: [HOSTING] }]
    });
  });

  afterEach(() => db.close());

  describe('recurring payer', () => {
    it('tags many payments to one counterparty spread over many days', () => {
      // t1Mzja's shape: thousands of 0.02 FLUX app payments, a few larger ones.
      const chain: SimpleTx[] = [];
      for (let i = 0; i < 30; i++) {
        chain.push(
          pay(1_000 + i * (DAY / 2), `sub-${i}`, 't1subscriber', i % 5 === 0 ? 12 : 0.02, HOSTING)
        );
      }
      // Same count, all on one afternoon: a burst, not a habit.
      for (let i = 0; i < 30; i++) chain.push(pay(1_000 + i, `burst-${i}`, 't1burst', 1, HOSTING));
      writeChain(db, labels, chain);

      const tags = detectBehaviour(db);
      expect(tagged(tags, 'recurring_payer')).toEqual(['t1subscriber']);
      expect(tags.find((row) => row.tag === 'recurring_payer')!.evidence).toMatchObject({
        counterparty: HOSTING,
        payments: 30,
        days: 15,
        commonAmount: 0.02,
        commonShare: 0.8
      });
    });

    it('does not tag a wallet whose payments are spread over many counterparties', () => {
      const chain: SimpleTx[] = [];
      for (let i = 0; i < 30; i++)
        chain.push(pay(1_000 + i * DAY, `spread-${i}`, 't1spread', 5, `t1shop${i % 3}`));
      writeChain(db, labels, chain);

      expect(tagged(detectBehaviour(db), 'recurring_payer')).toEqual([]);
    });
  });

  describe('automated', () => {
    it('tags a wallet that sends around the clock', () => {
      const chain: SimpleTx[] = [];
      // 120 sends, one every 62.5 minutes: every hour of the day is covered, evenly.
      for (let i = 0; i < 120; i++)
        chain.push(pay(1_000 + i * 125, `bot-${i}`, 't1bot', 1, `t1to${i}`));
      // A person: as many sends, all between 08:00 and 20:00 UTC.
      for (let i = 0; i < 120; i++) {
        const day = Math.floor(i / 12);
        chain.push(
          pay(day * DAY + 8 * HOUR + (i % 12) * HOUR, `human-${i}`, 't1human', 1, `t1to${i}`)
        );
      }
      writeChain(db, labels, chain);

      const tags = detectBehaviour(db);
      expect(tagged(tags, 'automated')).toEqual(['t1bot']);
      expect(tags.find((row) => row.tag === 'automated')!.evidence).toMatchObject({
        sends: 120,
        activeHours: 24
      });
    });

    it('needs enough sends to judge', () => {
      const chain: SimpleTx[] = [];
      for (let i = 0; i < 48; i++)
        chain.push(pay(1_000 + i * HOUR, `few-${i}`, 't1few', 1, `t1to${i}`));
      writeChain(db, labels, chain);

      expect(tagged(detectBehaviour(db), 'automated')).toEqual([]);
    });
  });

  describe('collateral-sized amounts', () => {
    it('tags a wallet that repeatedly sends exactly a node collateral', () => {
      writeChain(db, labels, [
        pay(100, 'c1', 't1stander', 1_000, 't1node1'),
        pay(200, 'c2', 't1stander', 12_500, 't1node2'),
        pay(300, 'c3', 't1stander', 40_000, 't1node3'),
        pay(400, 'once', 't1once', 1_000, 't1node4'),
        pay(500, 'near1', 't1near', 1_000.5, 't1node5'),
        pay(600, 'near2', 't1near', 999, 't1node6')
      ]);

      const tags = detectBehaviour(db);
      expect(tagged(tags, 'collateral_amounts')).toEqual(['t1stander']);
      expect(tags.find((row) => row.tag === 'collateral_amounts')!.evidence).toMatchObject({
        sends: 3,
        byAmount: { '1000': 1, '12500': 1, '40000': 1 }
      });
    });
  });

  describe('dormant waking', () => {
    it('tags a large move after 90+ quiet days', () => {
      writeChain(db, labels, [
        pay(100, 'old', 't1funder', 5_000, 't1sleeper'),
        pay(100 + 91 * DAY, 'wake', 't1sleeper', 5_000, 't1somewhere'),
        // Quiet for 30 days only.
        pay(100, 'old2', 't1funder', 5_000, 't1napper'),
        pay(100 + 30 * DAY, 'wake2', 't1napper', 5_000, 't1somewhere'),
        // Quiet long enough, but a small move.
        pay(100, 'old3', 't1funder', 50, 't1small'),
        pay(100 + 91 * DAY, 'wake3', 't1small', 50, 't1somewhere')
      ]);

      const tags = detectBehaviour(db);
      expect(tagged(tags, 'dormant_waking')).toEqual(['t1sleeper']);
      expect(tags.find((row) => row.tag === 'dormant_waking')!.evidence).toMatchObject({
        txid: 'wake',
        amount: 5_000,
        quietDays: 91
      });
    });
  });

  describe('peel chain', () => {
    /** One hop: `from` spends `input`, pays `peel` away and sends the rest to fresh `change`. */
    const peel = (
      height: number,
      txid: string,
      from: string,
      input: number,
      peeled: number,
      change: string
    ): SimpleTx => ({
      height,
      txid,
      inputs: [[from, input]],
      outputs: [
        [`${txid}-payee`, peeled],
        [change, input - peeled]
      ]
    });

    it('tags every hop of a chain of four or more peels', () => {
      writeChain(db, labels, [
        peel(1_000, 'p1', 't1start', 10_000, 300, 't1c1'),
        peel(1_010, 'p2', 't1c1', 9_700, 250, 't1c2'),
        peel(1_020, 'p3', 't1c2', 9_450, 400, 't1c3'),
        peel(1_030, 'p4', 't1c3', 9_050, 100, 't1c4'),
        // Two hops only.
        peel(2_000, 'q1', 't1short', 5_000, 100, 't1d1'),
        peel(2_010, 'q2', 't1d1', 4_900, 100, 't1d2')
      ]);

      const tags = detectBehaviour(db);
      expect(tagged(tags, 'peel_chain')).toEqual(['t1c1', 't1c2', 't1c3', 't1start']);
      expect(tags.find((row) => row.address === 't1start')!.evidence).toMatchObject({
        hops: 4,
        start: 't1start',
        peeled: 1_050,
        firstTxid: 'p1',
        lastTxid: 'p4'
      });
    });

    it('breaks the chain when the change goes to an address that was used before', () => {
      writeChain(db, labels, [
        pay(10, 'earlier', 't1somebody', 1, 't1c2'),
        peel(1_000, 'p1', 't1start', 10_000, 300, 't1c1'),
        peel(1_010, 'p2', 't1c1', 9_700, 250, 't1c2'),
        peel(1_020, 'p3', 't1c2', 9_450, 400, 't1c3'),
        peel(1_030, 'p4', 't1c3', 9_050, 100, 't1c4')
      ]);

      expect(tagged(detectBehaviour(db), 'peel_chain')).toEqual([]);
    });

    it('breaks the chain when most of the money is paid away', () => {
      writeChain(db, labels, [
        peel(1_000, 'p1', 't1start', 10_000, 300, 't1c1'),
        peel(1_010, 'p2', 't1c1', 9_700, 6_000, 't1c2'),
        peel(1_020, 'p3', 't1c2', 3_700, 400, 't1c3'),
        peel(1_030, 'p4', 't1c3', 3_300, 100, 't1c4')
      ]);

      expect(tagged(detectBehaviour(db), 'peel_chain')).toEqual([]);
    });
  });

  describe('storage', () => {
    it('replaces the previous tags and reads them back per wallet', () => {
      const first: BehaviourTag[] = [
        { address: 't1a', tag: 'automated', evidence: { sends: 100 } },
        { address: 't1b', tag: 'automated', evidence: { sends: 200 } }
      ];
      expect(replaceBehaviourTags(db, first)).toBe(true);
      expect(replaceBehaviourTags(db, first)).toBe(false);

      replaceBehaviourTags(db, [
        { address: 't1b', tag: 'recurring_payer', evidence: { payments: 20 } }
      ]);
      expect(tagsOf(db, 't1a')).toEqual([]);
      expect(tagsOf(db, 't1b')).toEqual([
        expect.objectContaining({ tag: 'recurring_payer', evidence: { payments: 20 } })
      ]);
    });
  });
});
