/**
 * Address labels: who an address belongs to, how sure we are, and why.
 *
 * Labels are **not** chain facts and never live in `blocks`/`tx_deltas`. Every label —
 * hand-maintained config, the node list, coinbase rewards, accepted clustering candidates,
 * manual corrections — is a row in `address_labels` with a `source`, a `confidence`, an
 * optional validity window and its `evidence`. That table is the single source of truth
 * (#18); this module turns it into the one answer the flow derivation needs per address.
 *
 * Two rules decide that answer:
 *
 *  1. **Only labels at or above {@link APPLY_MIN_CONFIDENCE} ("likely") change a flow.**
 *     A `possible` node operator or an unreviewed exchange candidate is shown on a wallet's
 *     profile with its evidence, but never moves money between headline categories (#19).
 *  2. **Sources have a priority.** A manual correction beats the config file, which beats an
 *     accepted candidate, which beats anything inferred. So an exchange hot wallet that also
 *     happens to receive node rewards stays an exchange.
 *
 * Whenever the effective label of an address changes, the address is queued in
 * `relabel_queue` and its flows are re-derived (see `intel/relabel.ts`), so the totals follow
 * the label rather than whatever the label was when the block was synced.
 */

import fs from 'node:fs';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { Db } from './db/database.js';
import { serialiseError } from './logger.js';
import type { AddressKind } from './ingest/datasource/types.js';

/** Confidence a label needs before it changes how a flow is classified. */
export const APPLY_MIN_CONFIDENCE = 0.7;

/** Named confidence levels. Stored as numbers so sources can be finer-grained. */
export const CONFIDENCE = {
  confirmed: 1,
  likely: 0.8,
  possible: 0.5,
  candidate: 0.3
} as const;

export type ConfidenceLevel = keyof typeof CONFIDENCE;

export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.95) return 'confirmed';
  if (confidence >= APPLY_MIN_CONFIDENCE) return 'likely';
  if (confidence >= 0.45) return 'possible';
  return 'candidate';
}

/** Parse `?minConfidence=` — a level name or a number in [0, 1]. */
export function parseMinConfidence(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  if (value in CONFIDENCE) return CONFIDENCE[value as ConfidenceLevel];
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

/** Highest priority first. A source not listed ranks after all of these. */
export const SOURCE_PRIORITY = [
  'manual',
  'config',
  'accepted',
  'node_list',
  'node_rewards',
  // An exchange deposit address found by behaviour (intel/forwarders.ts). Above node
  // forwarding: "sends everything to one exchange" is stronger evidence than "was paid by
  // node operators", which a node operator's own deposit address also is.
  'forwarder',
  'forwarding'
] as const;

export type LabelSource = (typeof SOURCE_PRIORITY)[number];

function priorityOf(source: string): number {
  const index = (SOURCE_PRIORITY as readonly string[]).indexOf(source);
  return index === -1 ? SOURCE_PRIORITY.length : index;
}

/** One `address_labels` row. */
export interface LabelRow {
  readonly address: string;
  readonly kind: AddressKind;
  readonly name: string | null;
  readonly subLabel: string | null;
  readonly source: string;
  readonly confidence: number;
  /** Unix seconds; `null` means unbounded. */
  readonly validFrom: number | null;
  readonly validTo: number | null;
  /** Parsed JSON, or `null`. */
  readonly evidence: unknown;
}

/** The label that decides how an address is classified. */
export interface EffectiveLabel {
  readonly kind: AddressKind;
  readonly name: string | null;
  readonly subLabel: string | null;
  readonly source: string;
  readonly confidence: number;
  readonly level: ConfidenceLevel;
  readonly validFrom: number | null;
  readonly validTo: number | null;
}

export interface LabelLookup {
  /** `unknown` for an address we cannot name with at least "likely" confidence. */
  kindOf(address: string, time?: number): AddressKind;
  nameOf(address: string, time?: number): string | null;
  /** The applied label, or `null`. With `time`, only a label valid at that moment. */
  labelOf(address: string, time?: number): EffectiveLabel | null;
  /** Every stored label for an address, applied or not, best first. */
  allLabels(address: string): LabelRow[];
  /** Addresses whose applied label (ignoring time) is of this kind. */
  addressesOf(kind: AddressKind): string[];
  /** Re-read the config file into `address_labels`, then {@link refresh}. */
  reload(): LabelStats;
  /**
   * Rebuild from `address_labels` and queue every address whose effective label changed.
   * @returns the changed addresses.
   */
  refresh(reason?: string): string[];
  stats(): LabelStats;
  /** Applied labels keyed by address (time-agnostic), for the flow derivation step. */
  entries(): ReadonlyMap<string, { kind: AddressKind; name: string | null }>;
}

export interface LabelStats {
  readonly exchanges: number;
  readonly foundation: number;
  readonly nodeOperators: number;
  readonly total: number;
  readonly bySource: Record<string, number>;
  readonly source: string;
  readonly loadedAt: number;
}

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
  /** `wallets` names Foundation sub-wallets; each becomes a `sub_label` (#31). */
  foundation?: LabelEntry & { wallets?: { name: string; addresses: string[] }[] };
}

