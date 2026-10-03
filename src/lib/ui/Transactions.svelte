<!--
  Transactions explorer (#27): filters in the URL, one page at a time with keyset paging,
  and CSV export of whatever the filters select.

  Rows are only ever the pages asked for, so the table stays light however many events a
  period holds; v1 rendered every event of the period at once.
-->
<script lang="ts">
  import { apiFetch, isAbort } from '$lib/client/api';
  import { downloadCsv, eventsToCsv } from '$lib/client/csv';
  import {
    flowLabel,
    formatFlux,
    formatFluxFull,
    formatTime,
    kindLabel,
    shortAddress,
    timeAgo
  } from '$lib/client/format';
  import type { EventsPage, FlowEvent } from '$lib/client/types';
  import { eventsPath, hasFilters, EMPTY_FILTERS, type TxFilters } from '$lib/client/urlState';
  import type { PeriodId } from '$lib/shared/constants';

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
  let cursor = $state<string | null>(null);
  let loading = $state(true);
  let loadingMore = $state(false);
  let exporting = $state(false);
  let error = $state<string | null>(null);
  let minDraft = $state('');
  let controller: AbortController | null = null;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const now = Date.now();

  // Keep the input in step with the URL (back button, shared links).
  $effect(() => {
    minDraft = filters.min > 0 ? String(filters.min) : '';
  });

  // A new period or filter set starts again from the first page; the previous request is
  // aborted, so a slow answer can never overwrite a newer one (#26).
  $effect(() => {
    const path = eventsPath(period, filters, { limit: PAGE });
    controller?.abort();
    const current = new AbortController();
    controller = current;
    loading = true;
    error = null;

    apiFetch<EventsPage>(path, { signal: current.signal })
      .then((page) => {
        if (current.signal.aborted) return;
        events = page.events;
        cursor = page.nextCursor;
      })
      .catch((reason: unknown) => {
        if (!isAbort(reason)) error = (reason as Error).message;
      })
      .finally(() => {
        if (!current.signal.aborted) loading = false;
      });

    return () => current.abort();
  });

  async function loadMore(): Promise<void> {
    if (!cursor || loadingMore) return;
    loadingMore = true;
    const signal = controller?.signal;
    try {
      const page = await apiFetch<EventsPage>(
        eventsPath(period, filters, { cursor, limit: PAGE }),
        {
          signal
        }
      );
      if (signal?.aborted) return;
      events = [...events, ...page.events];
      cursor = page.nextCursor;
    } catch (reason) {
      if (!isAbort(reason)) error = (reason as Error).message;
    } finally {
      loadingMore = false;
    }
  }

  async function exportCsv(): Promise<void> {
    exporting = true;
    const rows: FlowEvent[] = [];
    let next: string | null = null;
    try {
      do {
        const page: EventsPage = await apiFetch<EventsPage>(
          eventsPath(period, filters, { cursor: next, limit: EXPORT_PAGE })
        );
        rows.push(...page.events);
        next = page.nextCursor;
      } while (next && rows.length < EXPORT_MAX);
      downloadCsv(`fluxflow-${period.toLowerCase()}-transactions.csv`, eventsToCsv(rows));
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

  function counterparty(event: FlowEvent): 'from' | 'to' {
    return event.flowType === 'buying' ? 'to' : 'from';
  }
</script>

<section aria-labelledby="tx-heading" class="explorer">
  <header class="head">
    <div>
      <h2 id="tx-heading">Transactions</h2>
      <p class="muted">Every transfer in this period, newest first.</p>
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
      <span>Direction</span>
      <select
        value={filters.type}
        onchange={(event) => set({ type: event.currentTarget.value as TxFilters['type'] })}
      >
        <option value="">All</option>
        <option value="selling">Deposited to exchange</option>
        <option value="buying">Withdrawn from exchange</option>
        <option value="p2p">Wallet to wallet</option>
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
      <button type="button" class="link" onclick={() => onfilters(EMPTY_FILTERS)}
        >Clear filters</button
      >
    {/if}
  </form>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <div class="table-wrap" aria-busy={loading}>
    <table>
      <caption class="visually-hidden">Transfers in this period, newest first</caption>
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">What</th>
          <th scope="col">Wallet</th>
          <th scope="col" class="num">FLUX</th>
        </tr>
      </thead>
      <tbody class:stale={loading && events.length > 0}>
        {#if loading && events.length === 0}
          {#each Array.from({ length: 6 }, (_, i) => i) as i (i)}
            <tr><td colspan="4"><span class="skeleton">loading transfer row</span></td></tr>
          {/each}
        {:else if events.length === 0}
          <tr>
            <td colspan="4" class="muted empty">
              No transfers match these filters in this period.
              {#if hasFilters(filters)}
                <button type="button" class="link" onclick={() => onfilters(EMPTY_FILTERS)}
                  >Clear filters</button
                >
              {/if}
            </td>
          </tr>
        {:else}
          {#each events as event (`${event.txid}:${event.vout}`)}
            {@const side = counterparty(event)}
            {@const address = side === 'to' ? event.toAddress : event.fromAddress}
            {@const kind = side === 'to' ? event.toKind : event.fromKind}
            <tr>
              <td class="when">
                <span title={formatTime(event.time)}>{timeAgo(event.time, now)}</span>
                <a
                  class="muted mono small"
                  href="https://explorer.runonflux.io/tx/{event.txid}"
                  rel="noopener noreferrer"
                  target="_blank">#{event.height}</a
                >
              </td>
              <td class="what">
                <span
                  class={event.flowType === 'selling'
                    ? 'sell'
                    : event.flowType === 'buying'
                      ? 'buy'
                      : 'muted'}
                >
                  {flowLabel(event.flowType)}
                </span>
                {#if event.exchange}<span class="muted">{event.exchange}</span>{/if}
              </td>
              <td class="wallet">
                <a class="mono" href="/wallet/{address}" title={address}>{shortAddress(address)}</a>
                <span class="muted small">{kindLabel(kind)}</span>
              </td>
              <td class="num" title="{formatFluxFull(event.amount)} FLUX"
                >{formatFlux(event.amount)}</td
              >
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>

  {#if cursor && !loading}
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

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th {
    text-align: left;
    font-size: var(--step--1);
    font-weight: 500;
    color: var(--text-muted);
    padding: 0.4rem 0.5rem 0.4rem 0;
    border-bottom: 1px solid var(--line);
  }

  td {
    padding: 0.6rem 0.5rem 0.6rem 0;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }

  tbody tr {
    content-visibility: auto;
    contain-intrinsic-size: auto 3.25rem;
  }

  tbody.stale {
    opacity: 0.55;
    transition: opacity 150ms;
  }

  .when,
  .what,
  .wallet {
    display: table-cell;
  }

  .when > *,
  .what > *,
  .wallet > * {
    display: block;
  }

  .small {
    font-size: var(--step--1);
  }

  .num {
    text-align: right;
    font-weight: 600;
    padding-right: 0;
    white-space: nowrap;
  }

  .empty {
    padding: 1.25rem 0;
  }

  /* Phone: each transfer becomes a compact two-line block instead of a wide row. */
  @media (max-width: 640px) {
    thead {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }

    tbody tr {
      display: grid;
      grid-template-columns: 1fr auto;
      grid-template-areas:
        'what num'
        'wallet when';
      gap: 0.15rem 0.75rem;
      padding: 0.6rem 0;
      border-bottom: 1px solid var(--line);
    }

    td {
      padding: 0;
      border: 0;
    }

    td[colspan] {
      grid-column: 1 / -1;
    }

    .what {
      grid-area: what;
    }
    .num {
      grid-area: num;
    }
    .wallet {
      grid-area: wallet;
    }
    .when {
      grid-area: when;
      text-align: right;
    }

    select,
    input {
      min-width: 0;
      width: 100%;
    }

    .filters {
      display: grid;
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
