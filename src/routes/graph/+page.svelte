<!--
  Fund-flow graph (#63): follow money visually, a click at a time.

  The wallet in `?root=` sits in the middle with its largest senders on the left and its
  largest recipients on the right. The + on a wallet's left shows who paid it; the + on its
  right shows who it paid. Each line is every transfer between two wallets in the period,
  thicker for more FLUX. The period and minimum amount live in the URL; expansions do not,
  but a view can be saved as a case (#69), and `?expand=address:in,address:out,…` replays
  expansions in order when the graph loads — that is how a saved case reopens.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { isAbort } from '$lib/client/api';
  import { createCase, fetchGraph, isAddress } from '$lib/client/endpoints';
  import { formatCount, formatFlux, formatTime, kindLabel, shortAddress } from '$lib/client/format';
  import {
    MAX_NODES,
    emptyGraph,
    layout,
    merge,
    remove,
    type GraphState,
    type PlacedNode
  } from '$lib/client/graph';
  import type { GraphEdge } from '$lib/client/types';
  import { PERIOD_IDS, PERIOD_LABELS, isPeriodId, type PeriodId } from '$lib/shared/constants';

  const SIZE = { columnWidth: 280, rowHeight: 64, nodeWidth: 200, nodeHeight: 46, pad: 24 };
  const KINDS = ['foundation', 'exchange', 'node_operator', 'app_hosting', 'unknown'] as const;

  const root = $derived(
    page.url.searchParams.get('root') ?? page.url.searchParams.get('address') ?? ''
  );
  const period = $derived.by((): PeriodId | null => {
    const raw = (page.url.searchParams.get('period') ?? '').toUpperCase();
    return isPeriodId(raw) ? raw : null;
  });
  const minAmount = $derived(Math.max(0, Number(page.url.searchParams.get('min')) || 0));

  let graph = $state<GraphState | null>(null);
  let selected = $state<string | null>(null);
  let pending = $state<string[]>([]);
  /** Expansions made so far, in order: what a saved case replays. */
  let expansions = $state<string[]>([]);
  let error = $state<string | null>(null);
  let minInput = $state('');

  $effect(() => {
    minInput = minAmount > 0 ? String(minAmount) : '';
  });

  // A new root, period or minimum starts the graph again.
  $effect(() => {
    const address = root;
    const query = { period, minAmount };
    if (!isAddress(address)) return;
    const controller = new AbortController();
    graph = null;
    selected = address;
    error = null;
    expansions = [];

    fetchGraph({ address, direction: 'both', ...query }, controller.signal)
      .then(async (response) => {
        if (controller.signal.aborted) return;
        const node = response.nodes.find((n) => n.address === address);
        graph = merge(emptyGraph(node ?? { address, kind: 'unknown', name: null }), response);

        // Replay a saved view's expansions, one after another (#69).
        const replay = (page.url.searchParams.get('expand') ?? '')
          .split(',')
          .map((key) => key.split(':'))
          .filter(
            (parts): parts is [string, 'in' | 'out'] =>
              parts.length === 2 &&
              isAddress(parts[0]!) &&
              (parts[1] === 'in' || parts[1] === 'out')
          );
        for (const [wallet, side] of replay) {
          if (controller.signal.aborted) return;
          await expand(wallet, side);
        }
      })
      .catch((reason: unknown) => {
        if (!isAbort(reason)) error = (reason as Error).message;
      });

    return () => controller.abort();
  });

  async function expand(address: string, side: 'in' | 'out'): Promise<void> {
    const key = `${address}:${side}`;
    if (pending.includes(key)) return;
    pending = [...pending, key];
    try {
      const response = await fetchGraph({ address, direction: side, period, minAmount });
      if (graph && graph.root === root) {
        graph = merge(graph, response);
        if (!expansions.includes(key)) expansions = [...expansions, key];
      }
      error = null;
    } catch (reason) {
      if (!isAbort(reason)) error = (reason as Error).message;
    } finally {
      pending = pending.filter((entry) => entry !== key);
    }
  }

  // Save the view as a case (#69): its wallets and how to rebuild it.
  let saving = $state(false);
  let caseName = $state('');

  async function saveCase(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!graph) return;
    const name = caseName.trim() || `Trail from ${label(graph.nodes.get(graph.root)!)}`;
    try {
      const { id } = await createCase({
        name,
        addresses: [...graph.nodes.keys()],
        graph: { root: graph.root, period: period ?? null, min: minAmount, expand: expansions }
      });
      await goto(`/cases/${id}`);
    } catch (reason) {
      error = (reason as Error).message;
    }
  }

  function hide(address: string): void {
    if (!graph) return;
    graph = remove(graph, address);
    if (selected && !graph.nodes.has(selected)) selected = graph.root;
  }

  function setQuery(changes: Record<string, string | null>): void {
    const params = new URLSearchParams(page.url.searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    void goto(`/graph?${params.toString()}`, { keepFocus: true, noScroll: true });
  }

  const nodes = $derived(graph ? [...graph.nodes.values()] : []);
  const edges = $derived(graph ? [...graph.edges.values()] : []);
  const at = $derived(layout(nodes, SIZE));
  const biggest = $derived(Math.max(1, ...edges.map((edge) => edge.total)));
  const full = $derived(nodes.length >= MAX_NODES);

  const placed = (address: string) => graph?.nodes.get(address);
  const label = (node: { address: string; name: string | null }) =>
    node.name ?? shortAddress(node.address);
  const width = (edge: GraphEdge) => 1.5 + 8 * Math.sqrt(edge.total / biggest);

  /**
   * A curve from the right of the sender to the left of the recipient. Lines never cross a
   * wallet: one within a column loops out into the gap on its right, and money flowing back
   * leftwards goes down the gap, along the bottom and up into the recipient's left side.
   */
  function path(edge: GraphEdge): string {
    const from = placed(edge.from);
    const to = placed(edge.to);
    if (!from || !to) return '';
    const x1 = at.x(from) + SIZE.nodeWidth;
    const y1 = at.y(from) + SIZE.nodeHeight / 2;
    const x2 = at.x(to);
    const y2 = at.y(to) + SIZE.nodeHeight / 2;
    if (x2 > x1) {
      const bend = (x2 - x1) / 2;
      return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
    }
    const gap = (SIZE.columnWidth - SIZE.nodeWidth) / 2;
    if (from.column === to.column) {
      return `M ${x1} ${y1} C ${x1 + gap} ${y1}, ${x1 + gap} ${y2}, ${x1} ${y2}`;
    }
    const bottom = at.height + 20;
    return (
      `M ${x1} ${y1} C ${x1 + gap} ${y1}, ${x1 + gap} ${bottom}, ${x1} ${bottom} ` +
      `L ${x2} ${bottom} C ${x2 - gap} ${bottom}, ${x2 - gap} ${y2}, ${x2} ${y2}`
    );
  }

  const edgeText = (edge: GraphEdge) => {
    const from = placed(edge.from);
    const to = placed(edge.to);
    const dates =
      edge.first === edge.last
        ? formatTime(edge.first)
        : `${formatTime(edge.first)} to ${formatTime(edge.last)}`;
    return `${from ? label(from) : edge.from} to ${to ? label(to) : edge.to}: ${formatFlux(
      edge.total
    )} FLUX in ${formatCount(edge.count)} ${edge.count === 1 ? 'transfer' : 'transfers'}, ${dates}`;
  };

  const touches = (edge: GraphEdge, address: string | null) =>
    address !== null && (edge.from === address || edge.to === address);

  const detail = $derived.by(() => {
    if (!graph || !selected) return null;
    const node = graph.nodes.get(selected);
    if (!node) return null;
    const incoming = edges.filter((edge) => edge.to === node.address);
    const outgoing = edges.filter((edge) => edge.from === node.address);
    return {
      node,
      sides: graph.expanded.get(node.address) ?? {},
      incoming: incoming.reduce((sum, edge) => sum + edge.total, 0),
      outgoing: outgoing.reduce((sum, edge) => sum + edge.total, 0)
    };
  });

  function onKey(event: KeyboardEvent, action: () => void): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      action();
    }
  }

  const canExpand = (node: PlacedNode, side: 'in' | 'out') =>
    !full && !graph?.expanded.get(node.address)?.[side];
