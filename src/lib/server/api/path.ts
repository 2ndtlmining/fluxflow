/**
 * Path finder (#70): is wallet A connected to wallet B, and how?
 *
 * "Did this seller's FLUX come from the Foundation?" used to mean clicking through the graph
 * a hop at a time. This searches for it: the strongest few routes from `src` to `dst` within
 * `maxHops`, ranked by their **bottleneck** — the smallest hop, which caps how much of the
 * money can have travelled the whole way.
 *
 * Edges are wallet-to-wallet totals, from two places:
 *  - `flows`, through the `(address, height)` indexes, as the fund-flow graph reads them
 *  - moves between Foundation wallets, which are never flows (#31) but are very much a trail
 *    (`t1eabPBa…` → `t1Mzja…` → `t1XktDZ9…` → app hosting is three of them in a row). These
 *    come from `tx_deltas`, split between funders exactly as flows are.
 *
 * The search is breadth-first from both ends — forward along what `src` sent, backward along
 * what `dst` received — and the paths are read off the wallets the two meet in. It is bounded:
 * each wallet contributes at most {@link PATH_LIMITS.fanout} counterparties per side (largest
 * first) and each side expands at most {@link PATH_LIMITS.nodesPerSide} wallets; `truncated`
 * says when a budget cut the search short, `trimmed` how many wallets had more counterparties
 * than the fan-out. On a synthetic six-month database (2.2M deltas, heavy-tailed wallets) a
 * search takes under 100 ms at 4 hops and under 250 ms at the 6-hop maximum. An exchange is not passed through unless asked:
 * money that enters one comes out as anybody's.
 */

import type { Db } from '../db/database.js';
import type { AddressKind } from '../ingest/datasource/types.js';
import { SATS_PER_FLUX } from '../ingest/datasource/types.js';
import { flowsFromDeltas, type DeltaRow } from '../ingest/derive.js';
import type { LabelLookup } from '../labels.js';
import type { HeightWindow } from './apps.js';

export const PATH_LIMITS = {
  defaultHops: 4,
  maxHops: 6,
  /** Counterparties per wallet and side, largest first. */
  fanout: 25,
  /** Wallets expanded per side. */
  nodesPerSide: 1_500,
  /** Newest flows read per wallet and side, as in the graph. */
  rows: 20_000,
  /** Paths returned, and paths looked at before ranking. */
  paths: 5,
  maxPaths: 20,
  candidates: 20_000
} as const;

export interface PathHop {
  readonly from: string;
  readonly to: string;
  /** FLUX moved from `from` to `to` in the window. */
  readonly total: number;
  readonly count: number;
  readonly first: number;
  readonly last: number;
  /** A move between Foundation wallets, which is never counted as a transfer elsewhere. */
  readonly internal: boolean;
}

export interface FoundPath {
  readonly hops: PathHop[];
  /** The smallest hop's total: how much can have made it all the way. */
  readonly bottleneck: number;
}

export interface PathResult {
  readonly src: string;
  readonly dst: string;
  readonly maxHops: number;
  readonly throughExchanges: boolean;
  readonly paths: FoundPath[];
  /** Every wallet on a returned path. */
  readonly nodes: Record<string, { kind: AddressKind; name: string | null }>;
  readonly explored: { readonly forward: number; readonly backward: number };
  /**
   * Wallets whose counterparties were cut to the {@link PATH_LIMITS.fanout} largest. Routine
   * for any busy wallet; a route through one of the smaller ones would be missed.
   */
  readonly trimmed: number;
  /** A budget (wallets per side, paths looked at) stopped the search early. */
  readonly truncated: boolean;
}

export interface PathOptions {
  readonly maxHops?: number;
  readonly throughExchanges?: boolean;
  readonly limit?: number;
}

interface Edge {
  sat: number;
  count: number;
  first: number;
  last: number;
  internal: boolean;
}

const key = (from: string, to: string) => `${from}\u0000${to}`;

/** One move between two Foundation wallets, as derived from one transaction. */
interface Move {
  readonly from: string;
  readonly to: string;
  readonly sat: number;
  readonly height: number;
  readonly time: number;
}

/**
 * Foundation moves kept per database, so a search does not re-derive them every time. On the
 * live database that took about 3.5 s per search: the Foundation's node wallets and swap
 * pools touch a great many transactions. Kept up to date by reading only blocks newer than
 * the last search; rebuilt when the Foundation's addresses change or the tip moves back (a
 * reorg). Rows below the retention floor stay but fall outside every search window.
 */
const MOVES = new WeakMap<Db, { addresses: string; tip: number; moves: Move[] }>();

