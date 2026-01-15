<script>
  import { createEventDispatcher } from 'svelte';
  import { FLUX_CONFIG } from '$lib/config.js';
  
  
  export let selected = '24H';
  
  const dispatch = createEventDispatcher();
  const periods = Object.keys(FLUX_CONFIG.PERIODS);
  
  function selectPeriod(period) {
    selected = period;
    dispatch('change', { period });
  }
</script>

<div class="period-selector">
  <h3>Time Period</h3>
  <div class="period-buttons">
    {#each periods as period}
      <button 
        class="btn"
        class:active={selected === period}
        on:click={() => selectPeriod(period)}
      >
        {FLUX_CONFIG.PERIOD_LABELS[period]}
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
