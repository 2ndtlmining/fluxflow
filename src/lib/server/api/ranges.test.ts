import { describe, expect, it } from 'vitest';
import { decompose, type RangePiece } from './ranges.js';

const HOUR = 3_600;
const DAY = 86_400;
const LEVELS = [HOUR, DAY];

/** Pieces as `[from, to)` second intervals, sorted. */
function intervals(pieces: RangePiece[], levels = LEVELS): [number, number][] {
  return pieces
    .map((piece): [number, number] =>
      piece.level === 'raw'
        ? [piece.fromTime, piece.toTime]
        : [piece.fromBucket * levels[piece.level]!, (piece.toBucket + 1) * levels[piece.level]!]
    )
    .sort((a, b) => a[0] - b[0]);
}

/** Deterministic pseudo-random, so a failure reproduces. */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

describe('decompose', () => {
  const next = rng(7);
  const cases = Array.from({ length: 400 }, () => {
    const from = 1_700_000_000 + Math.floor(next() * 40 * DAY);
    const length = Math.floor(next() * (next() < 0.3 ? 2 * HOUR : 60 * DAY)) + 1;
    return { from, to: from + length };
  });

  it('covers a closed window exactly, with no gaps or overlaps', () => {
    for (const { from, to } of cases) {
      const spans = intervals(decompose(from, to, { levels: LEVELS, rawFrom: 0, open: false }));

      expect(spans[0]![0]).toBe(from);
      expect(spans.at(-1)![1]).toBe(to);
      for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBe(spans[i - 1]![1]);
    }
  });

  it('covers an open window from its start, overshooting only past its end', () => {
    for (const { from, to } of cases) {
      const spans = intervals(decompose(from, to, { levels: LEVELS, rawFrom: 0, open: true }));

      expect(spans[0]![0]).toBe(from);
      expect(spans.at(-1)![1]).toBeGreaterThanOrEqual(to);
      for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBe(spans[i - 1]![1]);
    }
  });

  it('uses the coarsest level for the middle, raw only at the edges', () => {
    const from = 10 * DAY + 5 * HOUR + 17;
    const to = 40 * DAY + 3 * HOUR + 59;
    const pieces = decompose(from, to, { levels: LEVELS, rawFrom: 0, open: false });

    expect(pieces).toEqual([
      { level: 'raw', fromTime: from, toTime: 10 * DAY + 6 * HOUR },
      { level: 0, fromBucket: 10 * 24 + 6, toBucket: 11 * 24 - 1 },
      { level: 1, fromBucket: 11, toBucket: 39 },
      { level: 0, fromBucket: 40 * 24, toBucket: 40 * 24 + 2 },
      { level: 'raw', fromTime: 40 * DAY + 3 * HOUR, toTime: to }
    ]);
  });

  it('needs no tail for an open window: the last bucket is complete', () => {
    const from = 10 * DAY + 5 * HOUR + 17;
    const pieces = decompose(from, 12 * DAY + 7, { levels: LEVELS, rawFrom: 0, open: true });

    expect(pieces.at(-1)).toEqual({ level: 1, fromBucket: 11, toBucket: 12 });
    expect(pieces.filter((piece) => piece.level === 'raw')).toHaveLength(1);
  });

  it('rounds a partial hour to the nearest whole hour where raw data is gone', () => {
    const rawFrom = 20 * DAY;
    // 50 minutes into an hour: the 10-minute remainder is dropped.
    const late = decompose(5 * DAY + 50 * 60, 7 * DAY, { levels: LEVELS, rawFrom, open: true });
    expect(late.some((piece) => piece.level === 'raw')).toBe(false);
    expect(late[0]).toEqual({ level: 0, fromBucket: 5 * 24 + 1, toBucket: 6 * 24 - 1 });

    // 10 minutes into an hour: the 50-minute remainder rounds up to the whole hour.
    const early = decompose(5 * DAY + 10 * 60, 7 * DAY, { levels: LEVELS, rawFrom, open: true });
    expect(early[0]).toEqual({ level: 0, fromBucket: 5 * 24, toBucket: 5 * 24 });
  });

  it('returns nothing for an empty window', () => {
    expect(decompose(100, 100, { levels: LEVELS, rawFrom: 0, open: false })).toEqual([]);
  });
});
