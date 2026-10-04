<!--
  Server status, from the server (#25).

  Refreshed when `live.version` moves: on each committed sync while the event stream is open,
  otherwise every 30 s, and never while the tab is hidden (#32). Every figure is the
  server's own: no browser OS or CPU, and no "uptime" that was really time since a sync.
-->
<script lang="ts">
  import { apiFetch, isAbort } from '$lib/client/api';
  import { formatCount, timeAgo } from '$lib/client/format';
  import { live } from '$lib/client/live.svelte';
  import { serverStatus } from '$lib/client/status.svelte';
  import type { Status } from '$lib/client/types';

  let status = $state<Status | null>(null);
  let offline = $state(false);
  let now = $state(Date.now());

  const syncState = $derived.by(() => {
    if (offline) return { tone: 'bad', text: 'Server unreachable' };
    if (!status) return { tone: 'idle', text: 'Checking…' };
    if (!status.sync.enabled) return { tone: 'idle', text: 'Sync disabled' };
    const catchUp = status.sync.catchUp;
    if (catchUp?.catchingUp) {
      return {
        tone: 'busy',
        text: catchUp.progress === null ? 'Catching up' : `Catching up · ${catchUp.progress}%`
      };
    }
    if (status.sync.degraded) return { tone: 'warn', text: status.sync.reason ?? 'Sync delayed' };
    return { tone: 'good', text: live.connected ? 'Live' : 'In sync' };
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
      serverStatus.value = status;
      offline = false;
    } catch (error) {
      if (!isAbort(error)) offline = true;
    }
    now = Date.now();
  }

  $effect(() => live.start());

  $effect(() => {
    void live.version;
    void refresh();
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
  .busy .dot {
    background: var(--brand);
    animation: pulse 1.4s ease-in-out infinite;
  }

  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .busy .dot {
      animation: none;
    }
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
