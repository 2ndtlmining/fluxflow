<!--
  Path finder (#70): is wallet A connected to wallet B, and how?

  Two addresses in, the strongest routes between them out, ranked by their bottleneck: the
  smallest hop, which caps how much of the money can have made the whole trip. Moves between
  Foundation wallets count as hops even though they are never transfers anywhere else (#31).

  The query lives in the URL, so a found path can be shared and reopened.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { isAbort } from '$lib/client/api';
  import { fetchPath, isAddress, type PathQuery } from '$lib/client/endpoints';
  import {
    formatCount,
    formatFlux,
    formatFluxFull,
    formatTime,
    kindLabel,
    shortAddress
  } from '$lib/client/format';
  import type { PathResult } from '$lib/client/types';
  import { PERIOD_IDS, PERIOD_LABELS, isPeriodId, type PeriodId } from '$lib/shared/constants';

  const MAX_HOPS = 6;

  function readQuery(params: URLSearchParams): PathQuery {
    const hops = Number(params.get('maxHops'));
    const period = (params.get('period') ?? '').toUpperCase();
    return {
      src: (params.get('src') ?? '').trim(),
      dst: (params.get('dst') ?? '').trim(),
      maxHops: Number.isInteger(hops) && hops >= 1 && hops <= MAX_HOPS ? hops : 4,
      throughExchanges: params.get('through') === 'exchanges',
      period: isPeriodId(period) ? (period as PeriodId) : null
    };
  }

  const query = $derived(readQuery(page.url.searchParams));
  const ready = $derived(isAddress(query.src) && isAddress(query.dst) && query.src !== query.dst);

  // The form edits drafts; submitting writes them to the URL, which runs the search.
  let src = $state('');
  let dst = $state('');
  $effect(() => {
    src = query.src;
    dst = query.dst;
  });

  let result = $state<PathResult | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);

  $effect(() => {
    const current = query;
    result = null;
    error = null;
    if (!ready) return;

    const controller = new AbortController();
    loading = true;
    fetchPath(current, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) result = response;
      })
      .catch((reason: unknown) => {
        if (!isAbort(reason)) error = (reason as Error).message;
      })
      .finally(() => {
        if (!controller.signal.aborted) loading = false;
      });
    return () => controller.abort();
  });

  function navigate(patch: Partial<PathQuery>): void {
    const next = { ...query, ...patch };
    const params = new URLSearchParams();
    if (next.src) params.set('src', next.src);
    if (next.dst) params.set('dst', next.dst);
    if (next.maxHops !== 4) params.set('maxHops', String(next.maxHops));
    if (next.throughExchanges) params.set('through', 'exchanges');
    if (next.period) params.set('period', next.period);
    void goto(`/path?${params.toString()}`, { keepFocus: true, noScroll: true });
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    navigate({ src: src.trim(), dst: dst.trim() });
  }

  const name = (address: string) => result?.nodes[address]?.name ?? shortAddress(address);
  const kind = (address: string) => kindLabel(result?.nodes[address]?.kind ?? 'unknown');
  const when = (first: number, last: number) =>
    first === last ? formatTime(first) : `${formatTime(first)} to ${formatTime(last)}`;
</script>

<svelte:head>
  <title>Path finder | FluxFlow</title>
</svelte:head>

