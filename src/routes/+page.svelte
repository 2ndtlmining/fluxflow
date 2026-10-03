<!--
  Dashboard: the balance first, then who is behind it, then how it splits by exchange and by
  kind of wallet, then every transfer (#36 Phase 4).

  State lives in the URL (#26): the period and the transaction filters are query parameters,
  so refresh, back/forward and shared links all land on the same view. Switching period never
  blanks the page: the previous figures stay, dimmed, until the new ones arrive, and each
  switch aborts the request it replaces so the last click always wins.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { untrack } from 'svelte';
  import { cachedFetch, isAbort, peek } from '$lib/client/api';
  import { kindLabel } from '$lib/client/format';
  import { fetchSeries, type SeriesPoint } from '$lib/client/pending';
  import type { Counterparty, FlowSummary } from '$lib/client/types';
  import { readState, writeState, type TxFilters } from '$lib/client/urlState';
  import type { PeriodId } from '$lib/shared/constants';
  import Diverging from '$lib/ui/Diverging.svelte';
  import Leaderboard from '$lib/ui/Leaderboard.svelte';
  import NetBalance from '$lib/ui/NetBalance.svelte';
  import PeriodTabs from '$lib/ui/PeriodTabs.svelte';
  import SeriesChart from '$lib/ui/SeriesChart.svelte';
  import Transactions from '$lib/ui/Transactions.svelte';
  import type { DivergingRow } from '$lib/ui/types';

  /** Between syncs the server answers 304, so polling once a minute costs almost nothing. */
  const REFRESH_MS = 60_000;

  const view = $derived(readState(page.url.searchParams));

  let summary = $state<FlowSummary | undefined>();
  let sellers = $state<Counterparty[] | undefined>();
  let buyers = $state<Counterparty[] | undefined>();
  let series = $state<SeriesPoint[] | null>(null);
  let error = $state<string | null>(null);

  const stale = $derived(summary !== undefined && summary.period !== view.period);

  async function load(period: PeriodId, signal: AbortSignal): Promise<void> {
    try {
      const [nextSummary, nextSellers, nextBuyers, nextSeries] = await Promise.all([
        cachedFetch<FlowSummary>(`/flow/${period}`, signal),
        cachedFetch<{ sellers: Counterparty[] }>(`/flow/${period}/sellers?limit=10`, signal),
        cachedFetch<{ buyers: Counterparty[] }>(`/flow/${period}/buyers?limit=10`, signal),
        fetchSeries(period, signal)
      ]);
      if (signal.aborted) return;
      summary = nextSummary;
      sellers = nextSellers.sellers;
      buyers = nextBuyers.buyers;
      series = nextSeries;
      error = null;
    } catch (reason) {
      if (!isAbort(reason)) error = (reason as Error).message;
    }
  }

  $effect(() => {
    const period = view.period;
    const controller = new AbortController();

    // Show what we already know for this period at once; keep the old figures otherwise.
    untrack(() => {
      const known = peek<FlowSummary>(`/flow/${period}`);
      if (known) summary = known;
      sellers =
        peek<{ sellers: Counterparty[] }>(`/flow/${period}/sellers?limit=10`)?.sellers ?? sellers;
      buyers =
        peek<{ buyers: Counterparty[] }>(`/flow/${period}/buyers?limit=10`)?.buyers ?? buyers;
    });

    void load(period, controller.signal);

    const timer = setInterval(() => {
      if (!document.hidden) void load(period, controller.signal);
    }, REFRESH_MS);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  });

  function hrefFor(period: PeriodId): string {
    const query = writeState({ period, filters: view.filters });
    return query ? `/?${query}` : '/';
  }

  function setFilters(filters: TxFilters): void {
    const query = writeState({ period: view.period, filters });
    void goto(query ? `/?${query}` : '/', { keepFocus: true, noScroll: true, replaceState: true });
  }

  const exchangeRows = $derived.by((): DivergingRow[] => {
    const names = new Set([
      ...Object.keys(summary?.buying?.byExchange ?? {}),
      ...Object.keys(summary?.selling?.byExchange ?? {})
    ]);
    return [...names]
      .map((name) => ({
        key: name,
        label: name,
        buy: summary?.buying?.byExchange[name]?.total ?? 0,
        sell: summary?.selling?.byExchange[name]?.total ?? 0
      }))
      .sort((a, b) => b.buy + b.sell - (a.buy + a.sell));
  });

  const kindRows = $derived.by((): DivergingRow[] => {
    const kinds = [
      ['node_operator', 'NodeOperators'],
      ['unknown', 'Unknown'],
      ['foundation', 'Foundation'],
      ['exchange', 'Exchanges']
    ] as const;
    return kinds
      .map(([kind, suffix]) => ({
        key: kind,
        label: kindLabel(kind),
        buy: summary?.buying?.breakdown[`to${suffix}`] ?? 0,
        sell: summary?.selling?.breakdown[`from${suffix}`] ?? 0
      }))
      .filter((row) => row.buy > 0 || row.sell > 0);
  });

  const exchanges = $derived(exchangeRows.map((row) => row.key).sort());
</script>

<svelte:head>
  <title>FluxFlow: who is moving FLUX on and off exchanges</title>
</svelte:head>

<div class="dashboard" class:stale>
  <div class="bar">
    <PeriodTabs current={view.period} href={hrefFor} />
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
  </div>

  <NetBalance {summary} period={summary?.period ?? view.period} />

  <div class="boards">
    <Leaderboard side="selling" rows={sellers} />
    <Leaderboard side="buying" rows={buyers} />
  </div>

  {#if exchangeRows.length > 0}
    <section aria-labelledby="by-exchange" class="block">
      <header>
        <h2 id="by-exchange">By exchange</h2>
        <p class="muted">
          <span class="sell">Deposits</span> to the left, <span class="buy">withdrawals</span> to the
          right, net on the end.
        </p>
      </header>
      <Diverging rows={exchangeRows} caption="Deposits and withdrawals by exchange" />
    </section>
  {/if}

  {#if kindRows.length > 0}
    <section aria-labelledby="by-kind" class="block">
      <header>
        <h2 id="by-kind">By kind of wallet</h2>
        <p class="muted">Who was on the other side of the exchange transfers.</p>
      </header>
      <Diverging rows={kindRows} caption="Deposits and withdrawals by kind of wallet" />
    </section>
  {/if}

  {#if series && series.length > 0}
    <section aria-labelledby="over-time" class="block">
      <header>
        <h2 id="over-time">Over time</h2>
      </header>
      <SeriesChart points={series} />
    </section>
  {/if}

  <div class="block">
    <Transactions period={view.period} filters={view.filters} {exchanges} onfilters={setFilters} />
  </div>
</div>

<style>
  .dashboard {
    display: grid;
    gap: 2.5rem;
    padding-top: 1.25rem;
    transition: opacity 150ms;
  }

  .stale :global(.hero),
  .stale .boards,
  .stale .block:not(:last-child) {
    opacity: 0.55;
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: center;
  }

  .boards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2.5rem;
  }

  .block {
    display: grid;
    gap: 1rem;
  }

  .block > header {
    display: grid;
    gap: 0.15rem;
  }

  .block > header p {
    font-size: var(--step--1);
  }

  .error {
    color: var(--bad);
    font-size: var(--step--1);
  }

  @media (max-width: 800px) {
    .boards {
      grid-template-columns: 1fr;
    }
  }
</style>
