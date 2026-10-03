<!--
  Wallet page (#30): what this wallet moved to and from exchanges, where, when, and with whom.

  Exchange totals, the per-exchange split and the daily chart cover all stored history (they
  come from rollups); wallet-to-wallet totals and the transfer list cover the raw retention
  window. The watchlist is kept in this browser.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { ApiError, isAbort } from '$lib/client/api';
  import { fetchWallet, fetchWalletEvents, isAddress } from '$lib/client/endpoints';
  import {
    evidenceText,
    sourceText,
    formatCount,
    formatFlux,
    formatFluxFull,
    formatSigned,
    formatTime,
    kindLabel
  } from '$lib/client/format';
  import { live } from '$lib/client/live.svelte';
  import type { FlowEvent, FlowType, WalletProfile } from '$lib/client/types';
  import { fillDays } from '$lib/client/series';
  import { isWatched, toggleWatch } from '$lib/client/watchlist';
  import Diverging from '$lib/ui/Diverging.svelte';
  import EventRows from '$lib/ui/EventRows.svelte';
  import SeriesChart from '$lib/ui/SeriesChart.svelte';
  import ConfidenceBadge from '$lib/ui/ConfidenceBadge.svelte';

  const address = $derived(page.params.address ?? '');
  const valid = $derived(isAddress(address));

  let profile = $state<WalletProfile | null>(null);
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

      {#if profile.totals.p2pIn > 0 || profile.totals.p2pOut > 0}
        <p class="muted small">
          Wallet to wallet in the stored window: {formatFlux(profile.totals.p2pIn)} received,
          {formatFlux(profile.totals.p2pOut)} sent.
        </p>
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
