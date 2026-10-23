<!--
  The reader's own note and tags on a wallet, and the cases it is part of (#69).

  Notes are free text; tags are short words of the reader's choosing, comma separated in the
  form. Neither ever changes a label or a total. Saving an empty note with no tags removes it.
  A wallet can be added to an existing case, or start a new one, from here.
-->
<script lang="ts">
  import { isAbort } from '$lib/client/api';
  import {
    createCase,
    fetchCase,
    fetchCases,
    parseTags,
    saveNote,
    updateCase
  } from '$lib/client/endpoints';
  import { formatDate } from '$lib/client/format';
  import type { CaseSummary, WalletNote } from '$lib/client/types';

  interface Props {
    address: string;
    note: WalletNote | null;
    cases: { id: string; name: string }[];
  }

  let { address, note, cases }: Props = $props();

  // Local copies, so a save shows at once without reloading the page.
  let current = $state<WalletNote | null>(null);
  let member = $state<{ id: string; name: string }[]>([]);
  $effect(() => {
    current = note;
    member = cases;
  });

  let editing = $state(false);
  let draft = $state('');
  let tagDraft = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);

  function edit(): void {
    draft = current?.note ?? '';
    tagDraft = (current?.tags ?? []).join(', ');
    error = null;
    editing = true;
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    saving = true;
    error = null;
    try {
      const saved = await saveNote(address, { note: draft, tags: parseTags(tagDraft) });
      current = saved.note;
      editing = false;
    } catch (reason) {
      error = (reason as Error).message;
    } finally {
      saving = false;
    }
  }

  // Adding to a case: the list is loaded only when asked for.
  let allCases = $state<CaseSummary[] | null>(null);
  let choice = $state('');
  let newName = $state('');
  let adding = $state(false);

  async function openCases(): Promise<void> {
    try {
      allCases = (await fetchCases()).cases;
      choice = allCases.find((item) => !member.some((m) => m.id === item.id))?.id ?? '';
    } catch (reason) {
      if (!isAbort(reason)) error = (reason as Error).message;
    }
  }

  async function addToCase(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    adding = true;
    error = null;
    try {
      if (choice === 'new') {
        const name = newName.trim() || `Wallet ${address.slice(0, 8)}…`;
        const { id } = await createCase({ name, addresses: [address] });
        member = [{ id, name }, ...member];
      } else if (choice) {
        const existing = await fetchCase(choice);
        await updateCase(choice, { addresses: [...existing.addresses, address] });
        member = [{ id: choice, name: existing.name }, ...member];
      }
      allCases = null;
      newName = '';
    } catch (reason) {
      error = (reason as Error).message;
    } finally {
      adding = false;
    }
  }
</script>

<section aria-labelledby="note-heading" class="block notes">
  <h2 id="note-heading">Your notes</h2>

  {#if editing}
    <form onsubmit={save} class="form">
      <label>
        <span>Note</span>
        <textarea bind:value={draft} rows="4" maxlength="4000"></textarea>
      </label>
      <label>
        <span>Tags <span class="muted small">(comma separated, up to 10)</span></span>
        <input bind:value={tagDraft} placeholder="e.g. team, apps" autocomplete="off" />
      </label>
      <div class="actions">
        <button type="submit" class="primary" disabled={saving}
          >{saving ? 'Saving…' : 'Save'}</button
        >
        <button type="button" class="link" onclick={() => (editing = false)}>Cancel</button>
      </div>
    </form>
  {:else if current}
    {#if current.tags.length > 0}
      <ul class="tags" aria-label="Your tags">
        {#each current.tags as tag (tag)}<li class="tag">{tag}</li>{/each}
      </ul>
    {/if}
    {#if current.note}<p class="text">{current.note}</p>{/if}
    <p class="muted small">
      Last changed {formatDate(current.updatedAt)}.
      <button type="button" class="link" onclick={edit}>Edit</button>
    </p>
  {:else}
    <p class="muted">
      Nothing noted yet. <button type="button" class="link" onclick={edit}
        >Add a note or tags</button
      >
    </p>
  {/if}

  <div class="cases">
    {#if member.length > 0}
      <p>
        In {member.length === 1 ? 'case' : 'cases'}:
        {#each member as item, i (item.id)}{i > 0 ? ', ' : ''}<a href="/cases/{item.id}"
            >{item.name}</a
          >{/each}
      </p>
    {/if}
    {#if allCases === null}
      <button type="button" class="link" onclick={openCases}>Add to a case…</button>
    {:else}
      <form onsubmit={addToCase} class="add">
        <label>
          <span class="visually-hidden">Case</span>
          <select bind:value={choice}>
            {#each allCases.filter((item) => !member.some((m) => m.id === item.id)) as item (item.id)}
              <option value={item.id}>{item.name}</option>
            {/each}
            <option value="new">A new case…</option>
          </select>
        </label>
        {#if choice === 'new'}
          <label>
            <span class="visually-hidden">New case name</span>
            <input bind:value={newName} placeholder="Name the case" maxlength="120" />
          </label>
        {/if}
        <button type="submit" class="primary" disabled={adding || !choice}>Add</button>
        <button type="button" class="link" onclick={() => (allCases = null)}>Cancel</button>
      </form>
    {/if}
  </div>

  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <p class="muted small">
    Your own words, kept on this server. They never change how a wallet is labelled or counted.
  </p>
</section>

<style>
  .notes {
    display: grid;
    gap: 0.6rem;
  }

  h2 {
    margin: 0;
  }

  .text {
    margin: 0;
    white-space: pre-wrap;
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .tag {
    padding: 0 0.5rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: var(--step--1);
  }

  .form,
  .add {
    display: grid;
    gap: 0.6rem;
  }

  .add {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }

  .form label {
    display: grid;
    gap: 0.25rem;
  }

  textarea,
  input,
  select {
    min-height: 2.5rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
  }

  textarea {
    resize: vertical;
  }

  .actions {
    display: flex;
    gap: 1rem;
    align-items: center;
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

  .cases p {
    margin: 0 0 0.35rem;
  }

  .small {
    font-size: var(--step--1);
  }

  .error {
    color: var(--bad);
  }
</style>