/** A label to write; `address_labels` columns. */
export interface LabelInput {
  readonly address: string;
  readonly kind: AddressKind;
  readonly name?: string | null;
  readonly subLabel?: string | null;
  readonly confidence: number;
  readonly validFrom?: number | null;
  readonly validTo?: number | null;
  readonly evidence?: unknown;
}

/**
 * Replace every label of one `source` with `rows`, in one transaction.
 *
 * Rows that disappeared are deleted — a config entry removed from the file, a node that left
 * the list — which is what lets a correction actually take effect. Callers then call
 * `LabelLookup.refresh()` to queue the affected addresses.
 */
export function replaceSourceLabels(db: Db, source: string, rows: readonly LabelInput[]): void {
  const write = db.transaction(() => {
    db.prepare(`CREATE TEMP TABLE IF NOT EXISTS keep_labels (address TEXT, kind TEXT)`).run();
    db.prepare(`DELETE FROM keep_labels`).run();

    const keep = db.prepare(`INSERT INTO keep_labels (address, kind) VALUES (?, ?)`);
    const upsert = db.prepare(
      `INSERT INTO address_labels
         (address, kind, name, sub_label, source, confidence, valid_from, valid_to, evidence,
          updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(strftime('%s','now') AS INTEGER))
       ON CONFLICT (address, kind, source) DO UPDATE SET
         name = excluded.name,
         sub_label = excluded.sub_label,
         confidence = excluded.confidence,
         valid_from = excluded.valid_from,
         valid_to = excluded.valid_to,
         evidence = excluded.evidence,
         updated_at = excluded.updated_at
       WHERE name IS NOT excluded.name
          OR sub_label IS NOT excluded.sub_label
          OR confidence IS NOT excluded.confidence
          OR valid_from IS NOT excluded.valid_from
          OR valid_to IS NOT excluded.valid_to
          OR evidence IS NOT excluded.evidence`
    );

    for (const row of rows) {
      keep.run(row.address, row.kind);
      upsert.run(
        row.address,
        row.kind,
        row.name ?? null,
        row.subLabel ?? null,
        source,
        row.confidence,
        row.validFrom ?? null,
        row.validTo ?? null,
        row.evidence === undefined || row.evidence === null ? null : JSON.stringify(row.evidence)
      );
    }

    db.prepare(
      `DELETE FROM address_labels
       WHERE source = ?
         AND NOT EXISTS (
           SELECT 1 FROM keep_labels k
           WHERE k.address = address_labels.address AND k.kind = address_labels.kind
         )`
    ).run(source);
  });

  write();
}

