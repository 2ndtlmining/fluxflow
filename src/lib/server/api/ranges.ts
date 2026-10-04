/**
 * Split a time window into the cheapest exact set of pre-aggregated buckets.
 *
 * Every rollup read has the same shape: whole buckets from the coarsest table that fits,
 * finer buckets towards the edges, and raw rows only for the partial bucket at each end.
 * Getting the edges right is where totals silently go wrong, so it lives here, once, with
 * its own tests, rather than being re-derived in each query.
 *
 *   window          [from ............................................ to)
 *   raw             [from, next hour)                        [last hour, to)
 *   level 0 (hour)        [.. to next day)            [.. to last day)
 *   level 1 (day)                  [ whole days ........ ]
 *
 * An **open** window ends at the newest stored data: nothing exists after it, so the bucket
 * containing its end is complete and no tail is needed. Every "last N days" period is open;
 * a "previous period" comparison window is closed.
 */

/** A piece of the window: raw rows by time, or buckets of one level by index (inclusive). */
export type RangePiece =
  | { readonly level: 'raw'; readonly fromTime: number; readonly toTime: number }
  | { readonly level: number; readonly fromBucket: number; readonly toBucket: number };

export interface DecomposeOptions {
  /** Bucket sizes in seconds, ascending; each a multiple of the previous. */
  readonly levels: readonly number[];
  /**
   * The oldest time raw rows exist for. Rollups outlive raw data (retention), so a raw
   * piece before this cannot be read exactly: it is rounded to the nearest whole bucket of
   * the finest level instead — included when it covers at least half of that bucket.
   */
  readonly rawFrom: number;
  /** The window ends at the newest data: the bucket holding `to` is complete. */
  readonly open: boolean;
}

const ceilTo = (value: number, size: number): number => Math.ceil(value / size) * size;
const floorTo = (value: number, size: number): number => Math.floor(value / size) * size;

/**
 * Decompose `[from, to)` into pieces. Pieces never overlap and, together, cover exactly
 * the window (up to the documented rounding before `rawFrom`).
 */
export function decompose(from: number, to: number, options: DecomposeOptions): RangePiece[] {
  const { levels, open } = options;
  if (to <= from || levels.length === 0) return [];

  // Spans in seconds, tagged with their level (-1 = raw).
  const spans: { level: number; from: number; to: number }[] = [];
  const emit = (level: number, a: number, b: number) => {
    if (b > a) spans.push({ level, from: a, to: b });
  };

  // Ascend: align `pos` to each coarser level using units of the finer one.
  let pos = from;
  let top = -1;
  for (let i = 0; i < levels.length; i++) {
    const boundary = ceilTo(pos, levels[i]!);
    if (!open && boundary > to) break;
    emit(i - 1, pos, boundary);
    pos = boundary;
    top = i;
  }

  if (top === -1) {
    // Closed, and short of a single boundary of the finest level. (An open window always
    // ascends fully: overshooting `to` is harmless when nothing exists after it.)
    emit(-1, pos, to);
  } else if (open) {
    // Nothing exists after `to`, so the coarsest bucket holding it is complete.
    emit(top, pos, ceilTo(to, levels[top]!));
  } else {
    // Descend: whole units of each level, finer towards the end, raw for the remainder.
    for (let i = top; i >= 0; i--) {
      const end = floorTo(to, levels[i]!);
      emit(i, pos, end);
      pos = Math.max(pos, end);
    }
    emit(-1, pos, to);
  }

  const finest = levels[0]!;
  const pieces: RangePiece[] = [];

  for (const span of spans) {
    if (span.level >= 0) {
      const size = levels[span.level]!;
      pieces.push({
        level: span.level,
        fromBucket: span.from / size,
        toBucket: span.to / size - 1
      });
      continue;
    }

    if (span.from >= options.rawFrom) {
      pieces.push({ level: 'raw', fromTime: span.from, toTime: span.to });
      continue;
    }

    // Raw rows are gone here: round to the finest bucket containing the span.
    if (span.to - span.from >= finest / 2) {
      const bucket = Math.floor(span.from / finest);
      pieces.push({ level: 0, fromBucket: bucket, toBucket: bucket });
    }
  }

  return pieces;
}