function foundationMoves(db: Db, labels: LabelLookup): Move[] {
  const foundation = labels.addressesOf('foundation');
  if (foundation.length < 2) return [];

  const addresses = [...foundation].sort().join(',');
  const tip =
    db.prepare<[], { h: number | null }>(`SELECT MAX(height) AS h FROM tx_deltas`).get()?.h ?? 0;
  let kept = MOVES.get(db);
  if (!kept || kept.addresses !== addresses || tip < kept.tip) {
    kept = { addresses, tip: -1, moves: [] };
    MOVES.set(db, kept);
  }
  if (tip === kept.tip) return kept.moves;

  // A move needs a Foundation wallet that spent, so receipts alone (node rewards, the bulk
  // of these wallets' rows) are never read past the index.
  const marks = foundation.map(() => '?').join(', ');
  const txids = db
    .prepare<(string | number)[], { txid: string }>(
      `SELECT DISTINCT d.txid FROM tx_deltas d INDEXED BY idx_tx_deltas_address
       WHERE d.address IN (${marks}) AND d.height > ? AND d.height <= ? AND d.sat_in > d.sat_out
         AND EXISTS (SELECT 1 FROM tx_deltas o
                     WHERE o.txid = d.txid AND o.address IN (${marks}) AND o.address <> d.address)`
    )
    .all(...foundation, kept.tip, tip, ...foundation);

  const deltas = db.prepare<[string], DeltaRow>(
    `SELECT txid, address, height, time, sat_in AS satIn, sat_out AS satOut
     FROM tx_deltas WHERE txid = ?`
  );
  for (const { txid } of txids) {
    const values = deltas.all(txid);
    const { height, time } = values[0]!;
    for (const row of flowsFromDeltas(txid, height, time, values, labels, { keepInternal: true })) {
      if (row.fromKind !== 'foundation' || row.toKind !== 'foundation') continue;
      kept.moves.push({ from: row.fromAddress, to: row.toAddress, sat: row.sat, height, time });
    }
  }
  kept.tip = tip;
  return kept.moves;
}

/** Foundation-to-Foundation moves in the window, aggregated per (from, to). */
function foundationEdges(db: Db, labels: LabelLookup, window: HeightWindow): Map<string, Edge> {
  const edges = new Map<string, Edge>();
  for (const move of foundationMoves(db, labels)) {
    if (move.height < window.fromHeight || move.height > window.toHeight) continue;
    const edge = edges.get(key(move.from, move.to));
    if (edge) {
      edge.sat += move.sat;
      edge.count++;
      edge.first = Math.min(edge.first, move.time);
      edge.last = Math.max(edge.last, move.time);
    } else {
      edges.set(key(move.from, move.to), {
        sat: move.sat,
        count: 1,
        first: move.time,
        last: move.time,
        internal: true
      });
    }
  }
  return edges;
}