interface StoredRow {
  address: string;
  kind: string;
  name: string | null;
  sub_label: string | null;
  source: string;
  confidence: number;
  valid_from: number | null;
  valid_to: number | null;
  evidence: string | null;
}

function toLabelRow(row: StoredRow): LabelRow {
  let evidence: unknown = null;
  if (row.evidence) {
    try {
      evidence = JSON.parse(row.evidence);
    } catch {
      evidence = row.evidence;
    }
  }

  return {
    address: row.address,
    kind: row.kind as AddressKind,
    name: row.name,
    subLabel: row.sub_label,
    source: row.source,
    confidence: row.confidence,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    evidence
  };
}

/** Best first: source priority, then confidence. */
function rank(a: LabelRow, b: LabelRow): number {
  return priorityOf(a.source) - priorityOf(b.source) || b.confidence - a.confidence;
}

function toEffective(row: LabelRow): EffectiveLabel {
  return {
    kind: row.kind,
    name: row.name,
    subLabel: row.subLabel,
    source: row.source,
    confidence: row.confidence,
    level: confidenceLevel(row.confidence),
    validFrom: row.validFrom,
    validTo: row.validTo
  };
}

/** What re-derivation depends on; two equal signatures classify every flow identically. */
function signature(rows: readonly LabelRow[] | undefined): string {
  if (!rows || rows.length === 0) return '';
  return rows.map((row) => `${row.kind}|${row.name}|${row.validFrom}|${row.validTo}`).join(';');
}

/**
 * Load labels from disk and the database.
 *
 * Config rows are tagged `source = 'config'`; anything inferred uses its own source, so a
 * hand-maintained label is never overwritten by a guess.
 */
