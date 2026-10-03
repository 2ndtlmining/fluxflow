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
