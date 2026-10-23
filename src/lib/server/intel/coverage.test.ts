import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replaceSourceLabels, type LabelLookup } from '../labels.js';
import { createTestDb, silentLogger, type Db } from '../testkit.js';
import { classificationCoverage } from './coverage.js';
import { Relabeler } from './relabel.js';
import { labelBook, writeChain } from './testchain.js';

const KUCOIN = 't1kucoinHot';
const OPERATOR = 't1operator';

describe('classification coverage (#20)', () => {
  let db: Db;
  let labels: LabelLookup;

  beforeEach(() => {
    db = createTestDb();
    labels = labelBook(db, {
      exchanges: [{ name: 'Kucoin', addresses: [KUCOIN] }],
      foundation: { name: 'Flux Foundation', addresses: [] }
    });
    writeChain(db, labels, [
      // 300 deposited by a wallet about to be recognised as a node operator, 600 by strangers.
      { height: 10, txid: 'op', inputs: [[OPERATOR, 300]], outputs: [[KUCOIN, 300]] },
      { height: 11, txid: 'a', inputs: [['t1stranger', 600]], outputs: [[KUCOIN, 600]] },
      // A wallet-to-wallet transfer is not exchange volume at all.
      { height: 12, txid: 'p2p', inputs: [['t1stranger', 50]], outputs: [['t1friend', 50]] }
    ]);
  });

  afterEach(() => db.close());

  it('reports the share of exchange volume whose counterparty is classified', () => {
    expect(classificationCoverage(db)).toMatchObject({
      volume: 900,
      classified: 0,
      share: 0,
      byKind: { unknown: 900 }
    });
  });

  it('rises once a label is applied and the flows are re-derived', () => {
    replaceSourceLabels(db, 'node_list', [
      { address: OPERATOR, kind: 'node_operator', confidence: 1 }
    ]);
    labels.refresh('node list');
    const relabeler = new Relabeler(db, labels, silentLogger());
    while (relabeler.pending() > 0) relabeler.run();

    const after = classificationCoverage(db);
    expect(after).toMatchObject({ volume: 900, classified: 300, byKind: { node_operator: 300 } });
    expect(after.share).toBeCloseTo(1 / 3, 6);
  });

  it('is null, not zero, with no exchange volume to judge', () => {
    const empty = createTestDb();
    expect(classificationCoverage(empty)).toMatchObject({ volume: 0, share: null });
    empty.close();
  });
});
