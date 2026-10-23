/**
 * Classification coverage (#20): how much exchange volume FluxFlow can attribute.
 *
 * Every deposit to and withdrawal from an exchange has a counterparty wallet. The headline
 * "who is selling" answer is only as good as the share of that volume whose counterparty
 * has a kind — node operator, Foundation, another exchange — rather than `unknown`. This is
 * the number that says whether a label change, a new heuristic or an accepted candidate
 * actually moved anything: measured over the whole stored window, before and after.
 *
 * Read from the rollups, so it costs a few milliseconds on a six-month database.
 */

import type { Db } from '../db/database.js';
import { openRange, resolvePeriod, summariseFlowRange } from '../api/queries.js';

export interface Coverage {
  /** FLUX moved to or from exchanges in the stored window, both directions. */
  readonly volume: number;
  /** Of that, FLUX whose counterparty is classified (anything but `unknown`). */
  readonly classified: number;
  /** `classified / volume`; null when there is no exchange volume to judge. */
  readonly share: number | null;
  /** FLUX by counterparty kind. */
  readonly byKind: Record<string, number>;
}

/** Coverage over everything stored. */
export function classificationCoverage(db: Db): Coverage {
  const range = openRange(resolvePeriod(db, 0));
  const byKind: Record<string, number> = {};
  for (const flowType of ['buying', 'selling'] as const) {
    for (const [kind, flux] of Object.entries(summariseFlowRange(db, range, flowType).byKind)) {
      byKind[kind] = (byKind[kind] ?? 0) + flux;
    }
  }

  const volume = Object.values(byKind).reduce((sum, flux) => sum + flux, 0);
  const classified = volume - (byKind.unknown ?? 0);
  return {
    volume,
    classified,
    share: volume > 0 ? classified / volume : null,
    byKind
  };
}
