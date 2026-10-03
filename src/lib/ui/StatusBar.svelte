<!--
  Server status, from the server (#25).

  One /api/status request every 30 s, none while the tab is hidden, and a fresh one when it
  becomes visible again. Every figure is the server's own: no browser OS or CPU, and no
  "uptime" that was really the time since the last sync.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch, isAbort } from '$lib/client/api';
  import { formatCount, timeAgo } from '$lib/client/format';
  import type { Status } from '$lib/client/types';

  const POLL_MS = 30_000;

  let status = $state<Status | null>(null);
  let offline = $state(false);
  let now = $state(Date.now());

  const syncState = $derived.by(() => {
    if (offline) return { tone: 'bad', text: 'Server unreachable' };
    if (!status) return { tone: 'idle', text: 'Checking…' };
    if (!status.sync.enabled) return { tone: 'idle', text: 'Sync disabled' };
    if (status.sync.degraded) return { tone: 'warn', text: status.sync.reason ?? 'Sync delayed' };
    return { tone: 'good', text: 'In sync' };
  });

  const source = $derived.by(() => {
    const active = status?.dataSources.active;
    if (!active) return null;
    if (active === 'own-node') return 'your node';
    if (active === 'fluxnode-pool') return 'FluxNode pool';
    if (active === 'blockbook') return 'Blockbook';
    return active;
  });

  async function refresh(): Promise<void> {
    try {
      status = await apiFetch<Status>('/status');
      offline = false;
    } catch (error) {
      if (!isAbort(error)) offline = true;
    }
    now = Date.now();
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });
</script>

<div class="status" role="status" aria-live="polite">
  <span class="state {syncState.tone}">
    <span class="dot" aria-hidden="true"></span>{syncState.text}
  </span>
  {#if status}
    <span>Block <strong>{formatCount(status.sync.latestHeight)}</strong></span>
    {#if status.sync.lastSuccessfulSyncAt}
      <span class="muted">
        updated {timeAgo(status.sync.lastSuccessfulSyncAt / 1000, now)}
      </span>
    {/if}
    {#if source}
      <span class="muted wide">from {source}</span>
    {/if}
    {#if status.database.missingBlocks > 0}
      <span class="warn-text"
        >{formatCount(status.database.missingBlocks)} blocks pending retry</span
      >
    {/if}
  {/if}
</div>

<style>
  .status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 1rem;
    font-size: var(--step--1);
  }

  .state {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-weight: 500;
  }

  .dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--text-muted);
  }

  .good .dot {
    background: var(--good);
  }
  .warn .dot {
    background: var(--warn);
  }
  .bad .dot {
    background: var(--bad);
  }

  .warn-text {
    color: var(--warn);
  }

  @media (max-width: 480px) {
    .wide {
      display: none;
    }
  }
</style>
