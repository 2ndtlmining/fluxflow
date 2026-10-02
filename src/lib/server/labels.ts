/**
 * Address labels: exchanges, Foundation wallets and anything else we can name.
 *
 * Labels are **not** chain facts and never live in `blocks`/`tx_deltas`. They are rows in
 * `address_labels` that can be corrected at any time, with flows re-derived afterwards.
 * That separation is what fixes #16 (`INSERT OR REPLACE` wiping enhancement results) and
 * #18 (classification frozen at sync time) by construction.
 *
 * The seed file lives at `LABELS_PATH`, which is mounted into the container so addresses
 * can be added without rebuilding the image.
 */

import fs from 'node:fs';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { Db } from './db/database.js';
import { serialiseError } from './logger.js';
import type { AddressKind } from './ingest/datasource/types.js';

/** One entry in `config/labels.json`: a named party and the addresses it controls. */
interface LabelEntry {
  name: string;
  kind?: string;
  confidence?: number;
  source?: string;
  addresses: string[];
}

/** The on-disk shape of `config/labels.json`. */
interface LabelsFile {
  version?: number;
  updatedAt?: string;
  exchanges?: LabelEntry[];
  foundation?: LabelEntry;
}

export interface LabelLookup {
  /** `null` for an address we cannot name. */
  kindOf(address: string): AddressKind;
  nameOf(address: string): string | null;
  /** Replace the whole label set with the contents of `config.labelsPath`. */
  reload(): LabelStats;
  stats(): LabelStats;
  /** Labels keyed by address, for the flow derivation step. */
  entries(): ReadonlyMap<string, { kind: AddressKind; name: string | null }>;
}

export interface LabelStats {
  readonly exchanges: number;
  readonly foundation: number;
  readonly total: number;
  readonly source: string;
  readonly loadedAt: number;
}

const upsert = `
  INSERT INTO address_labels (address, kind, name, source, confidence, updated_at)
  VALUES (?, ?, ?, ?, ?, CAST(strftime('%s','now') AS INTEGER))
  ON CONFLICT (address, kind, source) DO UPDATE SET
    name = excluded.name,
    confidence = excluded.confidence,
    updated_at = excluded.updated_at
`;

/**
 * Load labels from disk and mirror them into `address_labels`.
 *
 * Rows from the config file are tagged `source = 'config'`; anything a clustering or
 * heuristic pass adds later uses its own `source`, so a hand-maintained label is never
 * overwritten by a guess.
 */
export function loadLabels(db: Db, config: Config, log: Logger): LabelLookup {
  let byAddress = new Map<string, { kind: AddressKind; name: string | null }>();
  let stats: LabelStats = {
    exchanges: 0,
    foundation: 0,
    total: 0,
    source: config.labelsPath,
    loadedAt: 0
  };

  const reload = (): LabelStats => {
    let parsed: LabelsFile = {};

    try {
      parsed = JSON.parse(fs.readFileSync(config.labelsPath, 'utf8')) as LabelsFile;
    } catch (error) {
      // Missing or malformed labels degrade classification, they must not stop the
      // service: flows still record the addresses, just as `unknown`.
      log.warn(
        { path: config.labelsPath, ...serialiseError(error) },
        'could not read the labels file, continuing without labels'
      );
      byAddress = new Map();
      stats = {
        exchanges: 0,
        foundation: 0,
        total: 0,
        source: config.labelsPath,
        loadedAt: Date.now()
      };
      return stats;
    }

    const next = new Map<string, { kind: AddressKind; name: string | null }>();
    let exchanges = 0;
    let foundation = 0;

    const write = db.transaction(() => {
      const insert = db.prepare(upsert);

      const add = (
        addresses: string[] | undefined,
        kind: AddressKind,
        name: string,
        confidence: number,
        source: string
      ): void => {
        for (const address of addresses ?? []) {
          next.set(address, { kind, name });
          insert.run(address, kind, name, source, confidence);
        }
      };

      for (const exchange of parsed.exchanges ?? []) {
        add(
          exchange.addresses,
          'exchange',
          exchange.name,
          exchange.confidence ?? 1,
          exchange.source ?? 'config'
        );
        exchanges += exchange.addresses.length;
      }

      if (parsed.foundation) {
        add(
          parsed.foundation.addresses,
          'foundation',
          parsed.foundation.name,
          parsed.foundation.confidence ?? 1,
          parsed.foundation.source ?? 'config'
        );
        foundation = parsed.foundation.addresses.length;
      }
    });

    write();

    byAddress = next;
    stats = {
      exchanges,
      foundation,
      total: next.size,
      source: config.labelsPath,
      loadedAt: Date.now()
    };

    return stats;
  };

  reload();

  return {
    kindOf(address: string): AddressKind {
      return byAddress.get(address)?.kind ?? 'unknown';
    },
    nameOf(address: string): string | null {
      return byAddress.get(address)?.name ?? null;
    },
    reload,
    stats: () => stats,
    entries: () => byAddress
  };
}
