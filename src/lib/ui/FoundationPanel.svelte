<!--
  The Flux Foundation at a glance (#31): what it holds, and what came in and went out this
  period. Moves between its own wallets are reported separately, not as outflow plus inflow.
-->
<script lang="ts">
  import { formatCount, formatFlux, formatFluxFull, formatSigned } from '$lib/client/format';
  import type { Foundation } from '$lib/client/types';
  import type { PeriodId } from '$lib/shared/constants';

  interface Props {
    data: Foundation;
    period: PeriodId;
  }

  let { data, period }: Props = $props();
  const t = $derived(data.totals);
</script>

<section aria-labelledby="foundation-heading" class="panel">
  <header>
    <h2 id="foundation-heading">Flux Foundation</h2>
    <a href="/foundation{period === '24H' ? '' : `?period=${period}`}">Wallets and movements</a>
  </header>
  <dl>
    {#if t.balance !== null}
      <div>
        <dt>Holds</dt>
        <dd title="{formatFluxFull(t.balance)} FLUX">{formatFlux(t.balance)}</dd>
        <dd class="sub muted">across {formatCount(data.wallets.length)} wallets</dd>
      </div>
    {/if}
    <div>
      <dt>Received</dt>
      <dd class="buy">{formatFlux(t.inflow)}</dd>
    </div>
    <div>
      <dt>Sent</dt>
      <dd class="sell">{formatFlux(t.outflow)}</dd>
    </div>
    <div>
      <dt>Net</dt>
      <dd class={t.net < 0 ? 'sell' : t.net > 0 ? 'buy' : ''}>{formatSigned(t.net)}</dd>
    </div>
  </dl>
  {#if t.internalTransfers > 0}
    <p class="muted small">
      Not counted above: {formatCount(t.internalTransfers)} moves between Foundation wallets,
      {formatFlux(t.internalVolume)} FLUX in all.
    </p>
  {/if}
</section>

<style>
  .panel {
    display: grid;
    gap: 0.75rem;
    padding: 1rem 1.25rem;
    border: 1px solid var(--line);
    border-left: 4px solid var(--brand);
    border-radius: var(--radius-m);
    background: var(--surface);
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
  }

  header a {
    font-size: var(--step--1);
  }

  dl {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
    gap: 0.75rem 1.5rem;
    margin: 0;
  }

  dt {
    font-size: var(--step--1);
    color: var(--text-muted);
  }

  dd {
    margin: 0;
    font-size: var(--step-2);
    font-weight: 600;
  }

  dd.sub {
    font-size: var(--step--1);
    font-weight: 400;
  }

  .small {
    font-size: var(--step--1);
  }
</style>
