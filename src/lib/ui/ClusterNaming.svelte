<!--
  Name the unnamed (#65): the largest co-spend clusters nobody has named, each with a form to
  name it as a new entity or add it to a named one. Admin only; used on the review page.

  Naming a cluster never labels anything: totals by kind and the exchange figures are
  unchanged. It groups and names the addresses everywhere they are shown.
-->
<script lang="ts">
  import { fetchClusters, fetchEntities } from '$lib/client/endpoints';
  import { formatCount, formatFlux, kindLabel, shortAddress } from '$lib/client/format';
  import { addToEntity, nameCluster } from '$lib/client/review';
  import type { ClusterSummary, EntityRef } from '$lib/client/types';

  let { token, onError }: { token: string; onError: (reason: unknown) => void } = $props();

  const KINDS = ['unknown', 'node_operator', 'exchange', 'foundation', 'app_hosting'] as const;

  let clusters = $state<ClusterSummary[] | undefined>();
  let named = $state<EntityRef[]>([]);
  let names = $state<Record<string, string>>({});
  let kinds = $state<Record<string, string>>({});
  let targets = $state<Record<string, string>>({});
  let busy = $state<string | null>(null);
  let done = $state<{ id: string; name: string; size: number } | null>(null);
  let reload = $state(0);

  $effect(() => {
    void reload;
    const controller = new AbortController();
    Promise.all([fetchClusters(true, controller.signal), fetchEntities('', controller.signal)])
      .then(([result, list]) => {
        if (controller.signal.aborted) return;
        clusters = result.clusters;
        named = list.entities.filter((entity) => entity.source === 'stored');
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) onError(reason);
      });
    return () => controller.abort();
  });

  async function create(cluster: ClusterSummary, event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const name = (names[cluster.anchor] ?? '').trim();
    if (!name) return;
    busy = cluster.anchor;
    try {
      const result = await nameCluster(
        token,
        cluster.anchor,
        name,
        kinds[cluster.anchor] ?? 'unknown'
      );
      done = { id: result.id, name, size: cluster.size };
      reload++;
    } catch (reason) {
      onError(reason);
    } finally {
      busy = null;
    }
  }

  async function add(cluster: ClusterSummary): Promise<void> {
    const id = targets[cluster.anchor];
    const entity = named.find((candidate) => candidate.id === id);
    if (!entity) return;
    busy = cluster.anchor;
    try {
      await addToEntity(token, entity.id, { clusterOf: [cluster.anchor] });
      done = { id: entity.id, name: entity.name, size: cluster.size };
      reload++;
    } catch (reason) {
      onError(reason);
    } finally {
      busy = null;
    }
  }
</script>

<section id="clusters" aria-labelledby="clusters-heading" class="clusters">
  <h2 id="clusters-heading">Name a group of addresses</h2>
  <p class="muted small">
    Addresses spent together in one transaction usually have one owner. Naming a group makes it an
    entity: its addresses are added up on one page and called by that name everywhere. It changes no
    label and no exchange total. New addresses that clustering links to the group join it
    automatically.
  </p>

  {#if done}
    <p class="outcome" role="status">
      {formatCount(done.size)} addresses are now part of
      <a href="/entity/{encodeURIComponent(done.id)}">{done.name}</a>.
    </p>
  {/if}

  {#if !clusters}
    <p class="muted" aria-busy="true">Loading groups…</p>
  {:else if clusters.length === 0}
    <p class="muted">Every group of addresses that spend together is already named.</p>
  {:else}
    <ul>
      {#each clusters as cluster (cluster.anchor)}
        <li>
          <div class="facts">
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
            {#if cluster.entities.length > 0}
              <span class="muted small">
                Already partly in
                {#each cluster.entities as entity, i (entity.id)}{i > 0 ? ', ' : ' '}<a
                    href="/entity/{encodeURIComponent(entity.id)}">{entity.name}</a
                  >
                  ({formatCount(entity.members)}){/each}; {formatCount(cluster.unassigned)} not.
              </span>
            {/if}
          </div>
          <form class="row" onsubmit={(event) => create(cluster, event)}>
            <label>
              Name
              <input
                bind:value={names[cluster.anchor]}
                maxlength="100"
                placeholder="e.g. Operator X"
                required
              />
            </label>
            <label>
              Kind
              <select bind:value={kinds[cluster.anchor]}>
                {#each KINDS as kind (kind)}
                  <option value={kind}>{kind === 'unknown' ? 'Not sure' : kindLabel(kind)}</option>
                {/each}
              </select>
            </label>
            <button type="submit" class="button" disabled={busy !== null}>Name it</button>
          </form>
          {#if named.length > 0}
            <div class="row">
              <label>
                Or add to
                <select bind:value={targets[cluster.anchor]}>
                  <option value="">Choose an entity</option>
                  {#each named as entity (entity.id)}
                    <option value={entity.id}>{entity.name}</option>
                  {/each}
                </select>
              </label>
              <button
                type="button"
                class="button"
                disabled={busy !== null || !targets[cluster.anchor]}
                onclick={() => add(cluster)}>Add</button
              >
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .clusters {
    display: grid;
    gap: 0.75rem;
  }

  h2 {
    margin: 0;
  }

  p {
    margin: 0;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: grid;
    gap: 0.6rem;
    padding: 0.9rem 0;
    border-top: 1px solid var(--line);
  }

  .facts {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.75rem;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.5rem;
  }

  label {
    display: grid;
    gap: 0.2rem;
    font-size: var(--step--1);
    color: var(--text-muted);
  }

  input,
  select {
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    color: var(--text);
    font: inherit;
  }

  input {
    min-width: min(16rem, 70vw);
  }

  .button {
    padding: 0.45rem 0.8rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }

  .button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .outcome {
    padding: 0.6rem 0.8rem;
    border-left: 3px solid var(--good);
    background: var(--surface);
  }

  .small {
    font-size: var(--step--1);
  }
</style>