export function loadLabels(db: Db, config: Config, log: Logger): LabelLookup {
  /** Applied rows only (confidence ≥ threshold), best first. */
  let applied = new Map<string, LabelRow[]>();
  /** Time-agnostic view of the best applied row, for `entries()`. */
  let effective = new Map<string, { kind: AddressKind; name: string | null }>();
  let stats: LabelStats = emptyStats(config.labelsPath);
  let loaded = false;

  const selectAll = db.prepare<[], StoredRow>(
    `SELECT address, kind, name, sub_label, source, confidence, valid_from, valid_to, evidence
     FROM address_labels`
  );
  const selectOne = db.prepare<[string], StoredRow>(
    `SELECT address, kind, name, sub_label, source, confidence, valid_from, valid_to, evidence
     FROM address_labels WHERE address = ?`
  );
  // `queued_at` in milliseconds, refreshed on every change: the relabel worker removes an
  // address only if it was not queued again while being processed.
  const enqueue = db.prepare(
    `INSERT INTO relabel_queue (address, reason, queued_at) VALUES (?, ?, ?)
     ON CONFLICT (address) DO UPDATE SET reason = excluded.reason, queued_at = excluded.queued_at`
  );

  const pick = (address: string, time?: number): LabelRow | null => {
    for (const row of applied.get(address) ?? []) {
      if (time !== undefined) {
        if (row.validFrom !== null && time < row.validFrom) continue;
        if (row.validTo !== null && time > row.validTo) continue;
      }
      return row.kind === 'unknown' ? null : row;
    }
    return null;
  };

  const refresh = (reason = 'labels changed'): string[] => {
    const next = new Map<string, LabelRow[]>();
    const bySource: Record<string, number> = {};

    for (const stored of selectAll.iterate()) {
      const row = toLabelRow(stored);
      bySource[row.source] = (bySource[row.source] ?? 0) + 1;
      // An `unknown` row is kept: a manual "this is not an exchange" must outrank the
      // config or an inference, and it does so by being the best row.
      if (row.confidence < APPLY_MIN_CONFIDENCE) continue;

      const list = next.get(row.address);
      if (list) list.push(row);
      else next.set(row.address, [row]);
    }

    for (const list of next.values()) list.sort(rank);

    const changed: string[] = [];
    if (loaded) {
      for (const address of new Set([...applied.keys(), ...next.keys()])) {
        if (signature(applied.get(address)) !== signature(next.get(address))) {
          changed.push(address);
        }
      }
    }

    applied = next;
    effective = new Map(
      [...next]
        .filter(([, rows]) => rows[0]!.kind !== 'unknown')
        .map(([address, rows]) => [address, { kind: rows[0]!.kind, name: rows[0]!.name }])
    );
    loaded = true;

    if (changed.length > 0) {
      db.transaction(() => {
        const now = Date.now();
        for (const address of changed) enqueue.run(address, reason, now);
      })();
    }

    let exchanges = 0;
    let foundation = 0;
    let nodeOperators = 0;
    for (const { kind } of effective.values()) {
      if (kind === 'exchange') exchanges++;
      else if (kind === 'foundation') foundation++;
      else if (kind === 'node_operator') nodeOperators++;
    }

    stats = {
      exchanges,
      foundation,
      nodeOperators,
      total: effective.size,
      bySource,
      source: config.labelsPath,
      loadedAt: Date.now()
    };

    return changed;
  };

  const reload = (): LabelStats => {
    let parsed: LabelsFile | null = null;

    try {
      parsed = JSON.parse(fs.readFileSync(config.labelsPath, 'utf8')) as LabelsFile;
    } catch (error) {
      // Missing or malformed labels degrade classification, they must not stop the service.
      // The config rows already stored are kept: a half-written file during an edit must
      // not wipe every exchange label and re-derive the whole database as "unknown".
      log.warn(
        { path: config.labelsPath, ...serialiseError(error) },
        'could not read the labels file, keeping the labels already loaded'
      );
    }

    if (parsed) replaceSourceLabels(db, 'config', configRows(parsed));
    refresh('config labels changed');
    return stats;
  };

  reload();

  return {
    kindOf: (address, time) => pick(address, time)?.kind ?? 'unknown',
    nameOf: (address, time) => pick(address, time)?.name ?? null,
    labelOf: (address, time) => {
      const row = pick(address, time);
      return row ? toEffective(row) : null;
    },
    allLabels: (address) => selectOne.all(address).map(toLabelRow).sort(rank),
    addressesOf: (kind) =>
      [...effective].filter(([, label]) => label.kind === kind).map(([address]) => address),
    reload,
    refresh,
    stats: () => stats,
    entries: () => effective
  };
}

function emptyStats(source: string): LabelStats {
  return {
    exchanges: 0,
    foundation: 0,
    nodeOperators: 0,
    total: 0,
    bySource: {},
    source,
    loadedAt: 0
  };
}

/** Rows for `source = 'config'` from the parsed labels file. */
function configRows(parsed: LabelsFile): LabelInput[] {
  const rows = new Map<string, LabelInput>();
  const add = (input: LabelInput) => rows.set(`${input.address}|${input.kind}`, input);

  for (const exchange of parsed.exchanges ?? []) {
    for (const address of exchange.addresses ?? []) {
      add({
        address,
        kind: 'exchange',
        name: exchange.name,
        confidence: exchange.confidence ?? 1,
        evidence: { method: 'config' }
      });
    }
  }

  const foundation = parsed.foundation;
  if (foundation) {
    for (const address of foundation.addresses ?? []) {
      add({
        address,
        kind: 'foundation',
        name: foundation.name,
        confidence: foundation.confidence ?? 1,
        evidence: { method: 'config' }
      });
    }

    // Named sub-wallets: listed under `wallets`, or only there.
    for (const wallet of foundation.wallets ?? []) {
      for (const address of wallet.addresses ?? []) {
        add({
          address,
          kind: 'foundation',
          name: foundation.name,
          subLabel: wallet.name,
          confidence: foundation.confidence ?? 1,
          evidence: { method: 'config' }
        });
      }
    }
  }

  return [...rows.values()];
}
