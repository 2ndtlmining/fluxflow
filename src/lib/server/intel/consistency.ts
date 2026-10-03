/**
 * Do the rollups still match the raw flows?
 *
 * The rollup tables are maintained by triggers (migrations 2 and 3) and re-derivation after
 * a label change goes through them too. This checks the invariant directly — every
 * (direction, counterparty kind, exchange) total and every wallet total, summed from the
 * rollups, equals the same sum over raw flows. Valid while no raw data has been pruned
 * (rollups deliberately outlive retention).
 */

import type { Db } from '../db/database.js';

/** Rollups (hourly, daily, wallet) vs raw flows: every mismatch, or none. */
export function rollupMismatches(db: Db): unknown[] {
  const levels = ['rollup_hourly', 'rollup_daily'].flatMap((table) =>
    db
      .prepare(
        `WITH raw AS (
           SELECT flow_type, CASE flow_type WHEN 'buying' THEN to_kind ELSE from_kind END AS kind,
                  COALESCE(exchange, '') AS exchange, SUM(sat) AS sat, COUNT(*) AS count
           FROM flows GROUP BY 1, 2, 3
         ), roll AS (
           SELECT flow_type, counterparty_kind AS kind, exchange,
                  SUM(sat) AS sat, SUM(count) AS count
           FROM ${table} GROUP BY 1, 2, 3
         )
         SELECT '${table}' AS level, * FROM raw FULL OUTER JOIN roll USING (flow_type, kind, exchange)
         WHERE raw.sat IS NOT roll.sat OR raw.count IS NOT roll.count`
      )
      .all()
  );

  const wallets = db
    .prepare(
      `WITH raw AS (
         SELECT flow_type,
                CASE flow_type WHEN 'buying' THEN to_address ELSE from_address END AS address,
                CASE flow_type WHEN 'buying' THEN to_kind ELSE from_kind END AS kind,
                SUM(sat) AS sat, COUNT(*) AS count
         FROM flows WHERE flow_type IN ('buying', 'selling') GROUP BY 1, 2, 3
       ), roll AS (
         SELECT flow_type, address, kind, SUM(sat) AS sat, SUM(count) AS count
         FROM wallet_daily GROUP BY 1, 2, 3
       )
       SELECT 'wallet_daily' AS level, * FROM raw FULL OUTER JOIN roll USING (flow_type, address, kind)
       WHERE raw.sat IS NOT roll.sat OR raw.count IS NOT roll.count`
    )
    .all();

  return [...levels, ...wallets];
}

export function rollupMismatchCount(db: Db): number {
  return rollupMismatches(db).length;
}
