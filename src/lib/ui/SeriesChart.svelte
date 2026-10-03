<!--
  Net flow over time (#29): the page's balance axis turned upright. Withdrawals are cyan
  columns above the line, deposits amber columns below it, and the running net is drawn
  across them, so a steady build-up of selling or buying is visible at a glance.
  Plain SVG: at most a few hundred buckets, so no charting library is needed.
-->
<script lang="ts">
  import { formatFlux, formatFluxFull, formatSigned } from '$lib/client/format';

  interface Point {
    readonly time: number;
    readonly buying: number;
    readonly selling: number;
    readonly cumulativeNet?: number;
  }

  interface Props {
    points: Point[];
    /** Bucket width; daily buckets are labelled by date, hourly by time. */
    bucketSeconds: number;
    /** Draw the running net line. Off for a single wallet, where it adds little. */
    showNet?: boolean;
    label?: string;
  }

  let { points, bucketSeconds, showNet = true, label = 'Net flow over time' }: Props = $props();

  const WIDTH = 1000;
  const HEIGHT = 240;
  const MID = HEIGHT / 2;
  const PAD = 6;

  const scale = $derived(Math.max(1, ...points.flatMap((p) => [p.buying, p.selling])));
  const step = $derived(WIDTH / Math.max(points.length, 1));
  const column = $derived(Math.max(1, step * 0.72));
  const totals = $derived(
    points.reduce(
      (sum, p) => ({ buying: sum.buying + p.buying, selling: sum.selling + p.selling }),
      { buying: 0, selling: 0 }
    )
  );
  const netScale = $derived(Math.max(1, ...points.map((p) => Math.abs(p.cumulativeNet ?? 0))));
  const netLine = $derived(
    points
      .map((p, i) => {
        const x = i * step + step / 2;
        const y = MID - ((p.cumulativeNet ?? 0) / netScale) * (MID - PAD);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ')
  );
  const final = $derived(points.at(-1)?.cumulativeNet ?? 0);

  let active = $state<number | null>(null);

  function bucketLabel(time: number): string {
    const date = new Date(time * 1000);
    return bucketSeconds >= 86_400
      ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : date.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
</script>

<figure>
  <svg
    viewBox="0 0 {WIDTH} {HEIGHT}"
    preserveAspectRatio="none"
    role="img"
    aria-label="{label}: {formatFluxFull(totals.buying)} FLUX withdrawn and {formatFluxFull(
      totals.selling
    )} FLUX deposited across {points.length} {bucketSeconds >= 86_400 ? 'days' : 'hours'}"
  >
    {#each points as point, i (point.time)}
      {@const x = i * step + (step - column) / 2}
      {@const up = (point.buying / scale) * (MID - PAD)}
      {@const down = (point.selling / scale) * (MID - PAD)}
      <!-- Hover only reveals per-bucket totals; the chart's label carries the totals for assistive tech. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <g
        class:dim={active !== null && active !== i}
        onpointerenter={() => (active = i)}
        onpointerleave={() => (active = null)}
      >
        <rect x={i * step} y="0" width={step} height={HEIGHT} fill="transparent" />
        <rect class="buy-col" {x} y={MID - up} width={column} height={up} />
        <rect class="sell-col" {x} y={MID} width={column} height={down} />
      </g>
    {/each}
    <line x1="0" x2={WIDTH} y1={MID} y2={MID} class="zero" />
    {#if showNet && points.length > 1}
      <polyline points={netLine} class="net" />
    {/if}
  </svg>
  <figcaption>
    {#if active !== null && points[active]}
      {@const p = points[active]}
      <span>{bucketLabel(p.time)}</span>
      <span class="buy">{formatFlux(p.buying)} withdrawn</span>
      <span class="sell">{formatFlux(p.selling)} deposited</span>
      {#if showNet && p.cumulativeNet !== undefined}
        <span>running net {formatSigned(p.cumulativeNet)}</span>
      {/if}
    {:else}
      <span class="muted">
        {#if showNet}
          The line is the running net, ending at {formatSigned(final)} FLUX.
        {/if}
        Hover a column for its totals.
      </span>
    {/if}
  </figcaption>
</figure>

<style>
  figure {
    margin: 0;
    display: grid;
    gap: 0.5rem;
  }

  svg {
    width: 100%;
    height: 14rem;
    display: block;
  }

  .buy-col {
    fill: var(--buy);
  }

  .sell-col {
    fill: var(--sell);
  }

  .zero {
    stroke: var(--text);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }

  .net {
    fill: none;
    stroke: var(--brand);
    stroke-width: 2.5;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
  }

  .dim {
    opacity: 0.45;
  }

  figcaption {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    font-size: var(--step--1);
    min-height: 1.5em;
  }
</style>