</script>

<svelte:head>
  <title>Follow the money | FluxFlow</title>
</svelte:head>

<article class="graph-page">
  <p>
    {#if isAddress(root)}<a href="/wallet/{root}">Back to the wallet</a> ·{/if}
    <a href="/">Dashboard</a>
  </p>
  <h1>Follow the money</h1>

  {#if !isAddress(root)}
    <p class="muted">
      Open a wallet and choose <strong>Follow the money</strong>, or add <code>?root=</code> and a FLUX
      address to this page's link.
    </p>
  {:else}
    <form class="toolbar" onsubmit={(event) => event.preventDefault()}>
      <label>
        Period
        <select
          value={period ?? ''}
          onchange={(event) => setQuery({ period: event.currentTarget.value || null })}
        >
          <option value="">All stored history</option>
          {#each PERIOD_IDS as id (id)}
            <option value={id}>{PERIOD_LABELS[id]}</option>
          {/each}
        </select>
      </label>
      <label>
        Hide lines under (FLUX)
        <input
          type="number"
          min="0"
          step="any"
          inputmode="decimal"
          bind:value={minInput}
          onchange={() => setQuery({ min: Number(minInput) > 0 ? String(Number(minInput)) : null })}
        />
      </label>
      <button
        type="button"
        class="button"
        onclick={() => setQuery({ period: null, min: null, expand: null })}
      >
        Start again
      </button>
      <ul class="legend" aria-label="Colours">
        {#each KINDS as kind (kind)}
          <li><span class="swatch k-{kind}" aria-hidden="true"></span>{kindLabel(kind)}</li>
        {/each}
      </ul>
    </form>

    {#if graph}
      {#if saving}
        <form class="save" onsubmit={saveCase}>
          <label>
            <span class="visually-hidden">Case name</span>
            <input
              bind:value={caseName}
              placeholder="Name the case, e.g. Flux paying for its own apps"
              maxlength="120"
            />
          </label>
          <button type="submit" class="button">Save {graph.nodes.size} wallets as a case</button>
          <button type="button" class="link" onclick={() => (saving = false)}>Cancel</button>
        </form>
      {:else}
        <p>
          <button type="button" class="link" onclick={() => (saving = true)}>Save as a case…</button
          >
        </p>
      {/if}
    {/if}

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    <p class="muted small help">
      Money flows left to right. Click <strong>+</strong> on a wallet's left to show who paid it, or
      on its right to show who it paid. Click a wallet for details. Each line is every transfer
      between two wallets{period ? ` in the last ${PERIOD_LABELS[period].toLowerCase()}` : ''}; the
      thicker, the more FLUX. Hover a line for amounts and dates.
    </p>

    {#if !graph}
      <p class="muted" aria-busy="true">Loading…</p>
    {:else}
      <div class="layout">
        <div class="canvas" role="region" aria-label="Fund-flow graph" tabindex="-1">
          <svg width={at.width} height={at.height + 60} viewBox="0 0 {at.width} {at.height + 60}">
            <defs>
              <marker
                id="arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerUnits="userSpaceOnUse"
                markerWidth="10"
                markerHeight="10"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" class="arrow-head" />
              </marker>
            </defs>

            {#each edges as edge (`${edge.from}>${edge.to}`)}
              <g class="edge" class:lit={touches(edge, selected)}>
                <path
                  d={path(edge)}
                  class="line"
                  stroke-width={width(edge)}
                  marker-end="url(#arrow)"
                ></path>
                <path d={path(edge)} class="hit"><title>{edgeText(edge)}</title></path>
              </g>
            {/each}

            {#each nodes as node (node.address)}
              {@const x = at.x(node)}
              {@const y = at.y(node)}
              {@const second = `${kindLabel(node.kind)}${node.name ? ` · ${shortAddress(node.address, 4)}` : ''}`}
              <g
                class="node k-{node.kind}"
                class:root={node.address === graph.root}
                class:selected={node.address === selected}
                transform="translate({x} {y})"
                role="button"
                tabindex="0"
                aria-label="{label(node)}, {second}"
                aria-pressed={node.address === selected}
                onclick={() => (selected = node.address)}
                onkeydown={(event) => onKey(event, () => (selected = node.address))}
              >
                <rect class="box" width={SIZE.nodeWidth} height={SIZE.nodeHeight} rx="8"></rect>
                <rect class="accent" width="6" height={SIZE.nodeHeight} rx="3"></rect>
                <!-- The label says what the two lines show, word for word (#33: voice control), so
                     the drawn text and the full-address tooltip are hidden from assistive tech
                     rather than read a second time. -->
                <text x="16" y="19" class="name" class:mono={!node.name} aria-hidden="true"
                  >{label(node)}</text
                >
                <text x="16" y="36" class="kind" aria-hidden="true">{second}</text>
                <title aria-hidden="true">{node.address}</title>
              </g>
              {#each [{ side: 'in', cx: x, text: 'Show who paid' }, { side: 'out', cx: x + SIZE.nodeWidth, text: 'Show who it paid' }] as handle (handle.side)}
                {@const side = handle.side as 'in' | 'out'}
                {#if canExpand(node, side)}
                  <g
                    class="handle"
                    class:busy={pending.includes(`${node.address}:${side}`)}
                    transform="translate({handle.cx} {y + SIZE.nodeHeight / 2})"
                    role="button"
                    tabindex="0"
                    aria-label="{handle.text} {label(node)}"
                    onclick={() => expand(node.address, side)}
                    onkeydown={(event) => onKey(event, () => expand(node.address, side))}
                  >
                    <circle r="10"></circle>
                    <!-- An icon: the label names the action (#33). -->
                    <text y="4" text-anchor="middle" aria-hidden="true">+</text>
                    <title aria-hidden="true">{handle.text} {label(node)}</title>
                  </g>
                {/if}
              {/each}
            {/each}
          </svg>
        </div>

        {#if detail}
          <section class="detail" aria-live="polite" aria-label="Selected wallet">
            <h2>
              {#if detail.node.name}{detail.node.name}{:else}<span class="mono"
                  >{shortAddress(detail.node.address)}</span
                >{/if}
            </h2>
            <p class="muted small">
              {kindLabel(detail.node.kind)}{detail.node.address === graph.root ? ' · start' : ''}
            </p>
            <p class="mono small address">{detail.node.address}</p>
            <dl>
              <div>
                <dt>Paid in, shown</dt>
                <dd>{formatFlux(detail.incoming)} FLUX</dd>
              </div>
              <div>
                <dt>Paid out, shown</dt>
                <dd>{formatFlux(detail.outgoing)} FLUX</dd>
              </div>
            </dl>
            {#each [{ side: 'in', who: 'senders' }, { side: 'out', who: 'recipients' }] as row (row.side)}
              {@const info = detail.sides[row.side as 'in' | 'out']}
              {#if info && (info.more > 0 || info.sampled)}
                <p class="muted small">
                  {#if info.more > 0}{formatCount(info.more)} smaller {row.who} not shown.{/if}
                  {#if info.sampled}Very busy wallet: only its newest 20,000 transfers were read.{/if}
                </p>
              {/if}
            {/each}
            <div class="actions">
              {#if canExpand(detail.node, 'in')}
                <button
                  type="button"
                  class="button"
                  onclick={() => expand(detail.node.address, 'in')}
                >
                  Show who paid it
                </button>
              {/if}
              {#if canExpand(detail.node, 'out')}
                <button
                  type="button"
                  class="button"
                  onclick={() => expand(detail.node.address, 'out')}
                >
                  Show who it paid
                </button>
              {/if}
              <a class="button" href="/wallet/{detail.node.address}">Open wallet</a>
              {#if detail.node.address !== graph.root}
                <button
                  type="button"
                  class="button"
                  onclick={() => setQuery({ root: detail.node.address })}
                >
                  Start from here
                </button>
                <button type="button" class="button" onclick={() => hide(detail.node.address)}>
                  Hide
                </button>
              {/if}
            </div>
          </section>
        {/if}
      </div>

      {#if full}
        <p class="muted small">
          The graph shows {MAX_NODES} wallets, its limit. Hide some, or start again from one of them.
        </p>
      {/if}
    {/if}
  {/if}
</article>

<style>
  .graph-page {
    display: grid;
    gap: 1rem;
  }

  h1 {
    margin: 0;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.75rem 1.25rem;
  }

  .toolbar label {
    display: grid;
    gap: 0.2rem;
    font-size: var(--step--1);
    color: var(--text-muted);
  }

  select,
  input {
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    color: var(--text);
    font: inherit;
  }

  input {
    width: 8rem;
  }

  .button {
    display: inline-block;
    padding: 0.45rem 0.8rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    text-decoration: none;
    cursor: pointer;
  }

  .button:hover {
    border-color: var(--brand);
  }

  .save {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
    align-items: center;
  }

  .save label {
    flex: 1 1 20rem;
    display: grid;
  }

  .save input {
    min-height: 2.5rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
  }

  .link {
    min-height: 24px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--brand);
    text-decoration: underline;
    cursor: pointer;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 1rem;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--step--1);
  }

  .legend li {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .swatch {
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 2px;
    background: var(--kind);
  }

  .help {
    margin: 0;
  }

  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 18rem;
    gap: 1rem;
    align-items: start;
  }

  @media (max-width: 52rem) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .canvas {
    overflow: auto;
    max-height: 75vh;
    border: 1px solid var(--line);
    border-radius: var(--radius-m);
    background: var(--bg);
  }

  svg {
    display: block;
  }

  .k-foundation {
    --kind: var(--brand);
  }

  .k-exchange {
    --kind: var(--sell);
  }

  .k-node_operator {
    --kind: var(--buy);
  }

  .k-app_hosting {
    --kind: var(--good);
  }

  .k-unknown {
    --kind: var(--text-muted);
  }

  .edge .line {
    fill: none;
    stroke: var(--text-muted);
    stroke-opacity: 0.45;
  }

  .edge.lit .line {
    stroke: var(--brand);
    stroke-opacity: 0.9;
  }

  .edge .hit {
    fill: none;
    stroke: transparent;
    stroke-width: 14;
    pointer-events: stroke;
  }

  .edge:hover .line {
    stroke-opacity: 1;
  }

  .arrow-head {
    fill: var(--text-muted);
  }

  .node {
    cursor: pointer;
    outline: none;
  }

  .node .box {
    fill: var(--surface);
    stroke: var(--line);
    stroke-width: 1;
  }

  .node .accent {
    fill: var(--kind);
  }

  .node.root .box {
    stroke: var(--kind);
    stroke-width: 2;
  }

  .node.selected .box,
  .node:focus-visible .box {
    stroke: var(--focus);
    stroke-width: 3;
  }

  .node .name {
    fill: var(--text);
    font-size: 13px;
    font-weight: 500;
  }

  .node .kind {
    fill: var(--text-muted);
    font-size: 11px;
  }

  .handle {
    cursor: pointer;
    outline: none;
  }

  .handle circle {
    fill: var(--surface);
    stroke: var(--brand);
    stroke-width: 1.5;
  }

  .handle text {
    fill: var(--brand);
    font-size: 15px;
    font-weight: 600;
    pointer-events: none;
  }

  .handle:hover circle,
  .handle:focus-visible circle {
    fill: var(--brand);
  }

  .handle:hover text,
  .handle:focus-visible text {
    fill: var(--surface);
  }

  .handle.busy {
    opacity: 0.4;
  }

  .detail {
    display: grid;
    gap: 0.4rem;
    padding: 1rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-m);
    background: var(--surface);
  }

  .detail h2 {
    margin: 0;
    font-size: var(--step-1);
    overflow-wrap: anywhere;
  }

  .detail p {
    margin: 0;
  }

  .address {
    overflow-wrap: anywhere;
  }

  dl {
    display: grid;
    gap: 0.25rem;
    margin: 0.25rem 0;
  }

  dl div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }

  dt {
    color: var(--text-muted);
    font-size: var(--step--1);
  }

  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 0.4rem;
  }

  .small {
    font-size: var(--step--1);
  }

  .error {
    color: var(--bad);
  }
</style>
