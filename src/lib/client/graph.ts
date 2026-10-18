/**
 * The fund-flow graph's state and layout (#63), kept out of the page so it can be tested.
 *
 * Money reads left to right: the root wallet is column 0, its senders column -1, their
 * senders -2, its recipients +1 and so on. A wallet keeps the column it was first placed in,
 * so expanding never moves what is already on screen sideways; within a column, wallets are
 * stacked in the order they arrived, which is largest first for each expansion.
 */

import type { FlowGraph, GraphEdge, GraphNode, GraphSide } from './types';

/** Nodes the page will show before it stops offering to expand. */
export const MAX_NODES = 200;

export interface PlacedNode extends GraphNode {
  readonly column: number;
  /** Order within its column. */
  readonly row: number;
}

export interface GraphState {
  readonly root: string;
  readonly nodes: ReadonlyMap<string, PlacedNode>;
  readonly edges: ReadonlyMap<string, GraphEdge>;
  /** Sides already expanded, and what each left out. */
  readonly expanded: ReadonlyMap<string, { in?: GraphSide; out?: GraphSide }>;
}

export const edgeKey = (edge: { from: string; to: string }) => `${edge.from}>${edge.to}`;

export function emptyGraph(root: GraphNode): GraphState {
  return {
    root: root.address,
    nodes: new Map([[root.address, { ...root, column: 0, row: 0 }]]),
    edges: new Map(),
    expanded: new Map()
  };
}

/**
 * Add an `/api/graph` answer to the graph. A new sender goes one column left of the wallet
 * it paid, a new recipient one column right of the wallet that paid it.
 */
export function merge(state: GraphState, response: FlowGraph): GraphState {
  const nodes = new Map(state.nodes);
  const edges = new Map(state.edges);
  const expanded = new Map(state.expanded);
  const byAddress = new Map(response.nodes.map((node) => [node.address, node]));
  const rows = new Map<number, number>();
  for (const node of nodes.values()) {
    rows.set(node.column, Math.max(rows.get(node.column) ?? 0, node.row + 1));
  }
  const place = (address: string, column: number) => {
    if (nodes.has(address) || nodes.size >= MAX_NODES) return;
    const node = byAddress.get(address);
    if (!node) return;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    nodes.set(address, { ...node, column, row });
  };

  // Edges come largest first per side; walking them in order places wallets in that order.
  // Repeat until nothing new is placed, so a deeper answer (depth > 1) is placed too.
  for (let placed = true; placed;) {
    placed = false;
    for (const edge of response.edges) {
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      if (from && !to) {
        place(edge.to, from.column + 1);
        placed ||= nodes.has(edge.to);
      } else if (to && !from) {
        place(edge.from, to.column - 1);
        placed ||= nodes.has(edge.from);
      }
    }
  }

  for (const edge of response.edges) {
    if (nodes.has(edge.from) && nodes.has(edge.to)) edges.set(edgeKey(edge), edge);
  }
  for (const [address, sides] of Object.entries(response.expanded)) {
    expanded.set(address, { ...expanded.get(address), ...sides });
  }
  return { root: state.root, nodes, edges, expanded };
}

/**
 * Take a wallet off the graph with its edges, and anything that was only connected through it.
 * The root stays.
 */
export function remove(state: GraphState, address: string): GraphState {
  if (address === state.root || !state.nodes.has(address)) return state;
  const edges = new Map(
    [...state.edges].filter(([, edge]) => edge.from !== address && edge.to !== address)
  );

  // Keep what can still be reached from the root.
  const linked = new Map<string, string[]>();
  for (const edge of edges.values()) {
    linked.set(edge.from, [...(linked.get(edge.from) ?? []), edge.to]);
    linked.set(edge.to, [...(linked.get(edge.to) ?? []), edge.from]);
  }
  const keep = new Set([state.root]);
  for (const queue = [state.root]; queue.length > 0;) {
    for (const next of linked.get(queue.pop()!) ?? []) {
      if (!keep.has(next)) {
        keep.add(next);
        queue.push(next);
      }
    }
  }

  return {
    root: state.root,
    nodes: new Map([...state.nodes].filter(([key]) => keep.has(key))),
    edges: new Map([...edges].filter(([, edge]) => keep.has(edge.from) && keep.has(edge.to))),
    expanded: new Map([...state.expanded].filter(([key]) => keep.has(key)))
  };
}

export interface Layout {
  readonly x: (node: PlacedNode) => number;
  readonly y: (node: PlacedNode) => number;
  readonly width: number;
  readonly height: number;
}

/** Pixel positions: columns `columnWidth` apart, rows `rowHeight` apart, each column centred. */
export function layout(
  nodes: Iterable<PlacedNode>,
  size: {
    columnWidth: number;
    rowHeight: number;
    nodeWidth: number;
    nodeHeight: number;
    pad: number;
  }
): Layout {
  const list = [...nodes];
  const columns = list.map((node) => node.column);
  const minColumn = Math.min(0, ...columns);
  const maxColumn = Math.max(0, ...columns);
  const perColumn = new Map<number, number>();
  for (const node of list) perColumn.set(node.column, (perColumn.get(node.column) ?? 0) + 1);
  // Rows by rank within the column, so a removed wallet leaves no gap.
  const rank = new Map<string, number>();
  for (const column of perColumn.keys()) {
    list
      .filter((node) => node.column === column)
      .sort((a, b) => a.row - b.row)
      .forEach((node, index) => rank.set(node.address, index));
  }
  const tallest = Math.max(1, ...perColumn.values());
  const height = (tallest - 1) * size.rowHeight + size.nodeHeight + 2 * size.pad;

  return {
    x: (node) => size.pad + (node.column - minColumn) * size.columnWidth,
    y: (node) => {
      const count = perColumn.get(node.column) ?? 1;
      const offset = ((tallest - count) * size.rowHeight) / 2;
      return size.pad + offset + (rank.get(node.address) ?? node.row) * size.rowHeight;
    },
    width: (maxColumn - minColumn) * size.columnWidth + size.nodeWidth + 2 * size.pad,
    height
  };
}
