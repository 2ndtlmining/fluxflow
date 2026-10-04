<!--
  Shown while the server is still syncing towards the network tip.

  A fresh deployment loads six months of history oldest-first, so for a while "24H" is a day
  months in the past and every batch moves the figures. Without saying so, that looks like
  the numbers are broken. Hidden once caught up; reads the status the status bar fetched.
-->
<script lang="ts">
  import { formatCount, formatDate, formatDuration } from '$lib/client/format';
  import { serverStatus } from '$lib/client/status.svelte';

  const catchUp = $derived(serverStatus.value?.sync.catchUp ?? null);
  const progress = $derived(catchUp?.progress ?? 0);
</script>

{#if catchUp?.catchingUp}
  <div class="banner" role="status" aria-live="polite">
    <div class="inner">
      <p>
        <strong>Loading history: {progress}% done.</strong>
        {#if catchUp.dataFrom && catchUp.dataAsOf}
          Syncing forward from {formatDate(catchUp.dataFrom)} towards today; the figures cover up to
          <strong>{formatDate(catchUp.dataAsOf)}</strong> so far and will keep changing until it catches
          up.
        {:else}
          Fetching the first blocks; figures appear shortly.
        {/if}
        {#if catchUp.behindBlocks}
          <span class="muted">
            {formatCount(catchUp.behindBlocks)} blocks to go{#if catchUp.etaSeconds !== null},
              {formatDuration(catchUp.etaSeconds)} left{/if}.
          </span>
        {/if}
      </p>
      <div
        class="bar"
        role="progressbar"
        aria-label="Sync progress"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={progress}
      >
        <span style:width="{progress}%"></span>
      </div>
    </div>
  </div>
{/if}

<style>
  .banner {
    border-bottom: 1px solid var(--line);
    background: var(--surface-2);
  }

  .inner {
    max-width: 75rem;
    margin: 0 auto;
    padding: 0.6rem 1rem;
  }

  p {
    margin: 0 0 0.45rem;
    font-size: var(--step--1);
    line-height: 1.45;
  }

  .muted {
    color: var(--text-muted);
  }

  .bar {
    height: 0.3rem;
    border-radius: 999px;
    background: var(--line);
    overflow: hidden;
  }

  .bar span {
    display: block;
    height: 100%;
    background: var(--brand);
    transition: width 0.6s ease;
  }

  @media (prefers-reduced-motion: reduce) {
    .bar span {
      transition: none;
    }
  }
</style>
