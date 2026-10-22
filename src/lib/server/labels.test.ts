import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestConfig, createTestDb, silentLogger, type Db } from './testkit.js';
import { loadLabels, type LabelLookup } from './labels.js';
import { deriveFlows } from './ingest/derive.js';

const LABELS = {
  version: 1,
  exchanges: [
    { name: 'Coinex', addresses: ['t1coinex1', 't1coinex2'] },
    { name: 'Kucoin', addresses: ['t1kucoin1'] }
  ],
  foundation: { name: 'Flux Foundation', addresses: ['t1foundation1'] }
};

function writeLabels(contents: unknown): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-labels-')), 'labels.json');
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return file;
}

describe('loadLabels', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function load(labelsPath: string): LabelLookup {
    return loadLabels(db, createTestConfig({ LABELS_PATH: labelsPath }), silentLogger());
  }

  it('classifies exchange addresses', () => {
    const labels = load(writeLabels(LABELS));

    expect(labels.kindOf('t1coinex1')).toBe('exchange');
    expect(labels.kindOf('t1kucoin1')).toBe('exchange');
    expect(labels.nameOf('t1coinex1')).toBe('Coinex');
  });

  it('classifies Foundation addresses', () => {
    const labels = load(writeLabels(LABELS));

    expect(labels.kindOf('t1foundation1')).toBe('foundation');
    expect(labels.nameOf('t1foundation1')).toBe('Flux Foundation');
  });

  it('reports an unlabelled address as unknown', () => {
    const labels = load(writeLabels(LABELS));

    expect(labels.kindOf('t1random')).toBe('unknown');
    expect(labels.nameOf('t1random')).toBeNull();
  });

  it('writes the labels into address_labels', () => {
    load(writeLabels(LABELS));

    const rows = db
      .prepare<[], { kind: string; count: number }>(
        `SELECT kind, COUNT(*) AS count FROM address_labels GROUP BY kind ORDER BY kind`
      )
      .all();

    expect(rows).toEqual([
      { kind: 'exchange', count: 3 },
      { kind: 'foundation', count: 1 }
    ]);
  });

  it('reports counts for the status endpoint', () => {
    const labels = load(writeLabels(LABELS));

    expect(labels.stats()).toMatchObject({ exchanges: 3, foundation: 1, total: 4 });
  });

  it('degrades to no labels when the file is missing, without throwing', () => {
    // Classification must never be the reason the service fails to start.
    const labels = load(path.join(os.tmpdir(), 'definitely-not-here.json'));

    expect(labels.kindOf('t1coinex1')).toBe('unknown');
    expect(labels.stats()).toMatchObject({ exchanges: 0, foundation: 0, total: 0 });
  });

  it('degrades to no labels when the file is malformed', () => {
    const labels = load(writeLabels('{ not json'));

    expect(labels.stats().total).toBe(0);
  });

  it('handles a file with only exchanges', () => {
    const labels = load(writeLabels({ exchanges: [{ name: 'GateIO', addresses: ['t1gate'] }] }));

    expect(labels.kindOf('t1gate')).toBe('exchange');
    expect(labels.kindOf('t1foundation1')).toBe('unknown');
  });

  it('reloads and replaces the label set', () => {
    const file = writeLabels(LABELS);
    const labels = load(file);

    expect(labels.kindOf('t1kucoin1')).toBe('exchange');

    fs.writeFileSync(
      file,
      JSON.stringify({ exchanges: [{ name: 'NonKYC', addresses: ['t1nonkyc'] }] })
    );
    labels.reload();

    // The removed address must stop being classified, or a corrected label file would
    // never take effect without a restart.
    expect(labels.kindOf('t1kucoin1')).toBe('unknown');
    expect(labels.kindOf('t1nonkyc')).toBe('exchange');
  });

  it('reloads idempotently without duplicating rows', () => {
    const labels = load(writeLabels(LABELS));

    labels.reload();
    labels.reload();

    const count = db
      .prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM address_labels`)
      .get()!.count;

    expect(count).toBe(4);
  });

  it('does not overwrite a manual label with a config one, because source is part of the key', () => {
    const labels = load(writeLabels(LABELS));

    db.prepare(
      `INSERT INTO address_labels (address, kind, name, source, confidence)
       VALUES ('t1coinex1', 'exchange', 'Coinex (manual)', 'manual', 1)`
    ).run();

    labels.reload();

    const rows = db
      .prepare<[], { source: string; name: string }>(
        `SELECT source, name FROM address_labels WHERE address = 't1coinex1' ORDER BY source`
      )
      .all();

    expect(rows).toEqual(
      expect.arrayContaining([
        { source: 'config', name: 'Coinex' },
        { source: 'manual', name: 'Coinex (manual)' }
      ])
    );
  });

  it('exposes entries keyed by address for flow derivation', () => {
    const labels = load(writeLabels(LABELS));

    expect(labels.entries().get('t1kucoin1')).toEqual({ kind: 'exchange', name: 'Kucoin' });
  });
});

describe('the shipped config/labels.json', () => {
  // Issue #77: a further Flux team address, labelled the way the other 17 are.
  const TEAM = 't1Mzja9iJcEYeW5B4m4s1tJG8M42odFZ16A';
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function shipped(): LabelLookup {
    return loadLabels(db, createTestConfig(), silentLogger());
  }

  it('labels t1Mzja9iJcEYeW5B4m4s1tJG8M42odFZ16A as the Flux Foundation (#77)', () => {
    const labels = shipped();

    expect(labels.kindOf(TEAM)).toBe('foundation');
    expect(labels.nameOf(TEAM)).toBe('Flux Foundation');
  });

  it('flags transfers from and to it as Foundation flows (#77)', () => {
    const labels = shipped();
    const SATS = 100_000_000;
    const transfer = (from: string, to: string) =>
      deriveFlows(
        {
          txid: `tx-${from}`,
          kind: 'transfer',
          inputs: [{ address: from, sat: 10 * SATS, vout: 0 }],
          outputs: [{ n: 0, address: to, sat: 10 * SATS - 1_000, nulldata: false }],
          complete: true
        },
        1_000,
        1_756_000_000,
        labels
      );

    const [sent] = transfer(TEAM, 't1someone');
    expect(sent).toMatchObject({ fromKind: 'foundation', toKind: 'unknown', flowType: 'p2p' });

    const [received] = transfer('t1someone', TEAM);
    expect(received).toMatchObject({ fromKind: 'unknown', toKind: 'foundation', flowType: 'p2p' });
  });

  it('keeps src/lib/data/exchanges.json in step with it', () => {
    // Noxide copies its label list from src/lib/data/exchanges.json, so a Foundation
    // address added to only one of the two files would go missing there.
    const read = (file: string) =>
      JSON.parse(fs.readFileSync(path.join(process.cwd(), file), 'utf8')) as {
        foundation: { addresses: string[] };
      };
    const config = read('config/labels.json').foundation.addresses;
    const data = read('src/lib/data/exchanges.json').foundation.addresses;

    expect(data).toContain(TEAM);
    expect([...data].sort()).toEqual([...config].sort());
  });
});
