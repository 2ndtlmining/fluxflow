<!--
  Cases (#69): named sets of wallets with a description and, optionally, the fund-flow graph
  view that showed the trail. Started here, from a wallet page, or from the graph.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { isAbort } from '$lib/client/api';
  import { createCase, fetchCases } from '$lib/client/endpoints';
  import { formatCount, formatDate } from '$lib/client/format';
  import type { CaseSummary } from '$lib/client/types';

  let cases = $state<CaseSummary[] | null>(null);
  let error = $state<string | null>(null);
  let name = $state('');
  let creating = $state(false);

  $effect(() => {
    const controller = new AbortController();
    fetchCases(controller.signal)
      .then((response) => (cases = response.cases))
      .catch((reason: unknown) => {
        if (!isAbort(reason)) error = (reason as Error).message;
      });
    return () => controller.abort();
  });

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!name.trim()) return;
    creating = true;
    try {
      const { id } = await createCase({ name: name.trim() });
      await goto(`/cases/${id}`);
    } catch (reason) {
      error = (reason as Error).message;
      creating = false;
    }
  }
</script>

<svelte:head>
  <title>Cases | FluxFlow</title>
</svelte:head>

<article class="cases">
  <p><a href="/">Back to the dashboard</a></p>
  <h1>Cases</h1>
  <p class="muted">
    A case keeps a trail you found: the wallets in it, what you made of them, and the fund-flow
    graph view that showed it, so it can be reopened exactly. Add wallets from their pages, or save
    a graph as a case.
  </p>

  <form onsubmit={create} class="new">
    <label>
      <span>New case</span>
      <input
        bind:value={name}
        placeholder="Name it, e.g. Flux paying for its own apps"
        maxlength="120"
      />
    </label>
    <button type="submit" class="primary" disabled={creating || !name.trim()}>Create</button>
  </form>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {:else if cases === null}
    <p class="muted" aria-busy="true">Loading…</p>
  {:else if cases.length === 0}
    <p class="muted">No cases yet.</p>
  {:else}
    <ul class="list">
      {#each cases as item (item.id)}
        <li>
          <a href="/cases/{item.id}" class="name">{item.name}</a>
          <span class="muted small"
            >{formatCount(item.count)}
            {item.count === 1 ? 'wallet' : 'wallets'}, changed {formatDate(item.updatedAt)}</span
          >
          {#if item.description}<p class="muted small description">{item.description}</p>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</article>

<style>
  .cases {
    display: grid;
    gap: 1rem;
    padding-top: 1.25rem;
    max-width: 48rem;
  }

  h1 {
    margin: 0;
  }

  .new {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
    align-items: end;
  }

  .new label {
    display: grid;
    gap: 0.25rem;
    flex: 1 1 18rem;
  }

  input {
    min-height: 2.5rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
  }

  .primary {
    min-height: 2.5rem;
    padding: 0.4rem 0.9rem;
    border: 1px solid var(--brand);
    border-radius: var(--radius-s);
    background: var(--brand);
    color: var(--on-brand);
    font-weight: 500;
    cursor: pointer;
  }

  .list {
    display: grid;
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .list li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    align-items: baseline;
  }

  .name {
    font-weight: 600;
    min-height: 24px;
    line-height: 24px;
  }

  .description {
    flex-basis: 100%;
    margin: 0;
    white-space: pre-wrap;
  }

  .small {
    font-size: var(--step--1);
  }

  .error {
    color: var(--bad);
  }
</style>
