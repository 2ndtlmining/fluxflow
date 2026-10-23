import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type Db } from '../testkit.js';
import { dataVersion } from './queries.js';
import {
  casesOf,
  createCase,
  deleteCase,
  getCase,
  getNote,
  listCases,
  notesFor,
  searchNotes,
  setNote,
  updateCase
} from './workspace.js';

const MZJA = 't1Mzja9iJcEYeW5B4m4s1tJG8M42odFZ16A';
const FIVE = [
  't1Mzja9iJcEYeW5B4m4s1tJG8M42odFZ16A',
  't1gjUUxBpBeVC1sWwAFrtSsVCbSaFdZx8UY',
  't1XktDZ9Z1QiefMYE5nMFohe8VG2c2BD5A5',
  't3dLRNHYXsRKW4cSec98YDC9G5zjqDN7NRu',
  't3NryfAQLGeFs9jEoeqsxmBN2QLRaRKFLUX'
];

describe('investigation workspace (#69)', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => db.close());

  describe('notes and tags', () => {
    it('keeps one note and its tags per wallet, and finds them by text or tag', () => {
      expect(getNote(db, MZJA)).toBeNull();

      setNote(db, MZJA, {
        note: 'Flux paying for its own app deployments',
        tags: ['team', 'apps']
      });
      expect(getNote(db, MZJA)).toMatchObject({
        address: MZJA,
        note: 'Flux paying for its own app deployments',
        tags: ['team', 'apps'],
        updatedAt: expect.any(Number)
      });

      expect(searchNotes(db, 'own app').map((hit) => hit.address)).toEqual([MZJA]);
      expect(searchNotes(db, 'TEAM').map((hit) => hit.address)).toEqual([MZJA]);
      expect(searchNotes(db, 'kucoin')).toEqual([]);
      expect(notesFor(db, [MZJA, FIVE[1]!]).get(MZJA)).toMatchObject({ tags: ['team', 'apps'] });
    });

    it('treats LIKE wildcards in a search as plain text', () => {
      setNote(db, MZJA, { note: 'paid 100% of fees', tags: [] });
      expect(searchNotes(db, '100%').map((hit) => hit.address)).toEqual([MZJA]);
      expect(searchNotes(db, '_')).toEqual([]);
    });

    it('deletes the note when both the text and the tags are cleared', () => {
      setNote(db, MZJA, { note: 'x', tags: ['y'] });
      setNote(db, MZJA, { note: '  ', tags: [] });
      expect(getNote(db, MZJA)).toBeNull();
    });

    it('bumps the data version, so cached wallet pages and search answers refresh', () => {
      const before = dataVersion(db);
      setNote(db, MZJA, { note: 'x', tags: [] });
      expect(dataVersion(db)).toBeGreaterThan(before);
    });
  });

  describe('cases', () => {
    it('saves a case with five addresses and a graph view, and reopens it', () => {
      const id = createCase(db, {
        name: 'Flux paying for its own apps',
        description: 'Foundation to app payers to app hosting',
        addresses: FIVE,
        graph: { root: MZJA, period: '30D', min: 0, expand: [`${MZJA}:in`, `${MZJA}:out`] }
      });

      expect(getCase(db, id)).toMatchObject({
        id,
        name: 'Flux paying for its own apps',
        addresses: FIVE,
        graph: { root: MZJA, period: '30D', expand: [`${MZJA}:in`, `${MZJA}:out`] }
      });
      expect(listCases(db)).toEqual([
        expect.objectContaining({ id, name: 'Flux paying for its own apps', count: 5 })
      ]);
      expect(casesOf(db, FIVE[2]!)).toEqual([{ id, name: 'Flux paying for its own apps' }]);
      expect(casesOf(db, 't1someoneElsexxxxxxxxxxxxxxxxxxxxxx')).toEqual([]);
    });

    it('updates only what is given, keeps addresses unique and in order, and deletes', () => {
      const id = createCase(db, { name: 'A', addresses: [FIVE[0]!] });
      updateCase(db, id, { addresses: [FIVE[0]!, FIVE[1]!, FIVE[0]!] });
      expect(getCase(db, id)).toMatchObject({
        name: 'A',
        description: '',
        addresses: [FIVE[0], FIVE[1]],
        graph: null
      });

      updateCase(db, id, { name: 'B', graph: null });
      expect(getCase(db, id)).toMatchObject({ name: 'B', addresses: [FIVE[0], FIVE[1]] });

      expect(deleteCase(db, id)).toBe(true);
      expect(getCase(db, id)).toBeNull();
      expect(deleteCase(db, id)).toBe(false);
    });
  });
});
