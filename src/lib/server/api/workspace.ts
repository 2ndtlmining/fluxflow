/**
 * Investigation workspace (#69): notes, custom tags and saved cases.
 *
 * Findings like "this cluster is Flux paying for its own apps" used to live in chat. A wallet
 * can now carry one free-text note and a few tags of the reader's own; a case is a named set
 * of addresses with a description, and optionally the fund-flow graph view that showed it,
 * so the trail can be reopened exactly.
 *
 * FluxFlow runs for one person on a local network, so anyone who can open it may write
 * these (the owner's call); the API still validates every field and limits sizes. Writes
 * bump the data version through triggers (migration 8), so a cached wallet page or search
 * answer shows a new note at once.
 */

import { randomBytes } from 'node:crypto';
import type { Db } from '../db/database.js';

export const WORKSPACE_LIMITS = {
  noteChars: 4_000,
  tags: 10,
  tagChars: 32,
  caseName: 120,
  caseDescription: 4_000,
  caseAddresses: 200,
  graphExpansions: 200
} as const;

export interface Note {
  readonly address: string;
  readonly note: string;
  readonly tags: string[];
  readonly updatedAt: number;
}

export interface CaseGraph {
  readonly root: string;
  readonly period: string | null;
  readonly min: number;
  /** Expansions to replay, `address:in` or `address:out`, in order. */
  readonly expand: string[];
}

export interface Case {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly addresses: string[];
  readonly graph: CaseGraph | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface NoteRow {
  address: string;
  note: string;
  tags: string;
  updatedAt: number;
}

const toNote = (row: NoteRow): Note => ({
  address: row.address,
  note: row.note,
  tags: JSON.parse(row.tags) as string[],
  updatedAt: row.updatedAt
});

const NOTE_COLUMNS = `address, note, tags, updated_at AS updatedAt`;

export function getNote(db: Db, address: string): Note | null {
  const row = db
    .prepare<[string], NoteRow>(`SELECT ${NOTE_COLUMNS} FROM notes WHERE address = ?`)
    .get(address);
  return row ? toNote(row) : null;
}

/** Notes for many wallets at once, for search results and case members. */
export function notesFor(db: Db, addresses: readonly string[]): Map<string, Note> {
  if (addresses.length === 0) return new Map();
  const rows = db
    .prepare<string[], NoteRow>(
      `SELECT ${NOTE_COLUMNS} FROM notes WHERE address IN (${addresses.map(() => '?').join(', ')})`
    )
    .all(...addresses);
  return new Map(rows.map((row) => [row.address, toNote(row)]));
}

/** Write a wallet's note and tags; clearing both removes the note. */
export function setNote(db: Db, address: string, input: { note: string; tags: string[] }): void {
  const note = input.note.trim();
  const tags = [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))];
  if (note === '' && tags.length === 0) {
    db.prepare(`DELETE FROM notes WHERE address = ?`).run(address);
    return;
  }
  db.prepare(
    `INSERT INTO notes (address, note, tags, updated_at)
     VALUES (?, ?, ?, CAST(strftime('%s','now') AS INTEGER))
     ON CONFLICT (address) DO UPDATE SET
       note = excluded.note, tags = excluded.tags, updated_at = excluded.updated_at`
  ).run(address, note, JSON.stringify(tags));
}

/** Wallets whose note or tags contain `query`, case-insensitively; newest first. */
export function searchNotes(db: Db, query: string, limit = 10): Note[] {
  const pattern = `%${query.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  return db
    .prepare<[string, string, number], NoteRow>(
      `SELECT ${NOTE_COLUMNS} FROM notes
       WHERE note LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC, address
       LIMIT ?`
    )
    .all(pattern, pattern, limit)
    .map(toNote);
}

interface CaseRow {
  id: string;
  name: string;
  description: string;
  addresses: string;
  graph: string | null;
  createdAt: number;
  updatedAt: number;
}

const CASE_COLUMNS = `id, name, description, addresses, graph,
  created_at AS createdAt, updated_at AS updatedAt`;

const toCase = (row: CaseRow): Case => ({
  id: row.id,
  name: row.name,
  description: row.description,
  addresses: JSON.parse(row.addresses) as string[],
  graph: row.graph === null ? null : (JSON.parse(row.graph) as CaseGraph),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

const unique = (addresses: readonly string[]) => [...new Set(addresses)];

export function createCase(
  db: Db,
  input: { name: string; description?: string; addresses?: string[]; graph?: CaseGraph | null }
): string {
  // Short and unguessable enough to share as a link on a private network.
  const id = randomBytes(6).toString('base64url');
  db.prepare(
    `INSERT INTO cases (id, name, description, addresses, graph) VALUES (?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name.trim(),
    (input.description ?? '').trim(),
    JSON.stringify(unique(input.addresses ?? [])),
    input.graph ? JSON.stringify(input.graph) : null
  );
  return id;
}

export function getCase(db: Db, id: string): Case | null {
  const row = db
    .prepare<[string], CaseRow>(`SELECT ${CASE_COLUMNS} FROM cases WHERE id = ?`)
    .get(id);
  return row ? toCase(row) : null;
}

/** Every case, most recently changed first, without the addresses themselves. */
export function listCases(
  db: Db
): { id: string; name: string; description: string; count: number; updatedAt: number }[] {
  return db
    .prepare<[], CaseRow>(`SELECT ${CASE_COLUMNS} FROM cases ORDER BY updated_at DESC, id`)
    .all()
    .map(toCase)
    .map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      count: item.addresses.length,
      updatedAt: item.updatedAt
    }));
}

/** Change what is given; `graph: null` clears the saved view. Returns false for no such case. */
export function updateCase(
  db: Db,
  id: string,
  patch: { name?: string; description?: string; addresses?: string[]; graph?: CaseGraph | null }
): boolean {
  const current = getCase(db, id);
  if (!current) return false;
  const graph = patch.graph === undefined ? current.graph : patch.graph;
  db.prepare(
    `UPDATE cases SET name = ?, description = ?, addresses = ?, graph = ?,
       updated_at = CAST(strftime('%s','now') AS INTEGER)
     WHERE id = ?`
  ).run(
    (patch.name ?? current.name).trim(),
    (patch.description ?? current.description).trim(),
    JSON.stringify(unique(patch.addresses ?? current.addresses)),
    graph ? JSON.stringify(graph) : null,
    id
  );
  return true;
}

export function deleteCase(db: Db, id: string): boolean {
  return db.prepare(`DELETE FROM cases WHERE id = ?`).run(id).changes > 0;
}

/** The cases a wallet is part of, for its page. */
export function casesOf(db: Db, address: string): { id: string; name: string }[] {
  return db
    .prepare<[string], { id: string; name: string }>(
      `SELECT c.id, c.name FROM cases c, json_each(c.addresses) a
       WHERE a.value = ? ORDER BY c.updated_at DESC, c.id`
    )
    .all(address);
}
