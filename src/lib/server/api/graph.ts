/**
 * The fund-flow graph (#63): wallets as nodes, aggregated transfers as edges.
 *
 * The page starts at one wallet and grows the graph a click at a time, so the unit of work is
 * a wallet's neighbourhood: its largest senders, its largest recipients, or both. `depth` > 1
 * repeats that for the unlabelled wallets found (a labelled wallet — an exchange, the
 * Foundation — is where a trail is usually meant to end, and a hub's neighbourhood is huge).
 *
 * Bounds, so one request stays well under 100 ms even on an exchange hot wallet:
 *  - each side reads at most {@link GRAPH_LIMITS.rows} of a wallet's newest flows through the
 *    `(address, height)` indexes; a busier wallet is marked `sampled`
 *  - at most `fanout` counterparties per side, largest first; the rest are counted in `more`
 *  - at most {@link GRAPH_LIMITS.nodes} nodes; `truncated` says when that stopped it
 */

import type { Db } from '../db/database.js';
import type { AddressKind } from '../ingest/datasource/types.js';
import { SATS_PER_FLUX } from '../ingest/datasource/types.js';
import type { LabelLookup } from '../labels.js';
import type { HeightWindow } from './apps.js';

export type GraphDirection = 'in' | 'out' | 'both';

export const GRAPH_LIMITS = {
  /** Newest flows read per wallet and side. */
  rows: 20_000,
  /** Counterparties per wallet and side, by default and at most. */
  fanout: 12,
  maxFanout: 50,
  /** Nodes per response. */
  nodes: 200,
  maxDepth: 3
} as const;

export interface GraphNode {
  readonly address: string;
  readonly kind: AddressKind;
  readonly name: string | null;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  /** FLUX. */
  readonly total: number;
  readonly count: number;
  readonly first: number;
  readonly last: number;
}

export interface GraphSide {
  /** Counterparties on this side that are not in `edges` (below the fan-out or the minimum). */
  readonly more: number;
  /** Only the newest {@link GRAPH_LIMITS.rows} flows were read. */
  readonly sampled: boolean;
}

export interface FlowGraph {
  readonly root: string;
  readonly direction: GraphDirection;
  readonly depth: number;
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  /** Per expanded wallet and side, what was left out. */
  readonly expanded: Record<string, { in?: GraphSide; out?: GraphSide }>;
  /** The node cap stopped the expansion. */
  readonly truncated: boolean;
}

export interface GraphOptions {
  readonly direction?: GraphDirection;
  readonly depth?: number;
  readonly fanout?: number;
  /** Edges below this many FLUX are left out. */
  readonly minAmount?: number;
}

type Column = 'from_address' | 'to_address';

export function flowGraph(
  db: Db,
  labels: LabelLookup,
  root: string,
  window: HeightWindow,
  options: GraphOptions = {}
): FlowGraph {
  const direction = options.direction ?? 'both';
  const depth = Math.min(Math.max(1, Math.trunc(options.depth ?? 1) || 1), GRAPH_LIMITS.maxDepth);
  const fanout = Math.min(
    Math.max(1, Math.trunc(options.fanout ?? GRAPH_LIMITS.fanout) || 1),
    GRAPH_LIMITS.maxFanout
  );
  const minSat = Math.max(0, options.minAmount ?? 0) * SATS_PER_FLUX;

  // The newest `rows` flows of one side, grouped by counterparty. The inner LIMIT is what
  // bounds a hub; the outer query only sorts what it returned.
  const sideQuery = (column: Column) => {
    const other: Column = column === 'to_address' ? 'from_address' : 'to_address';
    return db.prepare<
      [{ address: string; from: number; to: number; rows: number }],
      { address: string; sat: number; count: number; first: number; last: number; rows: number }
    >(
      `SELECT address, SUM(sat) AS sat, COUNT(*) AS count, MIN(time) AS first, MAX(time) AS last,
              SUM(COUNT(*)) OVER () AS rows
       FROM (SELECT ${other} AS address, sat, time FROM flows
             WHERE ${column} = @address AND height BETWEEN @from AND @to
             ORDER BY height DESC LIMIT @rows)
       WHERE address <> @address
       GROUP BY address
       ORDER BY sat DESC, address`
    );
  };
  const incoming = sideQuery('to_address');
  const outgoing = sideQuery('from_address');

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const expanded: FlowGraph['expanded'] = {};
  let truncated = false;

  const addNode = (address: string): boolean => {
    if (nodes.has(address)) return true;
    if (nodes.size >= GRAPH_LIMITS.nodes) {
      truncated = true;
      return false;
    }
    nodes.set(address, {
      address,
      kind: labels.kindOf(address),
      name: labels.nameOf(address)
    });
    return true;
  };

  const expand = (address: string, side: 'in' | 'out'): string[] => {
    const rows = (side === 'in' ? incoming : outgoing).all({
      address,
      from: window.fromHeight,
      to: window.toHeight,
      rows: GRAPH_LIMITS.rows
    });
    const found: string[] = [];
    let shown = 0;
    for (const row of rows) {
      if (shown >= fanout || row.sat < minSat || !addNode(row.address)) continue;
      shown++;
      const [from, to] = side === 'in' ? [row.address, address] : [address, row.address];
      edges.set(`${from}>${to}`, {
        from,
        to,
        total: row.sat / SATS_PER_FLUX,
        count: row.count,
        first: row.first,
        last: row.last
      });
      found.push(row.address);
    }
    expanded[address] = {
      ...expanded[address],
      [side]: { more: rows.length - shown, sampled: (rows[0]?.rows ?? 0) >= GRAPH_LIMITS.rows }
    };
    return found;
  };

  addNode(root);
  const sides: ('in' | 'out')[] = direction === 'both' ? ['in', 'out'] : [direction];
  // Each side grows away from the root: senders of senders, recipients of recipients.
  for (const side of sides) {
    let frontier = [root];
    for (let level = 1; level <= depth && frontier.length > 0; level++) {
      const next: string[] = [];
      for (const address of frontier) {
        if (expanded[address]?.[side]) continue;
        next.push(...expand(address, side));
      }
      frontier = next.filter((address) => labels.kindOf(address) === 'unknown');
    }
  }

  return {
    root,
    direction,
    depth,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    expanded,
    truncated
  };
}
