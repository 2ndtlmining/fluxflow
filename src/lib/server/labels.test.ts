import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestConfig, createTestDb, silentLogger, type Db } from './testkit.js';
import { loadLabels, replaceSourceLabels, type LabelLookup } from './labels.js';
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
  // Flux team addresses added after the first 17, labelled the way those are: #77, and
  // the two team wallets that pay for apps and hold fiat proceeds from #62.
  const TEAM = [
    ['t1Mzja9iJcEYeW5B4m4s1tJG8M42odFZ16A', '#77'],
    ['t1gjUUxBpBeVC1sWwAFrtSsVCbSaFdZx8UY', '#62'],
    ['t1XktDZ9Z1QiefMYE5nMFohe8VG2c2BD5A5', '#62'],
    // Owner-confirmed Flux team wallets (stache.beer: Foundation nodes, InFlux-run nodes and
    // team node wallets). Most are also on the node list; the config label outranks it.
    ['t3gCppaQdKhCViBA2mtYMphmJmtKY4BbR7d', 'team list'],
    ['t3ZccrRNem6oTcN8kcPmgCh1HopR6zxH1Mq', 'team list'],
    ['t1TDCLWnXBtoYJy7BuUPuhhj9xSz7AE4hEw', 'team list'],
    ['t3TRUNKvgywghL1vU5bsGQqs9eVC17XcUnV', 'team list'],
    ['t1TRUNKQMx1DVzym4d2Ay5E1dudEcHiyk9C', 'team list'],
    ['t3RF1j68kXqDTWm99MhPkimCNC8EqomLKTm', 'team list'],
    ['t1LuQpTx4QrrTKxFxwzX7QAL4icKpryk9pD', 'team list'],
    ['t1LJjkp7mzFspW9KcAePWdBARdURT4DMXXW', 'team list'],
    ['t3PbAVTkLgjHUV4zsFiP1LNcPJvFRv18khh', 'team list'],
    ['t1JdJNvywTpsnNavx9k97qqegSVwBPkhr9J', 'team list'],
    ['t1dQmkPAqUjijz4gy6AuRgD1yHxX4REaNEZ', 'team list'],
    ['t1gAHNoPHizdAcup541sgpxqXSQH5KubiPy', 'team list'],
    ['t1KhWQXoLsstvzB8Ly58V8fy4Mbybihs78w', 'team list'],
    ['t1MxVfa7uBJHgE3xrnuaR3GxFpKT9zJSob3', 'team list'],
    ['t1Xizun9KfWLaJdgt5L62xhh9rmjbUR6LWn', 'team list'],
    ['t1UNoGzKKHsS9aUMaFKsPyHaSDh9SF43q6t', 'team list'],
    ['t3fAayHBRbMyuAM5HyEnpwzFbPgFezXicMh', 'team list'],
    ['t1M6fBoxfTnCQrSyQVQFq39B2YXeashcbGR', 'team list'],
    // InFlux operations wallet: app fees and Foundation money in, round amounts out (#62).
    ['t3dLRNHYXsRKW4cSec98YDC9G5zjqDN7NRu', '#62']
  ] as const;
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

  it.each(TEAM)('labels %s as the Flux Foundation (%s)', (address) => {
    const labels = shipped();

    expect(labels.kindOf(address)).toBe('foundation');
    expect(labels.nameOf(address)).toBe('Flux Foundation');
  });

  it.each(TEAM)('flags transfers from and to %s as Foundation flows (%s)', (address) => {
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

    const [sent] = transfer(address, 't1someone');
    expect(sent).toMatchObject({ fromKind: 'foundation', toKind: 'unknown', flowType: 'p2p' });

    const [received] = transfer('t1someone', address);
    expect(received).toMatchObject({ fromKind: 'unknown', toKind: 'foundation', flowType: 'p2p' });
  });

  it('outranks the node list: a team wallet that runs nodes still counts as the Foundation', () => {
    const NODES = 't3gCppaQdKhCViBA2mtYMphmJmtKY4BbR7d';
    const labels = shipped();
    replaceSourceLabels(db, 'node_list', [
      { address: NODES, kind: 'node_operator', confidence: 1 }
    ]);
    labels.refresh('node list');

    expect(labels.kindOf(NODES)).toBe('foundation');
    expect(
      labels
        .allLabels(NODES)
        .map((label) => label.source)
        .sort()
    ).toEqual(['config', 'node_list']);
  });

  it('leaves Titan nodes to the node list: users deposit there to host nodes', () => {
    // Flux controls t3c4Efx…, but the FLUX in it is users' node collateral, not the team's.
    const TITAN = 't3c4EfxLoXXSRZCRnPRF3RpjPi9mBzF5yoJ';
    const labels = shipped();
    expect(labels.kindOf(TITAN)).not.toBe('foundation');

    replaceSourceLabels(db, 'node_list', [
      { address: TITAN, kind: 'node_operator', confidence: 1 }
    ]);
    labels.refresh('node list');
    expect(labels.kindOf(TITAN)).toBe('node_operator');
  });

  it('keeps t1YvimnG… as GateIO, as the owner chose', () => {
    // stache.beer calls it an InFlux trading wallet; the owner kept the exchange label.
    expect(shipped().nameOf('t1YvimnGBmVA7xDiPnqwbKsvujmSJz4X5m2')).toBe('GateIO');
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

    for (const [address] of TEAM) expect(data).toContain(address);
    expect([...data].sort()).toEqual([...config].sort());
  });
});
