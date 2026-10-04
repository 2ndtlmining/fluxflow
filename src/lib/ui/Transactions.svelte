<!--
  Transactions explorer (#27): filters in the URL, one page at a time with keyset paging,
  and CSV export of whatever the filters select.

  The default view is exchange flows — deposits and withdrawals — because that is what the
  page is about; wallet-to-wallet transfers, mostly small, are one choice away. The API
  filters one direction per request, so exchange flows are two streams merged in order
  (see `MergedPager`).

  New transfers arrive with live updates (#32): while the first page is showing, it is
  refreshed and new rows are highlighted. Once older pages are loaded the list stays put,
  so reading is never interrupted.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { apiFetch, isAbort } from '$lib/client/api';
  import { downloadCsv, eventsToCsv } from '$lib/client/csv';
  import { live } from '$lib/client/live.svelte';
  import { MergedPager } from '$lib/client/pager';
  import type { EventsPage, FlowEvent } from '$lib/client/types';
  import {
    directionsFor,
    eventsPath,
    hasFilters,
    EMPTY_FILTERS,
    type TxFilters
  } from '$lib/client/urlState';
  import type { PeriodId } from '$lib/shared/constants';
  import EventRows from './EventRows.svelte';

  interface Props {
    period: PeriodId;
    filters: TxFilters;
    exchanges: string[];
    onfilters: (filters: TxFilters) => void;
  }

  let { period, filters, exchanges, onfilters }: Props = $props();

  const PAGE = 50;
  const EXPORT_PAGE = 500;
  const EXPORT_MAX = 10_000;

  let events = $state<FlowEvent[]>([]);
  let hasMore = $state(false);
  let loading = $state(true);
  let loadingMore = $state(false);
  let exporting = $state(false);
  let error = $state<string | null>(null);
  let minDraft = $state('');
  let fresh = $state<ReadonlySet<string>>(new Set());
  let pager: MergedPager | null = null;
  let controller: AbortController | null = null;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const key = (event: FlowEvent) => `${event.txid}:${event.vout}`;

  function makePager(signal?: AbortSignal, limit = PAGE): MergedPager {
    return new MergedPager(
      directionsFor(filters.type).map(
        (direction) => (cursor: string | null) =>
          apiFetch<EventsPage>(
            eventsPath(period, direction, filters, { cursor, limit }),
            signal ? { signal } : {}
          )
      )
    );
  }

  // Keep the input in step with the URL (back button, shared links).
  $effect(() => {
    minDraft = filters.min > 0 ? String(filters.min) : '';
  });

  // A new period or filter set starts again from the first page; the previous request is
  // aborted, so a slow answer can never overwrite a newer one (#26).
  $effect(() => {
    void period;
    void filters;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    const next = makePager(current.signal);
    pager = next;
    loading = true;
    error = null;
    fresh = new Set();

    next
      .next(PAGE)
      .then((page) => {
        if (current.signal.aborted) return;
        events = page;
        hasMore = next.hasMore;
      })
      .catch((reason: unknown) => {
        if (!isAbort(reason)) error = (reason as Error).message;
      })
      .finally(() => {
        if (!current.signal.aborted) loading = false;
      });

    return () => current.abort();
  });

  // Live: refresh the first page when new data lands, unless the reader has paged further.
  let seenVersion = -1;
  $effect(() => {
    const version = live.version;
    untrack(() => {
      if (seenVersion === -1 || loading || events.length > PAGE) {
        seenVersion = version;
        return;
      }
      seenVersion = version;
      const signal = controller?.signal;
      const refreshed = makePager(signal);
      void refreshed
        .next(PAGE)
        .then((page) => {
          if (signal?.aborted) return;
          const known = new Set(events.map(key));
          const arrived = page.filter((event) => !known.has(key(event)));
          if (arrived.length === 0) return;
          events = page;
          pager = refreshed;
          hasMore = refreshed.hasMore;
          fresh = new Set(arrived.map(key));
        })
        .catch(() => {});
    });
  });

  async function loadMore(): Promise<void> {
    if (!pager || loadingMore) return;
    loadingMore = true;
    const signal = controller?.signal;
    try {
      const page = await pager.next(PAGE);
      if (signal?.aborted) return;
      events = [...events, ...page];
      hasMore = pager.hasMore;
    } catch (reason) {
      if (!isAbort(reason)) error = (reason as Error).message;
    } finally {
      loadingMore = false;
    }
  }

  async function exportCsv(): Promise<void> {
    exporting = true;
    try {
      const all = makePager(undefined, EXPORT_PAGE);
      const rows: FlowEvent[] = [];
      while (all.hasMore && rows.length < EXPORT_MAX) {
        const page = await all.next(EXPORT_PAGE);
        if (page.length === 0) break;
        rows.push(...page);
      }
      downloadCsv(`fluxflow-${period.toLowerCase()}-transfers.csv`, eventsToCsv(rows));
    } catch (reason) {
      error = `Export stopped: ${(reason as Error).message}`;
    } finally {
      exporting = false;
    }
  }

  function set(patch: Partial<TxFilters>): void {
    onfilters({ ...filters, ...patch });
  }

  function onMinInput(value: string): void {
    minDraft = value;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const min = Number(value);
      set({ min: Number.isFinite(min) && min > 0 ? min : 0 });
    }, 400);
  }
