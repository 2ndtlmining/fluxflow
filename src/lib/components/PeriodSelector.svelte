<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { PERIOD_IDS, PERIOD_LABELS, type PeriodId } from '$lib/shared/constants';

  export let selected: PeriodId = '24H';

  const dispatch = createEventDispatcher<{ change: { period: PeriodId } }>();
  const periods = PERIOD_IDS;

  function selectPeriod(period: PeriodId) {
    selected = period;
    dispatch('change', { period });
  }
</script>

<div class="period-selector">
  <h3>Time Period</h3>
  <div class="period-buttons">
    {#each periods as period}
      <button class="btn" class:active={selected === period} on:click={() => selectPeriod(period)}>
        {PERIOD_LABELS[period]}
      </button>
    {/each}
  </div>
</div>

<style>
  .period-selector {
    margin: var(--spacing-lg) 0;
  }

  .period-selector h3 {
    margin-bottom: var(--spacing-md);
  }

  .period-buttons {
    display: flex;
    gap: var(--spacing-sm);
    flex-wrap: wrap;
  }

  @media (max-width: 640px) {
    .period-buttons {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
