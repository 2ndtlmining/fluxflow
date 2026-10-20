/** Helpers for charting per-day series. */

const DAY = 86_400;
/** Beyond this a wallet chart is too dense to read anyway; show its most recent days. */
const MAX_DAYS = 400;

/**
 * Turn a sparse per-day series (only days with activity) into a continuous one, so that a
 * chart's columns sit on a real timeline: three busy days a month apart must not look like
 * three days in a row.
 */
export function fillDays(
  series: readonly { time: number; bought: number; sold: number }[]
): { time: number; buying: number; selling: number }[] {
  if (series.length === 0) return [];

  const byDay = new Map(series.map((point) => [Math.floor(point.time / DAY), point]));
  const days = [...byDay.keys()];
  const last = Math.max(...days);
  const first = Math.max(Math.min(...days), last - MAX_DAYS + 1);

  const out: { time: number; buying: number; selling: number }[] = [];
  for (let day = first; day <= last; day++) {
    const point = byDay.get(day);
    out.push({ time: day * DAY, buying: point?.bought ?? 0, selling: point?.sold ?? 0 });
  }
  return out;
}

/**
 * A sparse per-day balance series (only days with activity) as a continuous daily step line,
 * carried forward over quiet days and up to `untilDay` (normally today), so a wallet that
 * emptied itself months ago reads as flat at zero ever since, not as ending months ago.
 *
 * Uses the closing `balance` when known, else the running net `change`. The first point is
 * the day before the first activity, at the opening value, so the first day's move shows.
 */
export function balanceSteps(
  series: readonly { time: number; change: number; balance: number | null }[],
  opening: number | null,
  untilDay = Math.floor(Date.now() / 1000 / DAY)
): { time: number; value: number }[] {
  if (series.length === 0) return [];

  const anchored = series[0]!.balance !== null;
  const byDay = new Map(
    series.map((point) => [
      Math.floor(point.time / DAY),
      anchored ? (point.balance ?? 0) : point.change
    ])
  );
  const firstActive = Math.floor(series[0]!.time / DAY);
  const last = Math.max(Math.floor(series.at(-1)!.time / DAY), untilDay);
  const first = Math.max(firstActive - 1, last - MAX_DAYS + 1);

  // Start from the value carried into the first drawn day.
  let value = anchored ? (opening ?? 0) : 0;
  for (const point of series) {
    if (Math.floor(point.time / DAY) >= first) break;
    value = byDay.get(Math.floor(point.time / DAY))!;
  }

  const out: { time: number; value: number }[] = [];
  for (let day = first; day <= last; day++) {
    value = byDay.get(day) ?? value;
    out.push({ time: day * DAY, value });
  }
  return out;
}
