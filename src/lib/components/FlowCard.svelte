<script>
  import { createEventDispatcher } from 'svelte';
  import { TrendingUp, TrendingDown } from 'lucide-svelte';
  
  
  export let type = 'buying'; // 'buying' or 'selling'
  export let data = {
    total: 0,
    breakdown: {},
    events: []
  };
  export let maxTotal = 0; // The maximum between buying and selling for relative sizing
  
  const dispatch = createEventDispatcher();
  
  const config = {
    buying: {
      title: 'Buying Pressure',
      color: '#10b981',
      categories: [
        { 
          key: 'toNodeOperators', 
          label: 'To Node Operators',
          color: '#10b981'
        },
        { 
          key: 'toUnknown', 
          label: 'To Unknown Wallets',
          color: '#06b6d4'
        },
        { 
          key: 'toFoundation', 
          label: 'To Foundation',
          color: '#f59e0b'
        }
      ]
    },
    selling: {
      title: 'Selling Pressure',
      color: '#ef4444',
      categories: [
        { 
          key: 'fromNodeOperators', 
          label: 'From Node Operators',
          color: '#ef4444'
        },
        { 
          key: 'fromUnknown', 
          label: 'From Unknown Wallets',
          color: '#f59e0b'
        },
        { 
          key: 'fromFoundation', 
          label: 'From Foundation',
          color: '#8b5cf6'
        }
      ]
    }
  };
  
  $: currentConfig = config[type];
  $: barHeight = maxTotal > 0 ? (data.total / maxTotal * 100) : 0;
  
  // Calculate segment heights within the bar (as percentage of total)
  $: segments = currentConfig.categories.map(cat => {
    const value = data.breakdown?.[cat.key] || 0;
    const percentage = data.total > 0 ? (value / data.total * 100) : 0;
    const count = getEventCount(cat.key);
    return {
      ...cat,
      value,
      percentage,
      count,
      heightInBar: percentage
    };
  }).reverse(); // Reverse so they stack bottom to top correctly
  
  let hoveredSegment = null;
  
  function handleSegmentClick(segment) {
    if (segment.count === 0) return;
    
    const filtered = filterEventsByCategory(segment.key);
    
    dispatch('showDetails', {
      transactions: filtered,
      title: `${currentConfig.title}: ${segment.label}`,
      type: type
    });
  }
  
  function filterEventsByCategory(categoryKey) {
    if (!data.events) return [];
    
    return data.events.filter(event => {
      if (type === 'buying') {
        if (categoryKey === 'toNodeOperators') {
          return event.toType === 'node_operator';
        } else if (categoryKey === 'toUnknown') {
          return event.toType === 'unknown';
        } else if (categoryKey === 'toFoundation') {
          return event.toType === 'foundation';
        }
      } else if (type === 'selling') {
        if (categoryKey === 'fromNodeOperators') {
          return event.fromType === 'node_operator';
        } else if (categoryKey === 'fromUnknown') {
          return event.fromType === 'unknown';
        } else if (categoryKey === 'fromFoundation') {
          return event.fromType === 'foundation';
        }
      }
      
      return false;
    });
  }
  
  function getEventCount(categoryKey) {
    return filterEventsByCategory(categoryKey).length;
  }
  
  function formatNumber(num) {
    return num.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }
</script>

