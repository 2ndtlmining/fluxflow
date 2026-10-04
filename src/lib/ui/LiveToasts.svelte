<!--
  Large transfers as they happen (#32), from the event stream's `flow` events.

  Announced politely to screen readers, dismissed after 10 s or by hand, and never more
  than three at once. With reduced motion they simply appear, without sliding in.
-->
<script lang="ts">
  import { flowLabel, formatFlux, formatFluxFull, shortAddress } from '$lib/client/format';
  import { live } from '$lib/client/live.svelte';
</script>

<div class="toasts" role="status" aria-live="polite" aria-label="Live transfers">
  {#each live.toasts as toast (toast.id)}
    {@const flow = toast.flow}
    {@const wallet = flow.flowType === 'buying' ? flow.toAddress : flow.fromAddress}
    <div
      class="toast {flow.flowType === 'selling'
        ? 'sell-edge'
        : flow.flowType === 'buying'
          ? 'buy-edge'
          : ''}"
    >
      <p>
        <strong
          class={flow.flowType === 'selling' ? 'sell' : flow.flowType === 'buying' ? 'buy' : ''}
          title="{formatFluxFull(flow.amount)} FLUX">{formatFlux(flow.amount)} FLUX</strong
        >
        {flowLabel(flow.flowType).toLowerCase()}{#if flow.exchange}&nbsp;({flow.exchange}){/if}
      </p>
      <p class="small">
        <a class="mono" href="/wallet/{wallet}">{shortAddress(wallet)}</a>
        <span class="muted">block {flow.height}</span>
      </p>
      <button
        type="button"
        class="close"
        onclick={() => live.dismiss(toast.id)}
        aria-label="Dismiss">×</button
      >
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: 1rem;
    bottom: 1rem;
    display: grid;
    gap: 0.5rem;
    width: min(22rem, calc(100vw - 2rem));
    z-index: 20;
  }

  .toast {
    position: relative;
    padding: 0.75rem 2.5rem 0.75rem 0.9rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-left-width: 4px;
    border-radius: var(--radius-m);
    box-shadow: 0 6px 24px color-mix(in srgb, var(--text) 18%, transparent);
    animation: enter 220ms ease-out;
  }

  .sell-edge {
    border-left-color: var(--sell);
  }

  .buy-edge {
    border-left-color: var(--buy);
  }

  .small {
    font-size: var(--step--1);
    display: flex;
    gap: 0.75rem;
  }

  .close {
    position: absolute;
    top: 0.4rem;
    right: 0.4rem;
    width: 1.75rem;
    height: 1.75rem;
    border: 0;
    border-radius: 50%;
    background: transparent;
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
  }

  @keyframes enter {
    from {
      transform: translateY(0.5rem);
      opacity: 0;
    }
  }
</style>