export function findPaths(
  db: Db,
  labels: LabelLookup,
  src: string,
  dst: string,
  window: HeightWindow,
  options: PathOptions = {}
): PathResult {
  const maxHops = Math.min(
    Math.max(1, Math.trunc(options.maxHops ?? PATH_LIMITS.defaultHops) || 1),
    PATH_LIMITS.maxHops
  );
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? PATH_LIMITS.paths) || 1),
    PATH_LIMITS.maxPaths
  );
  const throughExchanges = options.throughExchanges ?? false;

  const internal = foundationEdges(db, labels, window);
  const internalBy = { out: new Map<string, string[]>(), in: new Map<string, string[]>() };
  for (const id of internal.keys()) {
    const [from, to] = id.split('\u0000') as [string, string];
    internalBy.out.set(from, [...(internalBy.out.get(from) ?? []), to]);
    internalBy.in.set(to, [...(internalBy.in.get(to) ?? []), from]);
  }

  const sideQuery = (column: 'from_address' | 'to_address') => {
    const other = column === 'to_address' ? 'from_address' : 'to_address';
    return db.prepare<
      [{ address: string; from: number; to: number; rows: number; fanout: number }],
      { address: string; sat: number; count: number; first: number; last: number }
    >(
      `SELECT address, SUM(sat) AS sat, COUNT(*) AS count, MIN(time) AS first, MAX(time) AS last
       FROM (SELECT ${other} AS address, sat, time FROM flows
             WHERE ${column} = @address AND height BETWEEN @from AND @to
             ORDER BY height DESC LIMIT @rows)
       WHERE address <> @address
       GROUP BY address
       ORDER BY sat DESC, address
       LIMIT @fanout`
    );
  };
  const outgoing = sideQuery('from_address');
  const incoming = sideQuery('to_address');

  // Every edge either search found, by (from, to).
  const edges = new Map<string, Edge>(internal);
  let truncated = false;
  const trimmed = new Set<string>();

  /** The wallets one hop away on `side`, recording the edges on the way. */
  const neighbours = (address: string, side: 'out' | 'in'): string[] => {
    const rows = (side === 'out' ? outgoing : incoming).all({
      address,
      from: window.fromHeight,
      to: window.toHeight,
      rows: PATH_LIMITS.rows,
      fanout: PATH_LIMITS.fanout
    });
    if (rows.length === PATH_LIMITS.fanout) trimmed.add(`${side}:${address}`);
    const found = new Set<string>();
    for (const row of rows) {
      const [from, to] = side === 'out' ? [address, row.address] : [row.address, address];
      if (!edges.has(key(from, to))) {
        edges.set(key(from, to), {
          sat: row.sat,
          count: row.count,
          first: row.first,
          last: row.last,
          internal: false
        });
      }
      found.add(row.address);
    }
    for (const other of internalBy[side].get(address) ?? []) found.add(other);
    return [...found];
  };

  /** A trail continues through this wallet: anything but an exchange, unless asked. */
  const passable = (address: string) => throughExchanges || labels.kindOf(address) !== 'exchange';

  const search = (start: string, side: 'out' | 'in', depth: number): Map<string, number> => {
    const seen = new Map([[start, 0]]);
    let frontier = [start];
    let expanded = 0;
    for (let level = 1; level <= depth && frontier.length > 0; level++) {
      const next: string[] = [];
      for (const address of frontier) {
        if (address !== start && !passable(address)) continue;
        if (expanded >= PATH_LIMITS.nodesPerSide) {
          truncated = true;
          break;
        }
        expanded++;
        for (const other of neighbours(address, side)) {
          if (seen.has(other)) continue;
          seen.set(other, level);
          next.push(other);
        }
      }
      frontier = next;
    }
    return seen;
  };

  // Split the hops between the two ends; a path of up to `maxHops` meets in the middle.
  const forward = search(src, 'out', Math.ceil(maxHops / 2));
  const backward = search(dst, 'in', Math.floor(maxHops / 2));

  // Outgoing edges among wallets that can lie on a path: reached from `src`, or able to reach
  // `dst`, within the hops left.
  const next = new Map<string, string[]>();
  for (const id of edges.keys()) {
    const [from, to] = id.split('\u0000') as [string, string];
    if (!(forward.has(from) || backward.has(from))) continue;
    if (!(forward.has(to) || backward.has(to))) continue;
    next.set(from, [...(next.get(from) ?? []), to]);
  }

  const found: FoundPath[] = [];
  let looked = 0;
  const walk = (at: string, trail: string[], bottleneck: number): void => {
    if (looked >= PATH_LIMITS.candidates) {
      truncated = true;
      return;
    }
    if (at === dst) {
      looked++;
      found.push({
        bottleneck: bottleneck / SATS_PER_FLUX,
        hops: trail.slice(1).map((to, i) => {
          const from = trail[i]!;
          const edge = edges.get(key(from, to))!;
          return {
            from,
            to,
            total: edge.sat / SATS_PER_FLUX,
            count: edge.count,
            first: edge.first,
            last: edge.last,
            internal: edge.internal
          };
        })
      });
      return;
    }
    const used = trail.length - 1;
    if (used >= maxHops || (at !== src && !passable(at))) return;
    for (const to of next.get(at) ?? []) {
      if (trail.includes(to)) continue;
      // Prune: from here `to` must still be able to reach `dst` in the hops left.
      const left = maxHops - used - 1;
      const toDst = backward.get(to);
      if (toDst === undefined ? left < Math.floor(maxHops / 2) + 1 : toDst > left) continue;
      walk(to, [...trail, to], Math.min(bottleneck, edges.get(key(at, to))!.sat));
    }
  };
  if (src !== dst) walk(src, [src], Number.POSITIVE_INFINITY);

  const paths = found
    .sort((a, b) => b.bottleneck - a.bottleneck || a.hops.length - b.hops.length)
    .slice(0, limit);

  const nodes: PathResult['nodes'] = {};
  for (const path of paths) {
    for (const address of [path.hops[0]!.from, ...path.hops.map((hop) => hop.to)]) {
      nodes[address] = { kind: labels.kindOf(address), name: labels.nameOf(address) };
    }
  }

  return {
    src,
    dst,
    maxHops,
    throughExchanges,
    paths,
    nodes,
    explored: { forward: forward.size, backward: backward.size },
    trimmed: trimmed.size,
    truncated
  };
}
