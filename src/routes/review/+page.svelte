<!--
  Label review (#20), admin only: exchange addresses proposed by clustering and sweep detection
  (and any later method), grouped by exchange and method, strongest evidence first. Accepting
  turns a group into labels in one decision; the flows they touched are re-derived in the
  background. Rejecting an accepted candidate removes its label again.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import {
    formatCount,
    formatFlux,
    formatTime,
    kindLabel,
    shortAddress,
    timeAgo
  } from '$lib/client/format';
  import {
    activityText,
    AdminError,
    candidateId,
    clearToken,
    decideBulk,
    decisionPreview,
    evidenceItems,
    fetchReview,
    groupCandidates,
    methodName,
    methodText,
    readToken,
    saveToken,
    type CandidateStatus,
    type Decision,
    type ReviewResponse
  } from '$lib/client/review';

  const STATUSES: { id: CandidateStatus; label: string }[] = [
    { id: 'pending', label: 'To review' },
    { id: 'accepted', label: 'Accepted' },
    { id: 'rejected', label: 'Rejected' }
  ];

  let mounted = $state(false);
  let token = $state<string | null>(null);
  let tokenInput = $state('');
  let status = $state<CandidateStatus>('pending');
  let data = $state<ReviewResponse | undefined>();
  let error = $state<string | null>(null);
  let loading = $state(false);
  let busy = $state(false);
  let outcome = $state<string | null>(null);
  const selected = new SvelteSet<string>();

  onMount(() => {
    token = readToken();
    mounted = true;
  });

  function signIn(event: SubmitEvent): void {
    event.preventDefault();
    const value = tokenInput.trim();
    if (!value) return;
    saveToken(value);
    token = value;
    tokenInput = '';
    error = null;
  }

  function signOut(): void {
    clearToken();
    token = null;
    data = undefined;
    selected.clear();
  }

  function handleError(reason: unknown): void {
    if (reason instanceof DOMException && reason.name === 'AbortError') return;
    if (reason instanceof AdminError && reason.unauthorized) {
      clearToken();
      token = null;
      data = undefined;
    }
    error = (reason as Error).message;
  }

  let reload = $state(0);

  $effect(() => {
    const current = token;
    const which = status;
    void reload;
    if (!current) return;

    const controller = new AbortController();
    loading = true;
    fetchReview(current, which, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        data = result;
        error = null;
        // Keep only selections still on screen.
        const visible = new Set(result.candidates.map(candidateId));
        for (const id of [...selected]) if (!visible.has(id)) selected.delete(id);
      })
      .catch(handleError)
      .finally(() => {
        if (!controller.signal.aborted) loading = false;
      });

    return () => controller.abort();
  });

  function show(next: CandidateStatus): void {
    if (next === status) return;
    status = next;
    selected.clear();
    outcome = null;
  }

  const groups = $derived(data && data.status === status ? groupCandidates(data.candidates) : []);
  const chosen = $derived((data?.candidates ?? []).filter((c) => selected.has(candidateId(c))));
  const decisions = $derived<Decision[]>(
    status === 'pending'
      ? ['accepted', 'rejected']
      : status === 'accepted'
        ? ['rejected']
        : ['accepted']
  );

  function toggleGroup(ids: string[], on: boolean): void {
    for (const id of ids) {
      if (on) selected.add(id);
      else selected.delete(id);
    }
  }

  function toggle(id: string): void {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
  }

  async function decide(decision: Decision): Promise<void> {
    if (!token || chosen.length === 0 || busy) return;
    busy = true;
    outcome = null;
    try {
      const result = await decideBulk(token, decision, chosen);
      const verb = decision === 'accepted' ? 'Accepted' : 'Rejected';
      outcome =
        `${verb} ${formatCount(result.decided)} ${result.decided === 1 ? 'address' : 'addresses'}. ` +
        (result.changedAddresses > 0
          ? `${formatCount(result.changedAddresses)} labels changed; re-deriving ${formatCount(
              result.transactions
            )} transactions in the background.`
          : 'No label changed: they were already decided this way.');
      selected.clear();
      reload++;
    } catch (reason) {
      handleError(reason);
    } finally {
      busy = false;
    }
  }

  /** `indeterminate` is a property, not an attribute. */
  function indeterminate(node: HTMLInputElement, value: boolean) {
    node.indeterminate = value;
    return {
      update(next: boolean) {
        node.indeterminate = next;
      }
    };
  }

  const now = Date.now();
</script>

