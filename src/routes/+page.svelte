<!--
  Dashboard: the balance first, then who is behind it, then how it splits by exchange and by
  kind of wallet, how it moved over time, and every transfer (#36 Phase 4).

  State lives in the URL (#26): the period, the leaderboard filter and the transaction
  filters are query parameters, so refresh, back/forward and shared links all land on the
  same view. Switching period never blanks the page: the previous figures stay, dimmed, until
  the new ones arrive, and each switch aborts the request it replaces so the last click wins.

  Data is revalidated whenever `live.version` moves: on each committed sync while the event
  stream is open, otherwise every 30 s (#32). Between syncs that costs a 304.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { untrack } from 'svelte';
  import { isAbort, peek } from '$lib/client/api';
  import {
    boardPath,
    fetchBoard,
    fetchSeries,
    fetchSummary,
    seriesPath,
    summaryPath
  } from '$lib/client/endpoints';
  import { kindLabel } from '$lib/client/format';
  import { live } from '$lib/client/live.svelte';
  import type { FlowSummary, Leaderboard as Board, Series } from '$lib/client/types';
  import { readState, writeState, type BoardKind, type TxFilters } from '$lib/client/urlState';
  import type { PeriodId } from '$lib/shared/constants';
  import Diverging from '$lib/ui/Diverging.svelte';
  import Leaderboard from '$lib/ui/Leaderboard.svelte';
  import NetBalance from '$lib/ui/NetBalance.svelte';
  import PeriodTabs from '$lib/ui/PeriodTabs.svelte';
  import SeriesChart from '$lib/ui/SeriesChart.svelte';
  import Transactions from '$lib/ui/Transactions.svelte';
  import Watchlist from '$lib/ui/Watchlist.svelte';
  import type { DivergingRow } from '$lib/ui/types';

  const view = $derived(readState(page.url.searchParams));

  let summary = $state<FlowSummary | undefined>();
  let sellers = $state<Board | undefined>();
  let buyers = $state<Board | undefined>();
  let series = $state<Series | undefined>();
  let error = $state<string | null>(null);

  const stale = $derived(summary !== undefined && summary.period !== view.period);

  /**
   * Each section settles on its own: a leaderboard or chart that fails must not take the
   * headline figures down with it. Only the summary's failure is reported, since everything
   * else on the page is read in its light.
   */
  async function load(period: PeriodId, who: BoardKind, signal: AbortSignal): Promise<void> {
    const [nextSummary, nextSellers, nextBuyers, nextSeries] = await Promise.allSettled([
      fetchSummary(period, signal),
      fetchBoard(period, 'sellers', who, signal),
      fetchBoard(period, 'buyers', who, signal),
      fetchSeries(period, signal)
    ]);
    if (signal.aborted) return;

    if (nextSummary.status === 'fulfilled') {
      summary = nextSummary.value;
      error = null;
    } else if (!isAbort(nextSummary.reason)) {
      error = (nextSummary.reason as Error).message;
    }
    if (nextSellers.status === 'fulfilled') sellers = nextSellers.value;
    if (nextBuyers.status === 'fulfilled') buyers = nextBuyers.value;
    series = nextSeries.status === 'fulfilled' ? nextSeries.value : undefined;
  }

  $effect(() => live.start());

  $effect(() => {
    const { period, who } = view;
    void live.version;
    const controller = new AbortController();

    // Show what we already know for this view at once; keep the old figures otherwise.
    untrack(() => {
      summary = peek<FlowSummary>(summaryPath(period)) ?? summary;
      sellers = peek<Board>(boardPath(period, 'sellers', who)) ?? sellers;
      buyers = peek<Board>(boardPath(period, 'buyers', who)) ?? buyers;
      series = peek<Series>(seriesPath(period)) ?? series;
    });

    void load(period, who, controller.signal);
    return () => controller.abort();
  });

  function hrefFor(period: PeriodId): string {
    const query = writeState({ ...view, period });
    return query ? `/?${query}` : '/';
  }

  function navigate(patch: { who?: BoardKind; filters?: TxFilters }): void {
    const query = writeState({ ...view, ...patch });
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
    const buying = summary?.byType?.buying ?? {};
    const selling = summary?.byType?.selling ?? {};
    return [...new Set([...Object.keys(buying), ...Object.keys(selling)])]
      .map((kind) => ({
        key: kind,
        label: kindLabel(kind),
        buy: buying[kind] ?? 0,
        sell: selling[kind] ?? 0
      }))
      .filter((row) => row.buy > 0 || row.sell > 0)
      .sort((a, b) => b.buy + b.sell - (a.buy + a.sell));
  });

  const exchanges = $derived(exchangeRows.map((row) => row.key).sort());
  const boardsStale = $derived(sellers !== undefined && (sellers.period !== view.period || stale));
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

  <section class="block" aria-label="Leaderboards">
    <div class="board-filter">
      <label>
        <span>Kind of wallet</span>
        <select
          value={view.who}
          onchange={(event) => navigate({ who: event.currentTarget.value as BoardKind })}
        >
          <option value="">Everyone</option>
          <option value="unknown">Unlabelled wallets</option>
          <option value="node_operator">Node operators</option>
          <option value="foundation">Flux Foundation</option>
        </select>
      </label>
    </div>
    <div class="boards" class:dim={boardsStale}>
      <Leaderboard side="selling" rows={sellers?.sellers} total={sellers?.total} />
      <Leaderboard side="buying" rows={buyers?.buyers} total={buyers?.total} />
    </div>
  </section>

  <Watchlist />

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

  {#if series && series.points.length > 0}
    <section aria-labelledby="over-time" class="block">
      <header>
        <h2 id="over-time">Over time</h2>
        <p class="muted">
          {series.bucketSeconds >= 86_400 ? 'Per day' : 'Per hour'}:
          <span class="buy">withdrawals</span> up, <span class="sell">deposits</span> down.
        </p>
      </header>
      <SeriesChart points={series.points} bucketSeconds={series.bucketSeconds} />
    </section>
  {/if}

  <div class="block">
    <Transactions
      period={view.period}
      filters={view.filters}
      {exchanges}
      onfilters={(filters) => navigate({ filters })}
    />
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
  .stale .block:not(:last-child),
  .dim {
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

  .board-filter label {
    display: inline-grid;
    gap: 0.2rem;
    font-size: var(--step--1);
    color: var(--text-muted);
  }

  .board-filter select {
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    color: var(--text);
    font-size: var(--step-0);
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
