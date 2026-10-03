<!--
  Wallet page (#30).

  The profile (totals, first and last seen, history) comes from GET /api/wallets/:address,
  which is being built; see `$lib/client/pending`. Until then the page shows what is known
  for certain and links to the block explorer, and the watchlist works locally.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { formatFlux, formatTime, kindLabel } from '$lib/client/format';
  import { fetchWallet, type WalletProfile } from '$lib/client/pending';
  import { isWatched, toggleWatch } from '$lib/client/watchlist';

  const address = $derived(page.params.address ?? '');
  const valid = $derived(/^t[13][1-9A-HJ-NP-Za-km-z]{33}$/.test(address));

  let profile = $state<WalletProfile | null>(null);
  let watched = $state(false);
  let copied = $state(false);

  $effect(() => {
    const current = address;
    const controller = new AbortController();
    profile = null;
    if (valid) {
      fetchWallet(current, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) profile = result;
        })
        .catch(() => {});
    }
    return () => controller.abort();
  });

  // Effects run in the browser only, which is where the watchlist lives.
  $effect(() => {
    watched = isWatched(address);
  });

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(address);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      /* clipboard blocked: the address is selectable text */
    }
  }
</script>

<svelte:head>
  <title>Wallet {address.slice(0, 8)}… | FluxFlow</title>
</svelte:head>

<article class="wallet">
  <p><a href="/">Back to the dashboard</a></p>

  {#if !valid}
    <h1>That isn't a FLUX address</h1>
    <p class="muted">FLUX addresses start with t1 or t3 and are 35 characters long.</p>
  {:else}
    <header>
      <h1 class="mono address">{address}</h1>
      <div class="actions">
        <button type="button" class="button" onclick={copy}
          >{copied ? 'Copied' : 'Copy address'}</button
        >
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

    {#if profile}
      <dl class="facts">
        <div>
          <dt>Kind</dt>
          <dd>{profile.label ?? kindLabel(profile.kind)}</dd>
        </div>
        <div>
          <dt>Withdrawn from exchanges</dt>
          <dd class="buy">{formatFlux(profile.bought)} FLUX</dd>
        </div>
        <div>
          <dt>Deposited to exchanges</dt>
          <dd class="sell">{formatFlux(profile.sold)} FLUX</dd>
        </div>
        {#if profile.firstSeen}<div>
            <dt>First seen</dt>
            <dd>{formatTime(profile.firstSeen)}</dd>
          </div>{/if}
        {#if profile.lastSeen}<div>
            <dt>Last seen</dt>
            <dd>{formatTime(profile.lastSeen)}</dd>
          </div>{/if}
      </dl>
    {:else}
      <p class="muted note">
        A full history for this wallet isn't available here yet. The block explorer link above shows
        every transaction it has made.
      </p>
    {/if}
  {/if}
</article>

<style>
  .wallet {
    display: grid;
    gap: 1.5rem;
    padding-top: 1.5rem;
  }

  header {
    display: grid;
    gap: 1rem;
  }

  .address {
    font-size: var(--step-1);
    word-break: break-all;
    font-weight: 500;
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

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: 1rem;
    margin: 0;
  }

  dt {
    font-size: var(--step--1);
    color: var(--text-muted);
  }

  dd {
    margin: 0;
    font-size: var(--step-1);
    font-weight: 600;
  }

  .note {
    max-width: 60ch;
  }
</style>