<article class="finder">
  <p><a href="/">Back to the dashboard</a></p>
  <h1>Is one wallet connected to another?</h1>
  <p class="muted">
    The strongest routes FLUX took from the first wallet to the second, ranked by their smallest
    hop: no more than that can have made the whole trip. Moves between Flux Foundation wallets count
    as hops. Exchanges are not passed through unless you ask, since money that enters one comes out
    as anybody's.
  </p>

  <form onsubmit={submit} class="query">
    <label>
      <span>From</span>
      <input
        class="mono"
        bind:value={src}
        placeholder="t1… or t3…"
        autocomplete="off"
        spellcheck="false"
        aria-invalid={src !== '' && !isAddress(src.trim())}
      />
    </label>
    <label>
      <span>To</span>
      <input
        class="mono"
        bind:value={dst}
        placeholder="t1… or t3…"
        autocomplete="off"
        spellcheck="false"
        aria-invalid={dst !== '' && !isAddress(dst.trim())}
      />
    </label>
    <div class="options">
      <label>
        <span>Up to</span>
        <select
          value={query.maxHops}
          onchange={(event) => navigate({ maxHops: Number(event.currentTarget.value) })}
        >
          {#each Array.from({ length: MAX_HOPS }, (_, i) => i + 1) as hops (hops)}
            <option value={hops}>{hops} {hops === 1 ? 'hop' : 'hops'}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>When</span>
        <select
          value={query.period ?? ''}
          onchange={(event) =>
            navigate({ period: (event.currentTarget.value || null) as PeriodId | null })}
        >
          <option value="">Everything stored</option>
          {#each PERIOD_IDS as period (period)}
            <option value={period}>{PERIOD_LABELS[period]}</option>
          {/each}
        </select>
      </label>
      <label class="check">
        <input
          type="checkbox"
          checked={query.throughExchanges}
          onchange={(event) => navigate({ throughExchanges: event.currentTarget.checked })}
        />
        <span>Pass through exchanges</span>
      </label>
      <button type="submit" class="button">Find paths</button>
    </div>
  </form>

  {#if query.src && query.dst && !ready}
    <p class="error" role="alert">
      {query.src === query.dst
        ? 'The two wallets are the same.'
        : 'Both need to be FLUX transparent addresses (t1… or t3…, 35 characters).'}
    </p>
  {:else if error}
    <p class="error" role="alert">{error}</p>
  {:else if loading}
    <p class="muted" aria-busy="true">Looking for paths…</p>
  {:else if result && result.paths.length === 0}
    <p class="muted" role="status">
      No path within {result.maxHops}
      {result.maxHops === 1 ? 'hop' : 'hops'}{query.period
        ? ` in ${PERIOD_LABELS[query.period].toLowerCase()}`
        : ''}.
      {#if !result.throughExchanges}Try allowing paths through exchanges, or more hops.{:else}Try
        more hops or a longer time span.{/if}
    </p>
  {:else if result}
    <p class="muted" role="status">
      {formatCount(result.paths.length)} strongest
      {result.paths.length === 1 ? 'path' : 'paths'}, looked for among {formatCount(
        result.explored.forward + result.explored.backward
      )} wallets.
      {#if result.truncated}The search hit its limit, so a weaker route may be missing.{/if}
    </p>
    <ol class="paths">
      {#each result.paths as path, i (i)}
        <li class="path">
          <p class="headline">
            <strong>{formatFlux(path.bottleneck)} FLUX</strong>
            <span class="muted"
              >at most made the whole trip, in {path.hops.length}
              {path.hops.length === 1 ? 'hop' : 'hops'}</span
            >
          </p>
          <ol class="hops">
            <li class="wallet">
              <a
                href="/wallet/{path.hops[0]!.from}"
                class:mono={!result.nodes[path.hops[0]!.from]?.name}>{name(path.hops[0]!.from)}</a
              >
              <span class="muted small">{kind(path.hops[0]!.from)}</span>
            </li>
            {#each path.hops as hop (hop.from + hop.to)}
              <li class="move">
                <span aria-hidden="true">↓</span>
                <span title="{formatFluxFull(hop.total)} FLUX">{formatFlux(hop.total)} FLUX</span>
                <span class="muted small"
                  >in {formatCount(hop.count)}
                  {hop.count === 1 ? 'transfer' : 'transfers'}, {when(hop.first, hop.last)}</span
                >
                {#if hop.internal}<span class="tag">between Foundation wallets</span>{/if}
              </li>
              <li class="wallet">
                <a href="/wallet/{hop.to}" class:mono={!result.nodes[hop.to]?.name}
                  >{name(hop.to)}</a
                >
                <span class="muted small">{kind(hop.to)}</span>
              </li>
            {/each}
          </ol>
        </li>
      {/each}
    </ol>
  {/if}
</article>

<style>
  .finder {
    display: grid;
    gap: 1rem;
    padding-top: 1.25rem;
    max-width: 48rem;
  }

  h1 {
    margin: 0;
  }

  .query {
    display: grid;
    gap: 0.75rem;
  }

  .query label {
    display: grid;
    gap: 0.25rem;
  }

  .query input:not([type='checkbox']) {
    width: 100%;
    min-height: 2.5rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
  }

  .options {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1rem;
    align-items: end;
  }

  .options select {
    min-height: 2.5rem;
  }

  .check {
    display: flex !important;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.5rem;
  }

  .button {
    min-height: 2.5rem;
    padding: 0.5rem 0.9rem;
    border: 1px solid var(--brand);
    border-radius: var(--radius-s);
    background: var(--brand);
    /* --on-brand comes with #33; until then the page background reads on the brand in
       both themes (light on the dark purple, dark on the light one). */
    color: var(--on-brand, var(--bg));
    font-weight: 500;
    cursor: pointer;
  }

  .paths {
    display: grid;
    gap: 1rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .path {
    padding: 0.75rem 1rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
  }

  .headline {
    margin: 0 0 0.5rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.5rem;
    align-items: baseline;
  }

  .hops {
    display: grid;
    gap: 0.15rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .wallet {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.6rem;
    align-items: baseline;
  }

  .wallet a {
    min-height: 24px;
    line-height: 24px;
  }

  .move {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.6rem;
    align-items: baseline;
    padding-left: 0.75rem;
    border-left: 2px solid var(--line);
    margin-left: 0.4rem;
    font-size: var(--step--1);
  }

  .tag {
    padding: 0 0.4rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 0.7rem;
  }

  .small {
    font-size: var(--step--1);
  }

  .error {
    color: var(--bad);
  }
</style>
