<!--
  One case (#69): its name and description, its wallets with their labels and notes, and the
  saved fund-flow graph view. Everything is editable in place; deleting asks twice, without a
  browser dialog.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ApiError, isAbort } from '$lib/client/api';
  import { deleteCase, fetchCase, graphHref, isAddress, updateCase } from '$lib/client/endpoints';
  import { formatDate, kindLabel, shortAddress } from '$lib/client/format';
  import type { CaseDetail } from '$lib/client/types';

  const id = $derived(page.params.id ?? '');

  let item = $state<CaseDetail | null>(null);
  let missing = $state(false);
  let error = $state<string | null>(null);
  let version = $state(0);

  $effect(() => {
    const current = id;
    void version;
    const controller = new AbortController();
    fetchCase(current, controller.signal)
      .then((response) => {
        item = response;
        missing = false;
      })
      .catch((reason: unknown) => {
        if (isAbort(reason)) return;
        if (reason instanceof ApiError && reason.status === 404) missing = true;
        else error = (reason as Error).message;
      });
    return () => controller.abort();
  });

  async function change(patch: Parameters<typeof updateCase>[1]): Promise<void> {
    error = null;
    try {
      await updateCase(id, patch);
      version++;
    } catch (reason) {
      error = (reason as Error).message;
    }
  }

  // Name and description: edited together.
  let editing = $state(false);
  let nameDraft = $state('');
  let descriptionDraft = $state('');

  function edit(): void {
    nameDraft = item?.name ?? '';
    descriptionDraft = item?.description ?? '';
    editing = true;
  }

  async function saveText(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!nameDraft.trim()) return;
    await change({ name: nameDraft, description: descriptionDraft });
    editing = false;
  }

  let addressDraft = $state('');
  const draftValid = $derived(isAddress(addressDraft.trim()));

  async function addAddress(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!item || !draftValid) return;
    await change({ addresses: [...item.addresses, addressDraft.trim()] });
    addressDraft = '';
  }

  const removeAddress = (address: string) =>
    item && change({ addresses: item.addresses.filter((other) => other !== address) });

  let confirming = $state(false);
  async function remove(): Promise<void> {
    try {
      await deleteCase(id);
      await goto('/cases');
    } catch (reason) {
      error = (reason as Error).message;
    }
  }
</script>

<svelte:head>
  <title>{item ? `${item.name} | Cases` : 'Case'} | FluxFlow</title>
</svelte:head>

