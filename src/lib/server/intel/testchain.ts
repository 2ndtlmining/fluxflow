/**
 * Test helpers for the intelligence modules: write a small chain through the real
 * derivation and writer, with a real label book backed by a temporary labels file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestConfig, silentLogger, SATS, type Db } from '../testkit.js';
import { loadLabels, type LabelLookup } from '../labels.js';
import { deriveBlock } from '../ingest/derive.js';
import { BlockWriter } from '../ingest/writer.js';
import type { NormalisedBlock, NormalisedTx } from '../ingest/datasource/types.js';

export const BASE_TIME = 1_756_000_800 - (1_756_000_800 % 86_400);

export interface SimpleTx {
  readonly height: number;
  readonly txid: string;
  readonly kind?: 'transfer' | 'coinbase';
  /** `[address, FLUX]` spent. */
  readonly inputs?: readonly (readonly [string, number])[];
  /** `[address, FLUX]` received. */
  readonly outputs: readonly (readonly [string, number])[];
}

export function blockTime(height: number): number {
  return BASE_TIME + height * 30;
}

export function writeLabelsFile(contents: unknown): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-intel-')), 'labels.json');
  fs.writeFileSync(file, JSON.stringify(contents));
  return file;
}

export function labelBook(
  db: Db,
  contents: unknown = { exchanges: [], foundation: { name: 'Flux Foundation', addresses: [] } }
): LabelLookup {
  return loadLabels(
    db,
    createTestConfig({ LABELS_PATH: writeLabelsFile(contents) }),
    silentLogger()
  );
}

/** Derive and write `txs` with the current labels; blocks are created for every height used. */
export function writeChain(db: Db, labels: LabelLookup, txs: readonly SimpleTx[]): void {
  const heights = [...new Set(txs.map((tx) => tx.height))].sort((a, b) => a - b);
  const writer = new BlockWriter(db);

  const blocks: NormalisedBlock[] = heights.map((height) => ({
    height,
    hash: `hash-${height}`,
    prevHash: `hash-${height - 1}`,
    time: blockTime(height),
    txCount: txs.filter((tx) => tx.height === height).length,
    transactions: txs
      .filter((tx) => tx.height === height)
      .map((tx): NormalisedTx => ({
        txid: tx.txid,
        kind: tx.kind ?? 'transfer',
        inputs:
          tx.kind === 'coinbase'
            ? [{ address: null, sat: 0, vout: -1 }]
            : (tx.inputs ?? []).map(([address, flux], vout) => ({
                address,
                sat: Math.round(flux * SATS),
                vout
              })),
        outputs: tx.outputs.map(([address, flux], n) => ({
          n,
          address,
          sat: Math.round(flux * SATS),
          nulldata: false
        })),
        complete: true
      }))
  }));

  writer.writeBatch(blocks.map((block) => deriveBlock(block, 'test', labels)));
}

export { rollupMismatches } from './consistency.js';