<div class="flow-card">
  <!-- Title -->
  <h3 class="card-title" style="color: {currentConfig.color};">
    {currentConfig.title}
  </h3>
  
  <!-- Total Amount -->
  <div class="total-amount" style="color: {currentConfig.color};">
    {formatNumber(data.total)}
    <span class="currency">FLUX</span>
  </div>
  
  <!-- Bar Chart Container -->
  <div class="bar-container">
    <div class="bar-wrapper" style="height: {barHeight}%;">
      {#each segments as segment}
        {#if segment.percentage > 0}
          <button
            class="bar-segment"
            class:clickable={segment.count > 0}
            style="height: {segment.heightInBar}%; background: {segment.color};"
            on:click={() => handleSegmentClick(segment)}
            on:mouseenter={() => hoveredSegment = segment.key}
            on:mouseleave={() => hoveredSegment = null}
            title={`${segment.label}: ${formatNumber(segment.value)} FLUX (${segment.count} events)`}
          >
            {#if hoveredSegment === segment.key}
              <div class="segment-tooltip">
                <div class="tooltip-label">{segment.label}</div>
                <div class="tooltip-amount">{formatNumber(segment.value)} FLUX</div>
                <div class="tooltip-count">{segment.count} transaction{segment.count !== 1 ? 's' : ''}</div>
              </div>
            {/if}
          </button>
        {/if}
      {/each}
    </div>
  </div>
  
  <!-- Event Count -->
  <div class="event-count">
    {data.events?.length || 0} flow events
  </div>
</div>

<style>
  .flow-card {
    background: var(--bg-secondary);
    border-radius: 12px;
    padding: var(--spacing-xl);
    border: 1px solid var(--border-color);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--spacing-lg);
    transition: all 0.3s ease;
    position: relative;
  }
  
  .flow-card:hover {
    border-color: rgba(6, 182, 212, 0.4);
    box-shadow: 0 4px 20px rgba(6, 182, 212, 0.1);
  }
  
  .card-title {
    font-size: 1.25rem;
    font-weight: 700;
    margin: 0;
    text-align: center;
  }
  
  .total-amount {
    font-size: 2rem;
    font-weight: 800;
    font-family: 'Courier New', monospace;
    text-align: center;
    line-height: 1;
  }
  
  .currency {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-secondary);
    margin-left: 8px;
  }
  
  .bar-container {
    width: 120px;
    height: 400px;
    position: relative;
    display: flex;
    align-items: flex-end;
    background: rgba(255, 255, 255, 0.03);
    border: 2px solid var(--border-color);
    border-radius: 8px;
    padding: 4px;
  }
  
  .bar-wrapper {
    width: 100%;
    display: flex;
    flex-direction: column-reverse;
    border-radius: 6px;
    overflow: hidden;
    transition: height 0.5s ease;
  }
  
  .bar-segment {
    width: 100%;
    border: none;
    padding: 0;
    transition: all 0.2s ease;
    cursor: default;
    position: relative;
    border-top: 1px solid rgba(0, 0, 0, 0.2);
  }
  
  .bar-segment:last-child {
    border-top: none;
  }
  
  .bar-segment.clickable {
    cursor: pointer;
  }
  
  .bar-segment.clickable:hover {
    filter: brightness(1.3);
    transform: scaleX(1.05);
    z-index: 10;
  }
  
  .segment-tooltip {
    position: absolute;
    left: calc(100% + 16px);
    top: 50%;
    transform: translateY(-50%);
    background: rgba(10, 10, 15, 0.98);
    border: 1px solid var(--flux-cyan);
    border-radius: 8px;
    padding: 12px;
    min-width: 180px;
    z-index: 100;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    pointer-events: none;
    animation: tooltipFadeIn 0.2s ease;
  }
  
  .segment-tooltip::before {
    content: '';
    position: absolute;
    right: 100%;
    top: 50%;
    transform: translateY(-50%);
    border: 6px solid transparent;
    border-right-color: var(--flux-cyan);
  }
  
  @keyframes tooltipFadeIn {
    from {
      opacity: 0;
      transform: translateY(-50%) translateX(-5px);
    }
    to {
      opacity: 1;
      transform: translateY(-50%) translateX(0);
    }
  }
  
  .tooltip-label {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    margin-bottom: 6px;
    font-weight: 500;
  }
  
  .tooltip-amount {
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--flux-cyan);
    font-family: 'Courier New', monospace;
    margin-bottom: 4px;
  }
  
  .tooltip-count {
    font-size: 0.75rem;
    color: var(--text-dim);
  }
  
  .event-count {
    font-size: 0.875rem;
    color: var(--text-secondary);
    text-align: center;
  }
  
  /* Responsive */
  @media (max-width: 768px) {
    .bar-container {
      height: 300px;
      width: 100px;
    }
    
    .total-amount {
      font-size: 1.5rem;
    }
    
    .segment-tooltip {
      left: auto;
      right: auto;
      top: auto;
      bottom: calc(100% + 12px);
      transform: translateX(-50%);
    }
    
    .segment-tooltip::before {
      right: auto;
      top: 100%;
      left: 50%;
      transform: translateX(-50%);
      border-right-color: transparent;
      border-top-color: var(--flux-cyan);
    }
  }
</style>