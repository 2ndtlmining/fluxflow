import { describe, expect, it } from 'vitest';
import { emptyGraph, layout, merge, remove, MAX_NODES } from './graph';
import type { FlowGraph, GraphEdge, GraphNode } from './types';

const node = (address: string, kind: GraphNode['kind'] = 'unknown'): GraphNode => ({
  address,
  kind,
  name: null
});
const edge = (from: string, to: string, total = 1): GraphEdge => ({
  from,
  to,
  total,
  count: 1,
  first: 0,
  last: 0
});
const answer = (root: string, nodes: string[], edges: GraphEdge[]): FlowGraph => ({
  root,
  direction: 'both',
  depth: 1,
  nodes: nodes.map((address) => node(address)),
  edges,
  expanded: { [root]: { in: { more: 0, sampled: false }, out: { more: 0, sampled: false } } },
  truncated: false
});

describe('fund-flow graph state', () => {
  const start = () =>
    merge(
      emptyGraph(node('root')),
      answer(
        'root',
        ['root', 'a', 'b', 'x'],
        [edge('a', 'root', 5), edge('b', 'root', 3), edge('root', 'x')]
      )
    );

  it('puts senders left of the root and recipients right, largest first', () => {
    const graph = start();
    expect(graph.nodes.get('a')).toMatchObject({ column: -1, row: 0 });
    expect(graph.nodes.get('b')).toMatchObject({ column: -1, row: 1 });
    expect(graph.nodes.get('x')).toMatchObject({ column: 1, row: 0 });
    expect(graph.edges.size).toBe(3);
    expect(graph.expanded.get('root')).toBeDefined();
  });

  it('grows away from the wallet expanded, and never moves what is placed', () => {
    const graph = merge(start(), answer('a', ['a', 'f', 'x'], [edge('f', 'a'), edge('x', 'a')]));
    expect(graph.nodes.get('f')).toMatchObject({ column: -2 });
    // x was already placed as a recipient: it stays, and the new edge points back to it.
    expect(graph.nodes.get('x')).toMatchObject({ column: 1 });
    expect(graph.edges.has('x>a')).toBe(true);
  });

  it('places a deeper answer level by level', () => {
    const graph = merge(
      emptyGraph(node('root')),
      answer('root', ['root', 'a', 'f'], [edge('f', 'a'), edge('a', 'root')])
    );
    expect(graph.nodes.get('a')!.column).toBe(-1);
    expect(graph.nodes.get('f')!.column).toBe(-2);
  });

  it('removes a wallet and whatever hung off it, but never the root', () => {
    const grown = merge(start(), answer('a', ['a', 'f'], [edge('f', 'a')]));
    const graph = remove(grown, 'a');
    expect([...graph.nodes.keys()].sort()).toEqual(['b', 'root', 'x']);
    expect([...graph.edges.keys()].sort()).toEqual(['b>root', 'root>x']);
    expect(remove(graph, 'root')).toBe(graph);
  });

  it('stops placing at the node cap', () => {
    const many = Array.from({ length: MAX_NODES + 5 }, (_, i) => `s${i}`);
    const graph = merge(
      emptyGraph(node('root')),
      answer(
        'root',
        ['root', ...many],
        many.map((s) => edge(s, 'root'))
      )
    );
    expect(graph.nodes.size).toBe(MAX_NODES);
    expect(graph.edges.size).toBe(MAX_NODES - 1);
  });

  it('lays columns out left to right and centres each column', () => {
    const graph = start();
    const size = { columnWidth: 100, rowHeight: 10, nodeWidth: 50, nodeHeight: 8, pad: 0 };
    const at = layout(graph.nodes.values(), size);
    const pos = (address: string) => {
      const placed = graph.nodes.get(address)!;
      return [at.x(placed), at.y(placed)];
    };
    expect(pos('a')).toEqual([0, 0]);
    expect(pos('b')).toEqual([0, 10]);
    expect(pos('root')).toEqual([100, 5]);
    expect(pos('x')).toEqual([200, 5]);
    expect(at.width).toBe(250);
    expect(at.height).toBe(18);
  });
});
