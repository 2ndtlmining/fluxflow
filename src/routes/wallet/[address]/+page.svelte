<!--
  Wallet page (#30): what this wallet moved to and from exchanges, where, when, and with whom.

  Exchange totals, the per-exchange split and the daily chart cover all stored history (they
  come from rollups); wallet-to-wallet totals, counterparties and the transfer list cover the
  raw retention window. The watchlist is kept in this browser.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { ApiError, isAbort } from '$lib/client/api';
  import {
    fetchBalance,
    fetchCounterparties,
    fetchWallet,
    fetchWalletEvents,
    isAddress
  } from '$lib/client/endpoints';
  import {
    evidenceText,
    sourceText,
    formatCount,
    formatFlux,
    formatFluxFull,
    formatSigned,
    formatTime,
    kindLabel,
    shortAddress,
    tagEvidenceText,
    tagLabel
  } from '$lib/client/format';
  import { live } from '$lib/client/live.svelte';
  import type { FlowEvent, FlowType, WalletCounterparties, WalletProfile } from '$lib/client/types';
  import { fillDays } from '$lib/client/series';
  import { isWatched, toggleWatch } from '$lib/client/watchlist';
  import Diverging from '$lib/ui/Diverging.svelte';
  import EventRows from '$lib/ui/EventRows.svelte';
  import SeriesChart from '$lib/ui/SeriesChart.svelte';
  import ConfidenceBadge from '$lib/ui/ConfidenceBadge.svelte';
  import NotePanel from '$lib/ui/NotePanel.svelte';
  import PartyTable from '$lib/ui/PartyTable.svelte';
  import FundsPanel from '$lib/ui/FundsPanel.svelte';
  import BalancePanel from '$lib/ui/BalancePanel.svelte';

  const address = $derived(page.params.address ?? '');
  const valid = $derived(isAddress(address));

  let profile = $state<WalletProfile | null>(null);
  let parties = $state<WalletCounterparties | null>(null);
  const internalMoves = $derived(
    (parties?.foundationMoves?.incoming.count ?? 0) +
      (parties?.foundationMoves?.outgoing.count ?? 0) >
      0
  );
  let missing = $state(false);
  let error = $state<string | null>(null);
  let watched = $state(false);
  let copied = $state(false);

  let type = $state<FlowType | ''>('');
  let events = $state<FlowEvent[]>([]);
  let cursor = $state<string | null>(null);
  let eventsLoading = $state(true);
  let loadingMore = $state(false);

  $effect(() => live.start());

  // Effects run in the browser only, which is where the watchlist lives.
  $effect(() => {
    watched = isWatched(address);
  });

  $effect(() => {
    const current = address;
    void live.version;
    if (!isAddress(current)) return;
    const controller = new AbortController();

    fetchWallet(current, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        profile = result;
        missing = false;
        error = null;
      })
      .catch((reason: unknown) => {
        if (isAbort(reason)) return;
        if (reason instanceof ApiError && reason.status === 404) {
          missing = true;
          profile = null;
        } else {
          error = (reason as Error).message;
        }
      });

    return () => controller.abort();
  });

  // Who it deals with: loaded on its own so a busy wallet's grouping never holds up the page.
  $effect(() => {
    const current = address;
    void live.version;
    if (!isAddress(current)) return;
    const controller = new AbortController();

    fetchCounterparties(current, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) parties = result;
      })
      .catch((reason: unknown) => {
        if (!isAbort(reason)) parties = null;
      });

    return () => controller.abort();
  });

  $effect(() => {
    const current = address;
    const filter = type;
    if (!isAddress(current)) return;
    const controller = new AbortController();
    eventsLoading = true;

    fetchWalletEvents(current, { type: filter || null }, controller.signal)
      .then((pageData) => {
        if (controller.signal.aborted) return;
        events = pageData.events;
        cursor = pageData.nextCursor;
      })
      .catch((reason: unknown) => {
        if (!isAbort(reason) && !(reason instanceof ApiError && reason.status === 404)) {
          error = (reason as Error).message;
        }
        if (!isAbort(reason)) events = [];
      })
      .finally(() => {
        if (!controller.signal.aborted) eventsLoading = false;
      });

    return () => controller.abort();
  });

  async function loadMore(): Promise<void> {
    if (!cursor || loadingMore) return;
    loadingMore = true;
    try {
      const next = await fetchWalletEvents(address, { type: type || null, cursor });
      events = [...events, ...next.events];
      cursor = next.nextCursor;
    } catch (reason) {
      error = (reason as Error).message;
    } finally {
      loadingMore = false;
    }
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(address);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      /* clipboard blocked: the address is selectable text */
    }
  }

  const exchangeRows = $derived(
    (profile?.byExchange ?? []).map((entry) => ({
      key: entry.name,
      label: entry.name,
      buy: entry.bought,
      sell: entry.sold
    }))
  );

  // The profile lists only days with activity; fill the gaps so the chart is a true timeline.
  const points = $derived(fillDays(profile?.series ?? []));
