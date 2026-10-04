<!--
  Search results (#30): wallets by address prefix or label name, and transactions by id.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { ApiError, isAbort } from '$lib/client/api';
  import { search } from '$lib/client/endpoints';
  import { kindLabel, shortAddress } from '$lib/client/format';
  import type { SearchResult } from '$lib/client/types';

  const query = $derived((page.url.searchParams.get('q') ?? '').trim());

  let results = $state<SearchResult[] | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    const q = query;
    const controller = new AbortController();
    results = null;
    error = null;

    if (q.length < 2) {
      results = [];
      return;
    }

    search(q, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) results = response.results;
      })
      .catch((reason: unknown) => {
        if (isAbort(reason)) return;
        error =
          reason instanceof ApiError && reason.status === 400
            ? 'Search needs 2 to 64 characters: part of an address, a label such as an exchange name, or a full transaction id.'
            : (reason as Error).message;
      });

    return () => controller.abort();
  });
</script>

<svelte:head>
  <title>Search: {query} | FluxFlow</title>
</svelte:head>

<article class="results">
  <p><a href="/">Back to the dashboard</a></p>
  <h1>Results for “{query}”</h1>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {:else if results === null}
    <p class="muted" aria-busy="true">Searching…</p>
  {:else if query.length < 2}
    <p class="muted">Type at least two characters in the search box above.</p>
  {:else if results.length === 0}
    <p class="muted">
      Nothing matches. Search finds wallets FluxFlow has seen move FLUX to or from an exchange,
      exchange and other labels by name, and transactions by their full 64-character id.
    </p>
  {:else}
    <ul>
      {#each results as result (result.type === 'tx' ? result.txid : result.address)}
        <li>
          {#if result.type === 'wallet'}
            <a href="/wallet/{result.address}" class="name">
              {result.name ?? shortAddress(result.address)}
            </a>
            <span class="muted mono small">{result.address}</span>
            <span class="muted small">{kindLabel(result.kind)}</span>
          {:else}
            <a
              href="https://explorer.runonflux.io/tx/{result.txid}"
              rel="noopener noreferrer"
              target="_blank"
              class="name">Transaction in block {result.height}</a
            >
            <span class="muted mono small">{result.txid}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</article>

<style>
  .results {
    display: grid;
    gap: 1rem;
    padding-top: 1.5rem;
  }

  h1 {
    font-size: var(--step-2);
    word-break: break-word;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: grid;
    gap: 0.1rem;
    padding: 0.65rem 0;
    border-top: 1px solid var(--line);
  }

  .name {
    font-weight: 500;
  }

  .small {
    font-size: var(--step--1);
    word-break: break-all;
  }

  .error {
    color: var(--bad);
  }
</style>
