<!--
  A stacked bar of amounts by wallet kind: where a payer's money came from, or who paid.

  `mix` may hold FLUX or fractions; shares are taken of its own sum. With `legend={false}` the
  bar alone is shown (for table cells), and the breakdown is in its accessible label. With
  `keyOnly` only the colour key is shown, for a column of such bars.
-->
<script lang="ts">
  import { formatFlux, kindLabel } from '$lib/client/format';
  import type { AddressKind, KindMix } from '$lib/client/types';

  let {
    mix = {},
    legend = true,
    fractions = false,
    keyOnly = false
  }: { mix?: KindMix; legend?: boolean; fractions?: boolean; keyOnly?: boolean } = $props();

  // Fixed order, so bars in a table line up kind by kind.
  const ORDER: AddressKind[] = [
    'foundation',
    'exchange',
    'node_operator',
    'app_hosting',
    'unknown'
  ];

  const segments = $derived.by(() => {
    const sum = ORDER.reduce((total, kind) => total + (mix[kind] ?? 0), 0);
    if (sum <= 0) return [];
    return ORDER.filter((kind) => (mix[kind] ?? 0) > 0).map((kind) => ({
      kind,
      amount: mix[kind] ?? 0,
      share: (mix[kind] ?? 0) / sum
    }));
  });

  const percent = (share: number) =>
    share > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`;
  const text = $derived(segments.map((s) => `${kindLabel(s.kind)} ${percent(s.share)}`).join(', '));
</script>

{#if keyOnly}
  <ul class="legend">
    {#each ORDER as kind (kind)}
      <li><span class="swatch {kind}" aria-hidden="true"></span>{kindLabel(kind)}</li>
    {/each}
  </ul>
{:else if segments.length === 0}
  <span class="muted small">No stored inflows</span>
{:else}
  <div class="bar" class:thin={!legend} role="img" aria-label={text} title={text}>
    {#each segments as segment (segment.kind)}
      <span class="seg {segment.kind}" style="flex-grow: {segment.share}"></span>
    {/each}
  </div>
  {#if legend}
    <ul class="legend">
      {#each segments as segment (segment.kind)}
        <li>
          <span class="swatch {segment.kind}" aria-hidden="true"></span>
          {kindLabel(segment.kind)}
          {#if !fractions}<strong>{formatFlux(segment.amount)}</strong>{/if}
          <span class="muted">{percent(segment.share)}</span>
        </li>
      {/each}
    </ul>
  {/if}
{/if}

<style>
  .bar {
    display: flex;
    height: 0.9rem;
    overflow: hidden;
    border-radius: var(--radius-s);
    background: var(--line);
  }

  .bar.thin {
    height: 0.55rem;
    min-width: 6rem;
  }

  .seg {
    flex-basis: 0;
    min-width: 2px;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 1.25rem;
    margin: 0.5rem 0 0;
    padding: 0;
    list-style: none;
    font-size: var(--step--1);
  }

  .legend li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .swatch {
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 2px;
  }

  .foundation {
    background: var(--brand);
  }

  .exchange {
    background: var(--sell);
  }

  .node_operator {
    background: var(--buy);
  }

  .app_hosting {
    background: var(--good);
  }

  .unknown {
    background: var(--text-muted);
  }

  .small {
    font-size: var(--step--1);
  }
</style>