</script>

<svelte:head>
  <title>{profile?.name ?? `Wallet ${address.slice(0, 8)}…`} | FluxFlow</title>
</svelte:head>

<article class="wallet">
  <p><a href="/">Back to the dashboard</a></p>

  {#if !valid}
    <h1>That isn't a FLUX address</h1>
    <p class="muted">FLUX addresses start with t1 or t3 and are 35 characters long.</p>
  {:else}
    <header>
      {#if profile?.name}
        <h1>{profile.name}</h1>
        <p class="mono address muted">{address}</p>
      {:else}
        <h1 class="mono address">{address}</h1>
      {/if}
      {#if profile?.entity}
        <p class="entity-link">
          Part of
          <a href="/entity/{encodeURIComponent(profile.entity.id)}">{profile.entity.name}</a>
          <span class="muted">
            ({profile.entity.members}
            {profile.entity.members === 1 ? 'address' : 'addresses'})
          </span>
        </p>
      {/if}
      <div class="actions">
        <button type="button" class="button" onclick={copy}>
          {copied ? 'Copied' : 'Copy address'}
        </button>
        <button
          type="button"
          class="button"
          aria-pressed={watched}
          onclick={() => (watched = toggleWatch(address))}
        >
          {watched ? 'Watching' : 'Watch this wallet'}
        </button>
        <a class="button" href="/graph?root={address}">Follow the money</a>
        <a class="button" href="/path?src={address}">Find a path from here</a>
        <a
          class="button"
          href="https://explorer.runonflux.io/address/{address}"
          rel="noopener noreferrer"
          target="_blank">Open in block explorer</a
        >
      </div>
    </header>

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    {#if missing}
      <p class="muted note">
        FluxFlow hasn't stored any transfers for this wallet, so it hasn't moved FLUX to or from a
        tracked exchange within the stored history. The block explorer shows everything it has done.
      </p>
    {:else if !profile}
      <dl class="facts" aria-busy="true">
        {#each Array.from({ length: 4 }, (_, i) => i) as i (i)}
          <div>
            <dt class="skeleton">label</dt>
            <dd class="skeleton">000.0K FLUX</dd>
          </div>
        {/each}
      </dl>
    {:else}
      <dl class="facts">
        <div>
          <dt>Kind</dt>
          <dd class="small-dd">
            {kindLabel(profile.kind)}<ConfidenceBadge
              level={profile.label?.level ?? null}
              source={profile.label?.source ?? null}
              confidence={profile.label?.confidence ?? null}
              evidence={profile.labels.find((l) => l.applied)?.evidence ?? null}
            />
          </dd>
        </div>
        <div>
          <dt>Deposited to exchanges</dt>
          <dd class="sell" title="{formatFluxFull(profile.totals.sold)} FLUX">
            {formatFlux(profile.totals.sold)}
            <span class="muted count">in {formatCount(profile.totals.soldCount)}</span>
          </dd>
        </div>
        <div>
          <dt>Withdrawn from exchanges</dt>
          <dd class="buy" title="{formatFluxFull(profile.totals.bought)} FLUX">
            {formatFlux(profile.totals.bought)}
            <span class="muted count">in {formatCount(profile.totals.boughtCount)}</span>
          </dd>
        </div>
        <div>
          <dt>Net</dt>
          <dd class={profile.totals.net < 0 ? 'sell' : 'buy'}>
            {formatSigned(profile.totals.net)}
          </dd>
        </div>
        {#if profile.firstSeen}
          <div>
            <dt>First seen</dt>
            <dd class="small-dd">{formatTime(profile.firstSeen)}</dd>
          </div>
        {/if}
        {#if profile.lastSeen}
          <div>
            <dt>Last seen</dt>
            <dd class="small-dd">{formatTime(profile.lastSeen)}</dd>
          </div>
        {/if}
      </dl>

      {#if profile.tags && profile.tags.length > 0}
        <section aria-labelledby="behaviour-heading" class="behaviour">
          <h2 id="behaviour-heading" class="visually-hidden">How it behaves</h2>
          <ul>
            {#each profile.tags as tag (tag.tag)}
              <li>
                <span class="tag">{tagLabel(tag.tag)}</span>
                <span class="muted small">{tagEvidenceText(tag.tag, tag.evidence)}</span>
              </li>
            {/each}
          </ul>
          <p class="muted small">
            How this wallet behaves in the stored window. Informational: it never changes how its
            transfers are counted.
          </p>
        </section>
      {/if}

      <NotePanel {address} note={profile.note ?? null} cases={profile.cases ?? []} />

      {#if profile.totals.p2pIn > 0 || profile.totals.p2pOut > 0}
        <p class="muted small">
          Wallet to wallet in the stored window: {formatFlux(profile.totals.p2pIn)} received,
          {formatFlux(profile.totals.p2pOut)} sent.
        </p>
      {/if}

      {#if profile.kind === 'app_hosting'}
        <p class="note">
          This is where Flux app hosting fees are paid. <a href="/apps">See who pays for apps</a>
          and how those wallets were funded.
        </p>
      {/if}

      <BalancePanel key={address} load={(signal) => fetchBalance(address, signal)} />

      {#if parties && (parties.incoming.count > 0 || parties.outgoing.count > 0 || internalMoves)}
        <section aria-labelledby="parties-heading" class="block">
          <h2 id="parties-heading">Who it deals with</h2>
          <ul class="headline">
            {#if parties.firstFunder}
              <li>
                <span class="muted">First funded by</span>
                <a
                  href="/wallet/{parties.firstFunder.address}"
                  class:mono={!parties.firstFunder.name}
                >
                  {parties.firstFunder.name ?? shortAddress(parties.firstFunder.address)}
                </a>
                <span class="muted">
                  ({kindLabel(parties.firstFunder.kind).toLowerCase()}), {formatFlux(
                    parties.firstFunder.amount
                  )} FLUX on {formatTime(parties.firstFunder.time)}
                </span>
              </li>
            {/if}
            {#if parties.appPayments.count > 0}
              <li>
                <span class="muted">Paid for Flux apps</span>
                <strong>{formatFlux(parties.appPayments.total)} FLUX</strong>
                <span class="muted">in {formatCount(parties.appPayments.count)} payments</span>
              </li>
            {/if}
          </ul>
          <div class="sides">
            <div>
              <h3>
                Received from
                <span class="muted small">
                  {formatCount(parties.incoming.distinct)}
                  {parties.incoming.distinct === 1 ? 'wallet' : 'wallets'},
                  {formatFlux(parties.incoming.total)} FLUX
                </span>
              </h3>
              {#if parties.incoming.parties.length > 0}
                <PartyTable
                  parties={parties.incoming.parties}
                  column="From"
                  caption="Wallets that sent FLUX to this one, largest first"
                />
              {:else}
                <p class="muted small">Nothing received in the stored window.</p>
              {/if}
            </div>
            <div>
              <h3>
                Sent to
                <span class="muted small">
                  {formatCount(parties.outgoing.distinct)}
                  {parties.outgoing.distinct === 1 ? 'wallet' : 'wallets'},
                  {formatFlux(parties.outgoing.total)} FLUX
                </span>
              </h3>
              {#if parties.outgoing.parties.length > 0}
                <PartyTable
                  parties={parties.outgoing.parties}
                  column="To"
                  caption="Wallets this one sent FLUX to, largest first"
                />
              {:else}
                <p class="muted small">Nothing sent in the stored window.</p>
              {/if}
            </div>
          </div>
          {#if internalMoves && parties.foundationMoves}
            {@const moves = parties.foundationMoves}
            <h3 class="internal-heading">Between Foundation wallets</h3>
            <p class="muted small">
              Moves between the Foundation's own wallets are not counted as transfers anywhere else
              on FluxFlow, so they are listed here on their own.
            </p>
            <div class="sides">
              <div>
                <h4>
                  Received from
                  <span class="muted small">
                    {formatCount(moves.incoming.distinct)}
                    {moves.incoming.distinct === 1 ? 'wallet' : 'wallets'},
                    {formatFlux(moves.incoming.total)} FLUX
                  </span>
                </h4>
                {#if moves.incoming.parties.length > 0}
                  <PartyTable
                    parties={moves.incoming.parties}
                    column="From"
                    caption="Foundation wallets that sent FLUX to this one, largest first"
                  />
                {:else}
                  <p class="muted small">Nothing received from other Foundation wallets.</p>
                {/if}
              </div>
              <div>
                <h4>
                  Sent to
                  <span class="muted small">
                    {formatCount(moves.outgoing.distinct)}
                    {moves.outgoing.distinct === 1 ? 'wallet' : 'wallets'},
                    {formatFlux(moves.outgoing.total)} FLUX
                  </span>
                </h4>
                {#if moves.outgoing.parties.length > 0}
                  <PartyTable
                    parties={moves.outgoing.parties}
                    column="To"
                    caption="Foundation wallets this one sent FLUX to, largest first"
                  />
                {:else}
                  <p class="muted small">Nothing sent to other Foundation wallets.</p>
                {/if}
              </div>
            </div>
          {/if}
          <p class="muted small">
            Within the stored window. Click a wallet to follow the money a step further.
          </p>
        </section>

        <FundsPanel {address} />
      {/if}

      {#if profile.labels.length > 0 || (profile.candidates?.length ?? 0) > 0 || profile.cluster}
        <section aria-labelledby="labels-heading" class="block">
          <h2 id="labels-heading">Why it's labelled this way</h2>
          <ul class="labels">
            {#each profile.labels as label (`${label.kind}:${label.source}`)}
              <li class:applied={label.applied}>
                <span class="label-head">
                  {kindLabel(label.kind)}{label.name ? `: ${label.name}` : ''}{label.subLabel
                    ? ` (${label.subLabel})`
                    : ''}
                  {#if label.level}<span class="level {label.level}">{label.level}</span>{/if}
                  {#if label.applied}<span class="muted">used for this wallet's flows</span>{/if}
                </span>
                <span class="muted">{sourceText(label.source)}.</span>
                {#if evidenceText(label.evidence).length > 0}
                  <span class="muted small">{evidenceText(label.evidence).join(', ')}.</span>
                {/if}
                {#if label.validFrom || label.validTo}
                  <span class="muted small">
                    {label.validFrom ? `From ${formatTime(label.validFrom)}` : 'Until'}
                    {label.validTo
                      ? `${label.validFrom ? ' to' : ''} ${formatTime(label.validTo)}`
                      : ''}
                  </span>
                {/if}
              </li>
            {/each}
            {#each profile.candidates ?? [] as label (`candidate:${label.kind}:${label.source}`)}
              <li class="candidate">
                <span class="label-head">
                  Possibly {kindLabel(label.kind).toLowerCase()}{label.name
                    ? `: ${label.name}`
                    : ''}
                  <span class="level candidate">not applied</span>
                </span>
                <span class="muted">
                  {sourceText(label.source)}; {Math.round(label.confidence * 100)}% confidence is
                  below the bar for counting it.
                </span>
              </li>
            {/each}
          </ul>
          {#if profile.cluster}
            <p class="muted small">
              Spends together with {formatCount(profile.cluster.size - 1)} other
              {profile.cluster.size - 1 === 1 ? 'wallet' : 'wallets'}, which usually means one
              owner:
              {#each profile.cluster.sample
                .filter((a) => a !== address)
                .slice(0, 5) as other, i (other)}{i > 0 ? ', ' : ' '}<a
                  class="mono"
                  href="/wallet/{other}">{other.slice(0, 8)}…</a
                >{/each}.
            </p>
          {/if}
        </section>
      {/if}

      {#if exchangeRows.length > 0}
        <section aria-labelledby="where-heading" class="block">
          <h2 id="where-heading">Which exchanges</h2>
          <Diverging
            rows={exchangeRows}
            caption="This wallet's deposits and withdrawals by exchange"
          />
        </section>
      {/if}

      {#if points.length > 1}
        <section aria-labelledby="when-heading" class="block">
          <h2 id="when-heading">When</h2>
          <SeriesChart
            {points}
            bucketSeconds={86_400}
            showNet={false}
            label="This wallet's deposits and withdrawals per day"
          />
        </section>
      {/if}
    {/if}

    {#if !missing}
      <section aria-labelledby="history-heading" class="block">
        <div class="history-head">
          <h2 id="history-heading">Transfers</h2>
          <label>
            <span>Show</span>
            <select bind:value={type}>
              <option value="">All</option>
              <option value="selling">Deposits to exchanges</option>
              <option value="buying">Withdrawals from exchanges</option>
              <option value="p2p">Wallet to wallet</option>
            </select>
          </label>
        </div>
        <EventRows
          {events}
          loading={eventsLoading}
          self={address}
          caption="This wallet's transfers"
        >
          {#snippet empty()}
            No transfers of this kind in the stored window.
          {/snippet}
        </EventRows>
        {#if cursor && !eventsLoading}
          <button type="button" class="button more" onclick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Show older transfers'}
          </button>
        {/if}
      </section>
    {/if}
  {/if}
</article>

<style>
  .wallet {
    display: grid;
    gap: 1.75rem;
    padding-top: 1.5rem;
  }

  header {
    display: grid;
    gap: 0.75rem;
  }

  .entity-link {
    margin: 0;
  }

  h1 {
    font-size: var(--step-2);
  }

  .address {
    font-size: var(--step-1);
    word-break: break-all;
    font-weight: 500;
  }

  p.address {
    font-size: var(--step--1);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .button {
    padding: 0.5rem 0.9rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    font-weight: 500;
    text-decoration: none;
    cursor: pointer;
  }

  .button[aria-pressed='true'] {
    border-color: var(--brand);
    color: var(--brand);
  }

  .more {
    justify-self: start;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
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

  .count {
    font-size: var(--step--1);
    font-weight: 400;
  }

  .block {
    display: grid;
    gap: 0.75rem;
  }

  .headline {
    display: grid;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .behaviour ul {
    display: grid;
    gap: 0.35rem;
    margin: 0 0 0.25rem;
    padding: 0;
    list-style: none;
  }

  .behaviour li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.6rem;
  }

  .tag {
    padding: 0 0.5rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: var(--step--1);
    font-weight: 500;
    white-space: nowrap;
  }

  .sides {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
    gap: 1.25rem 2rem;
  }

  h3,
  h4 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.6rem;
    margin: 0 0 0.25rem;
    font-size: var(--step-0);
  }

  .internal-heading {
    margin-top: 1.5rem;
  }

  .history-head {
    display: flex;
    justify-content: space-between;
    align-items: end;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .history-head label {
    display: grid;
    gap: 0.2rem;
    font-size: var(--step--1);
    color: var(--text-muted);
  }

  select {
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    color: var(--text);
  }

  .labels {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .labels li {
    display: grid;
    gap: 0.1rem;
    padding: 0.5rem 0 0.5rem 0.75rem;
    border-left: 3px solid var(--line);
  }

  .labels li.applied {
    border-left-color: var(--brand);
  }

  .label-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.5rem;
    font-weight: 500;
  }

  .level {
    padding: 0 0.4rem;
    border: 1px solid currentColor;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 500;
  }

  .level.confirmed {
    color: var(--good);
  }

  .level.likely {
    color: var(--brand);
  }

  .level.possible,
  .level.candidate {
    color: var(--text-muted);
    border-style: dashed;
  }

  .small {
    font-size: var(--step--1);
  }

  .note {
    max-width: 62ch;
  }

  .error {
    color: var(--bad);
  }
</style>