<article class="case">
  <p><a href="/cases">All cases</a></p>

  {#if missing}
    <h1>No such case</h1>
    <p class="muted">It may have been deleted.</p>
  {:else if !item}
    <p class="muted" aria-busy="true">Loading…</p>
  {:else}
    {#if editing}
      <form onsubmit={saveText} class="text-form">
        <label>
          <span>Name</span>
          <input bind:value={nameDraft} maxlength="120" />
        </label>
        <label>
          <span>What you found</span>
          <textarea bind:value={descriptionDraft} rows="5" maxlength="4000"></textarea>
        </label>
        <div class="actions">
          <button type="submit" class="primary" disabled={!nameDraft.trim()}>Save</button>
          <button type="button" class="link" onclick={() => (editing = false)}>Cancel</button>
        </div>
      </form>
    {:else}
      <h1>{item.name}</h1>
      {#if item.description}<p class="description">{item.description}</p>{/if}
      <p class="muted small">
        Started {formatDate(item.createdAt)}, changed {formatDate(item.updatedAt)}.
        <button type="button" class="link" onclick={edit}>Edit name and description</button>
      </p>
    {/if}

    {#if item.graph}
      <p>
        <a class="button" href={graphHref(item.graph)}>Open the saved graph</a>
        <span class="muted small"
          >from {shortAddress(item.graph.root)}, {item.graph.expand.length}
          {item.graph.expand.length === 1 ? 'expansion' : 'expansions'}</span
        >
        <button type="button" class="link" onclick={() => change({ graph: null })}>Forget it</button
        >
      </p>
    {/if}

    <section aria-labelledby="members-heading" class="block">
      <h2 id="members-heading">
        Wallets <span class="muted small">{item.members.length}</span>
      </h2>
      {#if item.members.length === 0}
        <p class="muted">None yet. Add one below, or from a wallet's page.</p>
      {:else}
        <ul class="members">
          {#each item.members as member (member.address)}
            <li>
              <span class="who">
                <a href="/wallet/{member.address}" class:mono={!member.name} title={member.address}
                  >{member.name ?? shortAddress(member.address)}</a
                >
                <span class="muted small">{kindLabel(member.kind)}</span>
                {#each member.note?.tags ?? [] as tag (tag)}<span class="tag">{tag}</span>{/each}
              </span>
              {#if member.note?.note}<span class="muted small note">{member.note.note}</span>{/if}
              <button
                type="button"
                class="link remove"
                aria-label="Remove {member.name ?? member.address} from this case"
                onclick={() => removeAddress(member.address)}>Remove</button
              >
            </li>
          {/each}
        </ul>
      {/if}

      <form onsubmit={addAddress} class="add">
        <label>
          <span class="visually-hidden">Wallet address to add</span>
          <input
            class="mono"
            bind:value={addressDraft}
            placeholder="Add a wallet: t1… or t3…"
            autocomplete="off"
            spellcheck="false"
            aria-invalid={addressDraft !== '' && !draftValid}
          />
        </label>
        <button type="submit" class="primary" disabled={!draftValid}>Add</button>
      </form>
    </section>

    {#if error}<p class="error" role="alert">{error}</p>{/if}

    <p class="danger-zone">
      {#if confirming}
        <span>Delete this case? Notes on its wallets stay.</span>
        <button type="button" class="danger" onclick={remove}>Yes, delete it</button>
        <button type="button" class="link" onclick={() => (confirming = false)}>Keep it</button>
      {:else}
        <button type="button" class="link" onclick={() => (confirming = true)}
          >Delete this case…</button
        >
      {/if}
    </p>
  {/if}
</article>

<style>
  .case {
    display: grid;
    gap: 1rem;
    padding-top: 1.25rem;
    max-width: 48rem;
  }

  h1,
  h2 {
    margin: 0;
  }

  .description {
    margin: 0;
    white-space: pre-wrap;
  }

  .text-form,
  .text-form label {
    display: grid;
    gap: 0.5rem;
  }

  input,
  textarea {
    min-height: 2.5rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
  }

  textarea {
    resize: vertical;
  }

  .actions,
  .add {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
    align-items: center;
  }

  .add label {
    flex: 1 1 22rem;
    display: grid;
  }

  .members {
    display: grid;
    gap: 0.6rem;
    margin: 0 0 0.75rem;
    padding: 0;
    list-style: none;
  }

  .members li {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.15rem 0.75rem;
    align-items: baseline;
  }

  .who {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.6rem;
    align-items: baseline;
  }

  .who a {
    min-height: 24px;
    line-height: 24px;
  }

  .note {
    grid-column: 1;
    white-space: pre-wrap;
  }

  .remove {
    grid-column: 2;
    grid-row: 1;
  }

  .tag {
    padding: 0 0.45rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: var(--step--1);
  }

  .button {
    display: inline-block;
    padding: 0.5rem 0.9rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    font-weight: 500;
    text-decoration: none;
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

  .link {
    min-height: 24px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--brand);
    text-decoration: underline;
    cursor: pointer;
  }

  .danger-zone {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    align-items: center;
  }

  .danger {
    min-height: 2.5rem;
    padding: 0.4rem 0.9rem;
    border: 1px solid var(--bad);
    border-radius: var(--radius-s);
    background: none;
    color: var(--bad);
    font-weight: 500;
    cursor: pointer;
  }

  .small {
    font-size: var(--step--1);
  }

  .error {
    color: var(--bad);
  }
</style>
