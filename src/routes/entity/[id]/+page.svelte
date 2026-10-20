<!--
  Entity page (#65): one owner behind many addresses — combined totals, who it deals with
  (grouped into entities too), its members and its latest movements.

  Moves between its own addresses are netted per transaction, exactly as on the Foundation
  page, so they never count as money in or out. Named entities can be renamed and pruned here
  by an admin who has signed in on the review page.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ApiError, isAbort, peek } from '$lib/client/api';
  import { entityPath, fetchEntity, fetchEntityBalance } from '$lib/client/endpoints';
  import {
    formatCount,
    formatFlux,
    formatFluxFull,
    formatSigned,
    formatTime,
    entityKindLabel,
    kindLabel,
    shortAddress,
    timeAgo
  } from '$lib/client/format';
  import { live } from '$lib/client/live.svelte';
  import {
    AdminError,
    deleteEntity,
    readToken,
    removeMember,
    renameEntity
  } from '$lib/client/review';
  import type { EntityParty, EntityReport, MemberSource } from '$lib/client/types';
  import { isPeriodId, type PeriodId } from '$lib/shared/constants';
  import PeriodTabs from '$lib/ui/PeriodTabs.svelte';
  import BalancePanel from '$lib/ui/BalancePanel.svelte';

  const DEFAULT: PeriodId = '30D';
  const id = $derived(page.params.id ?? '');
  const period = $derived.by((): PeriodId => {
    const raw = (page.url.searchParams.get('period') ?? '').toUpperCase();
    return isPeriodId(raw) ? raw : DEFAULT;
  });

  let data = $state<EntityReport | undefined>();
  let missing = $state(false);
  let error = $state<string | null>(null);
  let token = $state<string | null>(null);
  let editing = $state(false);
  let nameInput = $state('');
  let busy = $state(false);
  let allMembers = $state(false);

  /** Members listed before "Show all": a 100-row table buries everything below it. */
  const FIRST_MEMBERS = 20;
  const shownWallets = $derived(
    allMembers ? (data?.wallets ?? []) : (data?.wallets ?? []).slice(0, FIRST_MEMBERS)
  );

  onMount(() => {
    token = readToken();
  });

  $effect(() => live.start());

  $effect(() => {
    const current = id;
    const span = period;
    void live.version;
    const controller = new AbortController();
    data = peek<EntityReport>(entityPath(current, span)) ?? data;

    fetchEntity(current, span, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        data = result;
        missing = false;
        error = null;
      })
      .catch((reason: unknown) => {
        if (isAbort(reason)) return;
        if (reason instanceof ApiError && reason.status === 404) missing = true;
        else error = (reason as Error).message;
      });

    return () => controller.abort();
  });

  const SOURCE_TEXT: Record<MemberSource, string> = {
    label: 'labelled',
    manual: 'added by hand',
    cluster: 'linked by spending together'
  };
  const sourcesText = $derived.by(() => {
    if (!data) return '';
    return (Object.entries(data.memberSources) as [MemberSource, number][])
      .filter(([, count]) => count > 0)
      .map(([source, count]) => `${formatCount(count)} ${SOURCE_TEXT[source]}`)
      .join(', ');
  });

  const partyHref = (party: EntityParty) =>
    party.entity ? `/entity/${encodeURIComponent(party.entity.id)}` : `/wallet/${party.address}`;
  const percent = (share: number) =>
    share > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`;
  const now = Date.now();
  const stored = $derived(data?.entity.source === 'stored');

  async function admin(action: () => Promise<unknown>): Promise<void> {
    if (!token) return;
    busy = true;
    try {
      await action();
      error = null;
      // The change bumped the data version: refetch.
      data = await fetchEntity(id, period);
    } catch (reason) {
      error = reason instanceof AdminError ? reason.message : (reason as Error).message;
      if (reason instanceof ApiError && reason.status === 404) missing = true;
    } finally {
      busy = false;
    }
  }

  function saveName(event: SubmitEvent): void {
    event.preventDefault();
    const name = nameInput.trim();
    if (!name || !token) return;
    void admin(() => renameEntity(token!, id, { name })).then(() => (editing = false));
  }

  async function remove(): Promise<void> {
    if (!token || !data) return;
    busy = true;
    try {
      await deleteEntity(token, id);
      await goto('/entities');
    } catch (reason) {
      error = (reason as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>{data?.entity.name ?? 'Entity'} | FluxFlow</title>
</svelte:head>

<article class="entity">
  <p><a href="/entities">All entities</a></p>

  {#if missing}
    <h1>No such entity</h1>
    <p class="muted">
      It may have been renamed or removed. <a href="/entities">See all entities</a>.
    </p>
  {:else}
    <header>
      {#if editing}
        <form class="rename" onsubmit={saveName}>
          <label>
            Name
            <input bind:value={nameInput} maxlength="100" required />
          </label>
          <button type="submit" class="button" disabled={busy}>Save</button>
          <button type="button" class="button" onclick={() => (editing = false)}>Cancel</button>
        </form>
      {:else}
        <h1>{data?.entity.name ?? 'Loading…'}</h1>
      {/if}
      {#if data}
        <p class="muted">
          {entityKindLabel(data.entity.kind)} · {formatCount(data.entity.members)}
          {data.entity.members === 1 ? 'address' : 'addresses'}{sourcesText
            ? ` (${sourcesText})`
            : ''}
          · {data.entity.source === 'label' ? 'grouped by its label' : 'named on the review page'}
        </p>
        {#if stored && token && !editing}
          <div class="actions">
            <button
              type="button"
              class="button"
              onclick={() => {
                nameInput = data?.entity.name ?? '';
                editing = true;
              }}>Rename</button
            >
            <button type="button" class="button danger" disabled={busy} onclick={remove}>
              Delete entity
            </button>
          </div>
        {/if}
      {/if}
    </header>

    <PeriodTabs
      current={period}
      href={(p) =>
        p === DEFAULT
          ? `/entity/${encodeURIComponent(id)}`
          : `/entity/${encodeURIComponent(id)}?period=${p}`}
    />

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    {#if !data}
      <p class="muted" aria-busy="true">Loading…</p>
    {:else}
      <dl class="facts">
        <div>
          <dt>Received</dt>
          <dd class="buy" title="{formatFluxFull(data.totals.inflow)} FLUX">
            {formatFlux(data.totals.inflow)}
          </dd>
        </div>
        <div>
          <dt>Sent</dt>
          <dd class="sell" title="{formatFluxFull(data.totals.outflow)} FLUX">
            {formatFlux(data.totals.outflow)}
          </dd>
        </div>
        <div>
          <dt>Net</dt>
          <dd class={data.totals.net < 0 ? 'sell' : data.totals.net > 0 ? 'buy' : ''}>
            {formatSigned(data.totals.net)}
          </dd>
        </div>
        <div>
          <dt>Between its own addresses</dt>
          <dd class="small-dd">
            {formatCount(data.totals.internalTransfers)} moves, {formatFlux(
              data.totals.internalVolume
            )} FLUX
          </dd>
        </div>
        {#if data.appPayments.count > 0}
          <div>
            <dt>Paid for Flux apps</dt>
            <dd class="small-dd">
              {formatFlux(data.appPayments.total)} FLUX in {formatCount(data.appPayments.count)} payments
            </dd>
          </div>
        {/if}
      </dl>
      <p class="muted small">
        {data.label}: {formatTime(data.fromTime)} to {formatTime(data.toTime)}. Money moving between
        its own addresses is not counted as received or sent.
      </p>

      <BalancePanel
        key={id}
        subject="its addresses"
        load={(signal) => fetchEntityBalance(id, signal)}
      />

      <section aria-labelledby="parties-heading" class="block">
        <h2 id="parties-heading">Who it deals with</h2>
        <div class="sides">
          {#each [{ side: data.incoming, title: 'Received from', column: 'From' }, { side: data.outgoing, title: 'Sent to', column: 'To' }] as group (group.title)}
            <div>
              <h3>
                {group.title}
                <span class="muted small">{formatFlux(group.side.total)} FLUX</span>
              </h3>
              {#if group.side.parties.length === 0}
                <p class="muted small">Nothing in this period.</p>
              {:else}
                <table>
                  <caption class="visually-hidden">
                    {group.title}, largest first; addresses of one entity are combined
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{group.column}</th>
                      <th scope="col" class="num">FLUX</th>
                      <th scope="col" class="num">Share</th>
                      <th scope="col" class="num">Last</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each group.side.parties as party (party.entity?.id ?? party.address)}
                      <tr>
                        <td>
                          <a href={partyHref(party)} class:mono={!party.name}>
                            {party.name ?? shortAddress(party.address)}
                          </a>
                          <span class="muted small">
                            {kindLabel(party.kind)}{party.entity && party.entity.members > 1
                              ? ` · ${formatCount(party.entity.members)} addresses`
                              : ''}
                          </span>
                        </td>
                        <td class="num" title="{formatFluxFull(party.total)} FLUX">
                          {formatFlux(party.total)}
                        </td>
                        <td class="num muted">{percent(party.share)}</td>
                        <td class="num muted small">{timeAgo(party.lastSeen, now)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
            </div>
          {/each}
        </div>
      </section>

      <section aria-labelledby="members-heading" class="block">
        <h2 id="members-heading">
          Addresses
          {#if data.entity.members > data.wallets.length}
            <span class="muted small">
              the {formatCount(data.wallets.length)} most active of {formatCount(
                data.entity.members
              )}
            </span>
          {/if}
        </h2>
        <table class="wallets">
          <caption class="visually-hidden">This entity's addresses, most active first</caption>
          <thead>
            <tr>
              <th scope="col">Address</th>
              <th scope="col" class="num">Received</th>
              <th scope="col" class="num">Sent</th>
              <th scope="col" class="num">Net</th>
              {#if stored && token}<th scope="col"><span class="visually-hidden">Remove</span></th
                >{/if}
            </tr>
          </thead>
          <tbody>
            {#each shownWallets as wallet (wallet.address)}
              <tr>
                <td>
                  <a href="/wallet/{wallet.address}" class="mono"
                    >{shortAddress(wallet.address, 8)}</a
                  >
                  <span class="muted small">
                    {wallet.subLabel ?? wallet.name ?? ''}{wallet.subLabel || wallet.name
                      ? ' · '
                      : ''}{SOURCE_TEXT[wallet.source]}
                  </span>
                </td>
                <td class="num buy">{wallet.inflow ? formatFlux(wallet.inflow) : ''}</td>
                <td class="num sell">{wallet.outflow ? formatFlux(wallet.outflow) : ''}</td>
                <td class="num {wallet.net < 0 ? 'sell' : wallet.net > 0 ? 'buy' : 'muted'}">
                  {wallet.net ? formatSigned(wallet.net) : '0'}
                </td>
                {#if stored && token}
                  <td>
                    {#if wallet.source === 'manual'}
                      <button
                        type="button"
                        class="link"
                        disabled={busy}
                        onclick={() => admin(() => removeMember(token!, id, wallet.address))}
                      >
                        Remove
                      </button>
                    {/if}
                  </td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
        {#if data.wallets.length > shownWallets.length}
          <button type="button" class="button more" onclick={() => (allMembers = true)}>
            Show all {formatCount(data.wallets.length)}
          </button>
        {/if}
        {#if stored && token && data.memberSources.cluster > 0}
          <p class="muted small">
            Addresses that spend with the others come with their cluster: they leave only if the
            entity is deleted or the clustering stops linking them.
          </p>
        {/if}
      </section>

      <section aria-labelledby="recent-heading" class="block">
        <h2 id="recent-heading">Latest movements</h2>
        {#if data.recent.length === 0}
          <p class="muted">No FLUX moved in or out in this period.</p>
        {:else}
          <ul class="recent">
            {#each data.recent as move (move.txid)}
              <li>
                <span class="amount {move.amount < 0 ? 'sell' : 'buy'}">
                  {move.amount < 0 ? 'Sent' : 'Received'}
                  {formatFlux(Math.abs(move.amount))}
                </span>
                <span>
                  {#if move.counterparty}
                    {move.amount < 0 ? 'to' : 'from'}
                    <a href="/wallet/{move.counterparty}" class:mono={!move.counterpartyName}>
                      {move.counterpartyName ?? shortAddress(move.counterparty)}
                    </a>
                    <span class="muted">({kindLabel(move.counterpartyKind)})</span>
                  {/if}
                </span>
                <a class="muted small when" href="/tx/{move.txid}" title={formatTime(move.time)}
                  >{timeAgo(move.time, now)}</a
                >
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  {/if}
</article>

<style>
  .entity {
    display: grid;
    gap: 1.5rem;
    padding-top: 1.5rem;
  }

  header {
    display: grid;
    gap: 0.4rem;
  }

  h1 {
    margin: 0;
    font-size: var(--step-2);
    overflow-wrap: anywhere;
  }

  header p {
    margin: 0;
  }

  .actions,
  .rename {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.5rem;
  }

  .rename label {
    display: grid;
    gap: 0.2rem;
    font-size: var(--step--1);
    color: var(--text-muted);
  }

  input {
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    min-width: min(20rem, 70vw);
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

  .button.more {
    justify-self: start;
  }

  .button.danger {
    color: var(--bad);
  }

  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--bad);
    font: inherit;
    font-size: var(--step--1);
    text-decoration: underline;
    cursor: pointer;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: 1rem 1.5rem;
    margin: 0;
  }

  dt {
    font-size: var(--step--1);
    color: var(--text-muted);
  }

  dd {
    margin: 0;
    font-size: var(--step-2);
    font-weight: 600;
  }

  .small-dd {
    font-size: var(--step-0);
    font-weight: 500;
  }

  .block {
    display: grid;
    gap: 0.75rem;
  }

  h2 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.6rem;
    margin: 0;
  }

  .sides {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
    gap: 1.25rem 2rem;
  }

  h3 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.6rem;
    margin: 0 0 0.25rem;
    font-size: var(--step-0);
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
    vertical-align: top;
  }

  td:first-child > * {
    display: block;
  }

  .num {
    text-align: right;
    white-space: nowrap;
  }

  td.num {
    font-weight: 600;
  }

  th:last-child,
  td:last-child {
    padding-right: 0;
  }

  .recent {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .recent li {
    display: grid;
    grid-template-columns: 9rem minmax(0, 1fr) auto;
    gap: 0.75rem;
    padding: 0.5rem 0;
    border-top: 1px solid var(--line);
  }

  .amount {
    font-weight: 600;
  }

  .small {
    font-size: var(--step--1);
  }

  .error {
    color: var(--bad);
  }

  @media (max-width: 640px) {
    .wallets th:nth-child(2),
    .wallets td:nth-child(2),
    .wallets th:nth-child(3),
    .wallets td:nth-child(3) {
      display: none;
    }

    .recent li {
      grid-template-columns: 1fr auto;
    }

    .recent li > :nth-child(2) {
      grid-column: 1 / -1;
      grid-row: 2;
    }
  }
</style>
