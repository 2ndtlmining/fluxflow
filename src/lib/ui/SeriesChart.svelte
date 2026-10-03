<!--
  Net flow over time (#29): withdrawals as cyan columns above the axis, deposits as amber
  columns below it, on the same balance axis as the rest of the page, turned upright.
  Plain SVG: a few hundred buckets at most, so no charting library is needed.
-->
<script lang="ts">
  import { formatFlux, formatFluxFull, formatTime } from '$lib/client/format';
  import type { SeriesPoint } from '$lib/client/pending';

  interface Props {
    points: SeriesPoint[];
  }

  let { points }: Props = $props();

  const WIDTH = 1000;
  const HEIGHT = 240;
  const MID = HEIGHT / 2;

  const scale = $derived(Math.max(1, ...points.flatMap((p) => [p.buying, p.selling])));
  const step = $derived(WIDTH / Math.max(points.length, 1));
  const column = $derived(Math.max(1, step * 0.72));
  const totals = $derived(
    points.reduce(
      (sum, p) => ({ buying: sum.buying + p.buying, selling: sum.selling + p.selling }),
      { buying: 0, selling: 0 }
    )
  );
  let active = $state<number | null>(null);
</script>

<figure>
  <svg
    viewBox="0 0 {WIDTH} {HEIGHT}"
    preserveAspectRatio="none"
    role="img"
    aria-label="Withdrawals and deposits per period bucket: {formatFluxFull(
      totals.buying
    )} FLUX withdrawn, {formatFluxFull(totals.selling)} FLUX deposited"
  >
    {#each points as point, i (point.t)}
      {@const x = i * step + (step - column) / 2}
      {@const up = (point.buying / scale) * (MID - 4)}
      {@const down = (point.selling / scale) * (MID - 4)}
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
  </svg>
  <figcaption>
    {#if active !== null && points[active]}
      {@const p = points[active]}
      <span>{formatTime(p.t)}</span>
      <span class="buy">{formatFlux(p.buying)} withdrawn</span>
      <span class="sell">{formatFlux(p.selling)} deposited</span>
    {:else}
      <span class="muted">Hover a column for its totals.</span>
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
