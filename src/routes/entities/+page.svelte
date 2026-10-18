<!--
  Entities (#65): every owner FluxFlow can put a name to, largest first, and the biggest
  co-spend clusters nobody has named yet.
-->
<script lang="ts">
  import { isAbort } from '$lib/client/api';
  import { fetchClusters, fetchEntities } from '$lib/client/endpoints';
  import { entityKindLabel, formatCount, formatFlux, shortAddress } from '$lib/client/format';
  import type { ClusterSummary, EntityList } from '$lib/client/types';

  let query = $state('');
  let list = $state<EntityList | undefined>();
  let clusters = $state<ClusterSummary[] | undefined>();
  let error = $state<string | null>(null);

  $effect(() => {
    const needle = query.trim();
    const controller = new AbortController();
    // Typing should not send a request per key.
    const timer = setTimeout(() => {
      fetchEntities(needle, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) list = result;
        })
        .catch((reason: unknown) => {
          if (!isAbort(reason)) error = (reason as Error).message;
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });

  $effect(() => {
    const controller = new AbortController();
    fetchClusters(true, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) clusters = result.clusters.slice(0, 10);
      })
      .catch((reason: unknown) => {
        if (!isAbort(reason)) error = (reason as Error).message;
      });
    return () => controller.abort();
  });
</script>

<svelte:head>
  <title>Entities | FluxFlow</title>
</svelte:head>

<article class="entities">
  <p><a href="/">Back to the dashboard</a></p>
  <h1>Entities</h1>
  <p class="muted">
    One owner usually controls many addresses. An entity adds them up: every address with the same
    label, or a group named on the <a href="/review">review page</a>.
  </p>

  <label class="search">
    Find an entity
    <input type="search" bind:value={query} placeholder="Kucoin, Foundation…" maxlength="100" />
  </label>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if !list}
    <p class="muted" aria-busy="true">Loading…</p>
  {:else if list.entities.length === 0}
    <p class="muted">No entity matches “{query}”.</p>
  {:else}
    <table>
      <caption class="visually-hidden">Entities, most addresses first</caption>
      <thead>
        <tr>
          <th scope="col">Entity</th>
          <th scope="col">Kind</th>
          <th scope="col" class="num">Addresses</th>
        </tr>
      </thead>
      <tbody>
        {#each list.entities as entity (entity.id)}
          <tr>
            <td>
              <a href="/entity/{encodeURIComponent(entity.id)}">{entity.name}</a>
              {#if entity.source === 'stored'}<span class="muted small">named</span>{/if}
            </td>
            <td class="muted">{entityKindLabel(entity.kind)}</td>
            <td class="num">{formatCount(entity.members)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  {#if clusters && clusters.length > 0}
    <section aria-labelledby="clusters-heading" class="block">
      <h2 id="clusters-heading">Biggest unnamed groups</h2>
      <p class="muted small">
        Addresses that spend together usually have one owner. These groups are not named yet; an
        admin can name them on the <a href="/review#clusters">review page</a>.
      </p>
      <ul class="clusters">
        {#each clusters as cluster (cluster.anchor)}
          <li>
            <strong>{formatCount(cluster.size)} addresses</strong>
            <span class="muted small">
              received {formatFlux(cluster.received)}, sent {formatFlux(cluster.sent)} FLUX
            </span>
            <span class="small">
              {#each cluster.sample.slice(0, 3) as address, i (address)}{i > 0 ? ', ' : ''}<a
                  class="mono"
                  href="/wallet/{address}">{shortAddress(address)}</a
                >{/each}
              · <a href="/graph?root={cluster.anchor}">follow the money</a>
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</article>

<style>
  .entities {
    display: grid;
    gap: 1.25rem;
    padding-top: 1.5rem;
  }

  h1 {
    margin: 0;
    font-size: var(--step-2);
  }

  .entities > p {
    margin: 0;
  }

  .search {
    display: grid;
    gap: 0.25rem;
    max-width: 24rem;
    font-size: var(--step--1);
    color: var(--text-muted);
  }

  input {
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    color: var(--text);
    font: inherit;
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
    padding: 0.35rem 0.5rem 0.35rem 0;
    border-bottom: 1px solid var(--line);
  }

  td {
    padding: 0.5rem 0.5rem 0.5rem 0;
    border-bottom: 1px solid var(--line);
  }

  td span {
    margin-left: 0.4rem;
  }

  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .block {
    display: grid;
    gap: 0.5rem;
  }

  h2 {
    margin: 0;
  }

  .clusters {
    display: grid;
    gap: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .clusters li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.75rem;
    padding: 0.5rem 0;
    border-top: 1px solid var(--line);
  }

  .small {
    font-size: var(--step--1);
  }

  .error {
    color: var(--bad);
  }
</style>
