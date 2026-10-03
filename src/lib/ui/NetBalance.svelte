<!--
  The answer to the page's question, first: did more FLUX go onto exchanges (selling
  pressure) or come off them (buying pressure)? The balance axis below the headline is the
  visual idea every other breakdown on the page repeats.
-->
<script lang="ts">
  import { formatCount, formatFlux, formatFluxFull } from '$lib/client/format';
  import type { FlowSummary } from '$lib/client/types';
  import type { PeriodId } from '$lib/shared/constants';

  interface Props {
    summary: FlowSummary | undefined;
    period: PeriodId;
  }

  let { summary, period }: Props = $props();

  const PHRASE: Record<PeriodId, string> = {
    '24H': 'in the last 24 hours',
    '7D': 'in the last 7 days',
    '30D': 'in the last 30 days',
    '90D': 'in the last 90 days',
    '6M': 'in the last 6 months'
  };

  const bought = $derived(summary?.buying?.total ?? 0);
  const sold = $derived(summary?.selling?.total ?? 0);
  const net = $derived(bought - sold);
  const scale = $derived(Math.max(bought, sold, 1));
  const empty = $derived(summary !== undefined && bought === 0 && sold === 0);
</script>

<section class="hero" aria-labelledby="net-heading">
  {#if !summary}
    <p class="lede skeleton">Loading the balance…</p>
    <p class="figure skeleton">000,000 FLUX</p>
    <div class="axis skeleton" aria-hidden="true"></div>
  {:else if summary.blocksSynced === 0}
    <h1 id="net-heading" class="lede">FluxFlow is reading its first blocks.</h1>
    <p class="muted">
      Totals appear as soon as the first batch is stored, usually within a minute.
    </p>
  {:else}
    <h1 id="net-heading" class="lede">
      {#if empty}
        No FLUX moved to or from tracked exchanges {PHRASE[period]}.
      {:else if net < 0}
        More FLUX went onto exchanges than came off them {PHRASE[period]}.
      {:else}
        More FLUX came off exchanges than went onto them {PHRASE[period]}.
      {/if}
    </h1>

    {#if !empty}
      <p class="figure {net < 0 ? 'sell' : 'buy'}" title="{formatFluxFull(Math.abs(net))} FLUX">
        Net {formatFlux(Math.abs(net))} FLUX
        <span class="direction">{net < 0 ? 'deposited' : 'withdrawn'}</span>
      </p>

      <div
        class="axis"
        role="img"
        aria-label="{formatFluxFull(sold)} FLUX deposited to exchanges versus {formatFluxFull(
          bought
        )} FLUX withdrawn"
      >
        <div class="half left">
          <div class="bar sell-bar" style:width="{(sold / scale) * 100}%"></div>
        </div>
        <div class="zero" aria-hidden="true"></div>
        <div class="half right">
          <div class="bar buy-bar" style:width="{(bought / scale) * 100}%"></div>
        </div>
      </div>

      <div class="legend">
        <p>
          <span class="sell amount">{formatFlux(sold)}</span>
          deposited to exchanges
          <span class="muted">in {formatCount(summary.selling?.count ?? 0)} transfers</span>
        </p>
        <p class="end">
          <span class="buy amount">{formatFlux(bought)}</span>
          withdrawn from exchanges
          <span class="muted">in {formatCount(summary.buying?.count ?? 0)} transfers</span>
        </p>
      </div>
    {/if}

    {#if summary.partial && summary.partialWarning}
      <p class="partial">
        History for this period is still filling in ({summary.progress.toFixed(0)}% of blocks
        stored), so totals will grow as it catches up.
      </p>
    {/if}
  {/if}
</section>

<style>
  .hero {
    display: grid;
    gap: 1rem;
    padding: 1.5rem 0 0.5rem;
  }

  .lede {
    font-size: var(--step-1);
    font-weight: 500;
    max-width: 40ch;
  }

  .figure {
    font-size: var(--step-4);
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.05;
  }

  .direction {
    font-size: var(--step-1);
    font-weight: 500;
    letter-spacing: 0;
  }

  .axis {
    display: grid;
    grid-template-columns: 1fr 2px 1fr;
    height: 2.75rem;
    align-items: stretch;
  }

  .axis.skeleton {
    display: block;
  }

  .half {
    display: flex;
    background: var(--surface-2);
  }

  .left {
    justify-content: flex-end;
    border-radius: var(--radius-m) 0 0 var(--radius-m);
  }

  .right {
    border-radius: 0 var(--radius-m) var(--radius-m) 0;
  }

  .zero {
    background: var(--text);
  }

  .bar {
    height: 100%;
    transition: width 400ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .sell-bar {
    background: var(--sell);
    border-radius: var(--radius-m) 0 0 var(--radius-m);
  }

  .buy-bar {
    background: var(--buy);
    border-radius: 0 var(--radius-m) var(--radius-m) 0;
  }

  .legend {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  .end {
    text-align: right;
  }

  .amount {
    font-size: var(--step-2);
    font-weight: 600;
    display: block;
  }

  .partial {
    color: var(--warn);
    font-size: var(--step--1);
  }

  @media (max-width: 480px) {
    .legend {
      font-size: var(--step--1);
    }
  }
</style>