</script>

<section aria-labelledby="tx-heading" class="explorer">
  <header class="head">
    <div>
      <h2 id="tx-heading">Transfers</h2>
      <p class="muted">
        {filters.type === 'exchange'
          ? 'Deposits to and withdrawals from exchanges, newest first.'
          : 'Transfers in this period, newest first.'}
      </p>
    </div>
    <button
      type="button"
      class="button"
      onclick={exportCsv}
      disabled={exporting || events.length === 0}
    >
      {exporting ? 'Exporting…' : 'Export CSV'}
    </button>
  </header>

  <form class="filters" onsubmit={(event) => event.preventDefault()}>
    <label>
      <span>Show</span>
      <select
        value={filters.type}
        onchange={(event) => set({ type: event.currentTarget.value as TxFilters['type'] })}
      >
        <option value="exchange">Exchange deposits and withdrawals</option>
        <option value="selling">Deposits to exchanges</option>
        <option value="buying">Withdrawals from exchanges</option>
        <option value="p2p">Wallet to wallet</option>
        <option value="all">All transfers</option>
      </select>
    </label>
    <label>
      <span>Wallet type</span>
      <select
        value={filters.kind}
        onchange={(event) => set({ kind: event.currentTarget.value as TxFilters['kind'] })}
      >
        <option value="">All</option>
        <option value="unknown">Unlabelled wallet</option>
        <option value="node_operator">Node operator</option>
        <option value="foundation">Flux Foundation</option>
        <option value="exchange">Exchange</option>
      </select>
    </label>
    <label>
      <span>Exchange</span>
      <select
        value={filters.exchange}
        onchange={(event) => set({ exchange: event.currentTarget.value })}
      >
        <option value="">All</option>
        {#each exchanges as name (name)}
          <option value={name}>{name}</option>
        {/each}
        {#if filters.exchange && !exchanges.includes(filters.exchange)}
          <option value={filters.exchange}>{filters.exchange}</option>
        {/if}
      </select>
    </label>
    <label>
      <span>Minimum FLUX</span>
      <input
        type="number"
        inputmode="decimal"
        min="0"
        step="any"
        placeholder="0"
        value={minDraft}
        oninput={(event) => onMinInput(event.currentTarget.value)}
      />
    </label>
    {#if hasFilters(filters)}
      <button type="button" class="link" onclick={() => onfilters(EMPTY_FILTERS)}>
        Reset filters
      </button>
    {/if}
  </form>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <EventRows {events} {loading} {fresh} caption="Transfers in this period, newest first">
    {#snippet empty()}
      No transfers match these filters in this period.
      {#if hasFilters(filters)}
        <button type="button" class="link" onclick={() => onfilters(EMPTY_FILTERS)}>
          Reset filters
        </button>
      {/if}
    {/snippet}
  </EventRows>

  {#if hasMore && !loading}
    <button type="button" class="button more" onclick={loadMore} disabled={loadingMore}>
      {loadingMore ? 'Loading…' : 'Show older transfers'}
    </button>
  {/if}
</section>

<style>
  .explorer {
    display: grid;
    gap: 1rem;
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: end;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .head p {
    font-size: var(--step--1);
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: end;
  }

  label {
    display: grid;
    gap: 0.2rem;
    font-size: var(--step--1);
    color: var(--text-muted);
  }

  select,
  input {
    min-width: 9rem;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    color: var(--text);
    font-size: var(--step-0);
  }

  input {
    width: 9rem;
  }

  .button {
    padding: 0.5rem 0.9rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    font-weight: 500;
    cursor: pointer;
  }

  .button:hover:not(:disabled) {
    border-color: var(--text-muted);
  }

  .button:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .link {
    padding: 0.45rem 0;
    border: 0;
    background: none;
    color: var(--brand);
    text-decoration: underline;
    cursor: pointer;
  }

  .more {
    justify-self: start;
  }

  .error {
    color: var(--bad);
  }

  @media (max-width: 640px) {
    select,
    input {
      min-width: 0;
      width: 100%;
    }

    .filters {
      display: grid;
      grid-template-columns: 1fr 1fr;
    }

    .filters label:first-child {
      grid-column: 1 / -1;
    }
  }
</style>