<svelte:head>
  <title>Label review | FluxFlow</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<article class="review">
  <p><a href="/">Back to the dashboard</a></p>
  <h1>Label review</h1>
  <p class="muted lede">
    Addresses FluxFlow thinks belong to an exchange. Nothing counts until you accept it; accepting a
    deposit address turns transfers into it into sales at the moment they happened.
  </p>

  {#if !mounted}
    <p class="muted" aria-busy="true">Loading…</p>
  {:else if !token}
    <form class="signin" onsubmit={signIn}>
      <label for="admin-token">Admin token</label>
      <div class="row">
        <input
          id="admin-token"
          type="password"
          autocomplete="off"
          spellcheck="false"
          bind:value={tokenInput}
          placeholder="ADMIN_TOKEN"
        />
        <button type="submit" class="primary" disabled={!tokenInput.trim()}>Open review</button>
      </div>
      <p class="muted small">Kept for this browser tab only, and sent only to this server.</p>
      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}
    </form>
  {:else}
    <div class="bar">
      <div class="tabs" role="group" aria-label="Show">
        {#each STATUSES as tab (tab.id)}
          <button type="button" aria-pressed={status === tab.id} onclick={() => show(tab.id)}>
            {tab.label}
            {#if data}<span class="count">{formatCount(data.counts[tab.id])}</span>{/if}
          </button>
        {/each}
      </div>
      <button type="button" class="link" onclick={signOut}>Forget token</button>
    </div>

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
    {#if outcome}
      <p class="outcome" role="status">{outcome}</p>
    {/if}

    {#if !data && loading}
      <p class="muted" aria-busy="true">Loading candidates…</p>
    {:else if data && groups.length === 0}
      <p class="muted">
        {status === 'pending' ? 'Nothing to review.' : `No ${status} candidates.`}
      </p>
    {:else}
      {#each groups as group (group.key)}
        {@const ids = group.items.map(candidateId)}
        {@const picked = ids.filter((id) => selected.has(id)).length}
        <section class="group" aria-labelledby="g-{group.key}">
          <header>
            <label class="select-all">
              <input
                type="checkbox"
                checked={picked === ids.length}
                use:indeterminate={picked > 0 && picked < ids.length}
                onchange={(event) => toggleGroup(ids, event.currentTarget.checked)}
                aria-label="Select all {group.items.length} for {group.name}, {methodName(
                  group.method
                )}"
              />
              <h2 id="g-{group.key}">
                {group.name || kindLabel(group.kind)}
                <span class="muted">· {methodName(group.method)}</span>
              </h2>
            </label>
            <p class="muted small">
              {methodText(group.method)}. {formatCount(group.items.length)}
              {group.items.length === 1 ? 'address' : 'addresses'}, {formatFlux(group.sentFlux)} FLUX
              sent.
            </p>
          </header>

          <ul class="items">
            {#each group.items as candidate (candidateId(candidate))}
              {@const id = candidateId(candidate)}
              {@const evidence = evidenceItems(candidate.evidence)}
              <li class:picked={selected.has(id)}>
                <input
                  type="checkbox"
                  checked={selected.has(id)}
                  onchange={() => toggle(id)}
                  aria-label="Select {candidate.address}"
                />
                <div class="body">
                  <div class="head">
                    <a class="mono" href="/wallet/{candidate.address}" title={candidate.address}
                      >{shortAddress(candidate.address, 8)}</a
                    >
                    <a
                      class="muted small"
                      href="https://explorer.runonflux.io/address/{candidate.address}"
                      rel="noopener noreferrer"
                      target="_blank">explorer ↗</a
                    >
                    <span
                      class="strength"
                      title="Evidence strength {Math.round(candidate.strength * 100)}%"
                    >
                      <meter
                        min="0"
                        max="1"
                        low="0.35"
                        high="0.6"
                        optimum="1"
                        value={candidate.strength}
                      ></meter>
                      <span class="small">{Math.round(candidate.strength * 100)}%</span>
                    </span>
                  </div>

                  {#if candidate.currentLabel}
                    <p class="warn small">
                      Currently labelled {kindLabel(candidate.currentLabel.kind)}{candidate
                        .currentLabel.name
                        ? ` (${candidate.currentLabel.name})`
                        : ''}, from {candidate.currentLabel.source.replace(/_/g, ' ')}.
                    </p>
                  {/if}

                  <p>{activityText(candidate)}</p>

                  <p class="muted small">
                    {#if candidate.activity.firstSeen !== null}
                      Seen
                      <span title={formatTime(candidate.activity.firstSeen)}
                        >{timeAgo(candidate.activity.firstSeen, now)}</span
                      >
                      {#if candidate.activity.lastSeen !== candidate.activity.firstSeen}
                        to <span title={formatTime(candidate.activity.lastSeen!)}
                          >{timeAgo(candidate.activity.lastSeen!, now)}</span
                        >
                      {/if}
                      · {formatCount(candidate.activity.txs)}
                      {candidate.activity.txs === 1 ? 'transaction' : 'transactions'} ·
                    {/if}
                    {Math.round(candidate.confidence * 100)}% method confidence
                  </p>

                  {#if evidence.length > 0}
                    <ul class="evidence small">
                      {#each evidence as item, index (index)}
                        <li>
                          <span class="muted">{item.label}</span>
                          {#if item.href}
                            <a
                              class="mono"
                              href={item.href}
                              {...item.external
                                ? { rel: 'noopener noreferrer', target: '_blank' }
                                : {}}>{item.text}</a
                            >
                          {:else}
                            {item.text}
                          {/if}
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    {/if}

    {#if chosen.length > 0}
      <div class="actions" role="region" aria-label="Decide the selected candidates">
        <p class="small">
          <strong>{formatCount(chosen.length)} selected.</strong>
          {decisionPreview(decisions[0]!, chosen)}
        </p>
        <div class="buttons">
          {#each decisions as decision (decision)}
            <button
              type="button"
              class={decision === 'accepted' ? 'primary' : 'danger'}
              disabled={busy}
              onclick={() => decide(decision)}
            >
              {decision === 'accepted' ? 'Accept' : 'Reject'}
              {formatCount(chosen.length)}
            </button>
          {/each}
          <button type="button" class="link" disabled={busy} onclick={() => selected.clear()}>
            Clear
          </button>
        </div>
      </div>
    {/if}
  {/if}
</article>

<style>
  .review {
    display: grid;
    gap: 1.25rem;
    padding-top: 1.5rem;
  }

  h1 {
    font-size: var(--step-2);
  }

  .lede {
    max-width: 65ch;
  }

  .small {
    font-size: var(--step--1);
  }

  .error {
    color: var(--bad);
  }

  .warn {
    color: var(--warn);
  }

  .outcome {
    padding: 0.6rem 0.8rem;
    border-radius: var(--radius-s);
    background: var(--surface-2);
  }

  .signin {
    display: grid;
    gap: 0.5rem;
    max-width: 32rem;
  }

  .row {
    display: flex;
    gap: 0.5rem;
  }

  .row input {
    flex: 1;
    min-width: 0;
  }

  input[type='password'] {
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    color: var(--text);
  }

  button {
    padding: 0.45rem 0.8rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .primary {
    background: var(--brand);
    border-color: var(--brand);
    color: #fff;
  }

  .danger {
    border-color: var(--bad);
    color: var(--bad);
  }

  .link {
    border: none;
    background: none;
    padding: 0.25rem;
    text-decoration: underline;
    color: var(--text-muted);
  }

  .bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .tabs {
    display: flex;
    gap: 0.25rem;
    flex-wrap: wrap;
  }

  .tabs button[aria-pressed='true'] {
    background: var(--surface-2);
    border-color: var(--brand);
    font-weight: 600;
  }

  .count {
    margin-left: 0.35rem;
    color: var(--text-muted);
    font-weight: 500;
  }

  .group {
    display: grid;
    gap: 0.5rem;
    padding: 0.9rem 1rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-m);
    background: var(--surface);
  }

  .select-all {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    cursor: pointer;
  }

  .select-all h2 {
    font-size: var(--step-1);
    margin: 0;
  }

  .items {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .items > li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 0.6rem;
    padding: 0.7rem 0;
    border-top: 1px solid var(--line);
  }

  .items > li.picked {
    background: color-mix(in srgb, var(--brand) 6%, transparent);
  }

  input[type='checkbox'] {
    width: 1.1rem;
    height: 1.1rem;
    margin-top: 0.15rem;
    accent-color: var(--brand);
  }

  .body {
    display: grid;
    gap: 0.3rem;
    min-width: 0;
  }

  .body p {
    margin: 0;
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .strength {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  meter {
    width: 5rem;
    height: 0.6rem;
  }

  .evidence {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .evidence li {
    display: inline-flex;
    gap: 0.35rem;
    min-width: 0;
  }

  .actions {
    position: sticky;
    bottom: 0.75rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    padding: 0.75rem 1rem;
    border: 1px solid var(--brand);
    border-radius: var(--radius-m);
    background: var(--surface);
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.15);
  }

  .actions p {
    margin: 0;
    flex: 1 1 18rem;
  }

  .buttons {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  @media (max-width: 640px) {
    .group {
      padding: 0.75rem;
    }

    .strength {
      margin-left: 0;
      flex-basis: 100%;
    }

    .actions {
      bottom: 0.5rem;
    }

    .buttons {
      width: 100%;
    }

    .buttons button:not(.link) {
      flex: 1;
    }
  }
</style>
