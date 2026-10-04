<!--
  The wallets this browser is watching (#30), with their exchange totals.

  The list itself lives in localStorage; the figures come from each wallet's profile. Shown
  only when something is being watched, so a first visit is not cluttered by an empty panel.
-->
<script lang="ts">
  import { ApiError, isAbort } from '$lib/client/api';
  import { fetchWallet } from '$lib/client/endpoints';
  import { formatFlux, formatSigned, kindLabel, shortAddress, timeAgo } from '$lib/client/format';
  import { live } from '$lib/client/live.svelte';
  import type { WalletProfile } from '$lib/client/types';
  import { readWatchlist, toggleWatch } from '$lib/client/watchlist';

  /** Profiles are fetched one per wallet; keep the panel to a sensible size. */
  const SHOWN = 12;

  let addresses = $state<string[]>([]);
  let profiles = $state<Record<string, WalletProfile | 'unseen' | undefined>>({});

  $effect(() => {
    addresses = readWatchlist();
  });

  $effect(() => {
    void live.version;
    const shown = addresses.slice(0, SHOWN);
    const controller = new AbortController();
    for (const address of shown) {
      fetchWallet(address, controller.signal)
        .then((profile) => (profiles = { ...profiles, [address]: profile }))
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 404) {
            profiles = { ...profiles, [address]: 'unseen' };
          } else if (!isAbort(error)) {
            profiles = { ...profiles, [address]: undefined };
          }
        });
    }
    return () => controller.abort();
  });

  function remove(address: string): void {
    toggleWatch(address);
    addresses = addresses.filter((entry) => entry !== address);
  }

  const now = Date.now();
</script>

{#if addresses.length > 0}
  <section aria-labelledby="watch-heading" class="watch">
    <header>
      <h2 id="watch-heading">Your watchlist</h2>
      <p class="muted">Kept in this browser only. Totals cover all stored history.</p>
    </header>
    <ul>
      {#each addresses.slice(0, SHOWN) as address (address)}
        {@const profile = profiles[address]}
        <li>
          <span class="who">
            <a href="/wallet/{address}" class:mono={!(typeof profile === 'object' && profile.name)}>
              {typeof profile === 'object' && profile.name ? profile.name : shortAddress(address)}
            </a>
            <span class="muted small">
              {#if profile === 'unseen'}
                No exchange transfers stored yet
              {:else if profile}
                {kindLabel(profile.kind)}{#if profile.lastSeen}, active {timeAgo(
                    profile.lastSeen,
                    now
                  )}{/if}
              {:else}
                Loading…
              {/if}
            </span>
          </span>
          {#if typeof profile === 'object'}
            <span class="figures">
              <span class="sell">{formatFlux(profile.totals.sold)} deposited</span>
              <span class="buy">{formatFlux(profile.totals.bought)} withdrawn</span>
              <span class="net {profile.totals.net < 0 ? 'sell' : 'buy'}"
                >net {formatSigned(profile.totals.net)}</span
              >
            </span>
          {/if}
          <button
            type="button"
            class="remove"
            onclick={() => remove(address)}
            aria-label="Stop watching {address}"
            title="Stop watching">×</button
          >
        </li>
      {/each}
    </ul>
    {#if addresses.length > SHOWN}
      <p class="muted small">
        Showing {SHOWN} of {addresses.length} watched wallets, most recently added first.
      </p>
    {/if}
  </section>
{/if}

<style>
  .watch {
    display: grid;
    gap: 0.75rem;
  }

  header {
    display: grid;
    gap: 0.15rem;
  }

  header p,
  .small {
    font-size: var(--step--1);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 0.75rem;
    align-items: center;
    padding: 0.55rem 0;
    border-top: 1px solid var(--line);
  }

  .who {
    display: grid;
    min-width: 0;
  }

  .figures {
    display: flex;
    gap: 1rem;
    font-size: var(--step--1);
    font-weight: 500;
  }

  .net {
    font-weight: 600;
  }

  .remove {
    width: 2rem;
    height: 2rem;
    border: 1px solid var(--line);
    border-radius: 50%;
    background: transparent;
    cursor: pointer;
    line-height: 1;
  }

  @media (max-width: 640px) {
    li {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .figures {
      grid-column: 1 / -1;
      grid-row: 2;
      flex-wrap: wrap;
      gap: 0.25rem 0.75rem;
    }
  }
</style>
