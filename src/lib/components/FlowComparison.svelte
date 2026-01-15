<script>
  import { onMount, createEventDispatcher } from 'svelte';
  import { ArrowUpRight, ArrowDownLeft } from 'lucide-svelte';
  import Chart from 'chart.js/auto';
  
  
  export let buyingData = { total: 0, breakdown: {}, events: [] };
  export let sellingData = { total: 0, breakdown: {}, events: [] };
  
  const dispatch = createEventDispatcher();
  
  let chartCanvas;
  let chartInstance = null;
  
  $: isBullish = buyingData.total > sellingData.total;
  $: difference = Math.abs(buyingData.total - sellingData.total);
  $: sentimentLabel = isBullish ? 'Bullish' : 'Bearish';
  $: sentimentDescription = isBullish 
    ? `${formatNumber(difference)} FLUX more buying than selling`
    : `${formatNumber(difference)} FLUX more selling than buying`;
  
  let showSentimentTooltip = false;
  
  // Category configurations
  const categories = {
    buying: [
      { key: 'toNodeOperators', label: 'To Node Operators', color: '#10b981', filterType: 'node_operator' },
      { key: 'toUnknown', label: 'To Unknown Wallets', color: '#06b6d4', filterType: 'unknown' },
      { key: 'toFoundation', label: 'To Foundation', color: '#f59e0b', filterType: 'foundation' }
    ],
    selling: [
      { key: 'fromNodeOperators', label: 'From Node Operators', color: '#ef4444', filterType: 'node_operator' },
      { key: 'fromUnknown', label: 'From Unknown Wallets', color: '#f59e0b', filterType: 'unknown' },
      { key: 'fromFoundation', label: 'From Foundation', color: '#8b5cf6', filterType: 'foundation' }
    ]
  };
  
  function formatNumber(num) {
    return num.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }
  
  function getEventCount(type, categoryKey, filterType) {
    const data = type === 'buying' ? buyingData : sellingData;
    if (!data.events) return 0;
    
    return data.events.filter(event => {
      if (type === 'buying') {
        return event.toType === filterType;
      } else {
        return event.fromType === filterType;
      }
    }).length;
  }
  
  function filterEventsByCategory(type, filterType) {
    const data = type === 'buying' ? buyingData : sellingData;
    if (!data.events) return [];
    
    return data.events.filter(event => {
      if (type === 'buying') {
        return event.toType === filterType;
      } else {
        return event.fromType === filterType;
      }
    });
  }
  
  function handleChartClick(event, chartType) {
    if (!chartInstance) return;
    
    const elements = chartInstance.getElementsAtEventForMode(
      event,
      'nearest',
      { intersect: true },
      true
    );
    
    if (elements.length > 0) {
      const element = elements[0];
      const datasetIndex = element.datasetIndex;
      const category = categories[chartType][datasetIndex];
      
      const filtered = filterEventsByCategory(chartType, category.filterType);
      
      if (filtered.length > 0) {
        dispatch('showDetails', {
          transactions: filtered,
          title: `${chartType === 'buying' ? 'Buying' : 'Selling'} Pressure: ${category.label}`,
          type: chartType
        });
      }
    }
  }
  
  function createChart() {
    if (!chartCanvas) return;
    
    if (chartInstance) {
      chartInstance.destroy();
    }
    
    const buyingCategories = categories.buying.map(cat => ({
      ...cat,
      value: buyingData.breakdown?.[cat.key] || 0,
      count: getEventCount('buying', cat.key, cat.filterType)
    }));
    
    const sellingCategories = categories.selling.map(cat => ({
      ...cat,
      value: sellingData.breakdown?.[cat.key] || 0,
      count: getEventCount('selling', cat.key, cat.filterType)
    }));
    
    const datasets = [
      ...buyingCategories.map(cat => ({
        label: cat.label,
        data: [cat.value, 0],
        backgroundColor: cat.color,
        borderColor: cat.color,
        borderWidth: 2,
        categoryType: 'buying',
        filterType: cat.filterType,
        eventCount: cat.count
      })),
      ...sellingCategories.map(cat => ({
        label: cat.label,
        data: [0, cat.value],
        backgroundColor: cat.color,
        borderColor: cat.color,
        borderWidth: 2,
        categoryType: 'selling',
        filterType: cat.filterType,
        eventCount: cat.count
      }))
    ];
    
    chartInstance = new Chart(chartCanvas, {
      type: 'bar',
      data: {
        labels: ['Buying', 'Selling'],
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick: (event, elements, chart) => {
          if (elements.length > 0) {
            const element = elements[0];
            const dataset = chart.data.datasets[element.datasetIndex];
            
            const filtered = filterEventsByCategory(dataset.categoryType, dataset.filterType);
            
            if (filtered.length > 0) {
              dispatch('showDetails', {
                transactions: filtered,
                title: `${dataset.categoryType === 'buying' ? 'Buying' : 'Selling'} Pressure: ${dataset.label}`,
                type: dataset.categoryType
              });
            }
          }
        },
        scales: {
          x: {
            stacked: true,
            grid: {
              color: 'rgba(255, 255, 255, 0.1)'
            },
            ticks: {
              color: '#a0aec0',
              font: {
                size: 14,
                weight: 'bold'
              }
            }
          },
          y: {
            stacked: true,
            beginAtZero: true,
            grid: {
              color: 'rgba(255, 255, 255, 0.05)'
            },
            ticks: {
              color: '#a0aec0',
              callback: function(value) {
                return formatNumber(value) + ' FLUX';
              }
            }
          }
        },
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: {
              color: '#a0aec0',
              padding: 15,
              font: {
                size: 12
              },
              usePointStyle: true,
              pointStyle: 'rectRounded'
            }
          },
          tooltip: {
            backgroundColor: 'rgba(10, 10, 15, 0.95)',
            titleColor: '#06b6d4',
            bodyColor: '#ffffff',
            borderColor: '#06b6d4',
            borderWidth: 1,
            padding: 12,
            displayColors: true,
            callbacks: {
              title: function(context) {
                return context[0].dataset.label;
              },
              label: function(context) {
                const dataset = context.dataset;
                return [
                  `Amount: ${formatNumber(context.parsed.y)} FLUX`,
                  `Transactions: ${dataset.eventCount}`
                ];
              },
              footer: function(context) {
                return 'Click to view details';
              }
            }
          }
        },
        interaction: {
          mode: 'nearest',
          intersect: true
        }
      }
    });
  }
  
  onMount(() => {
    createChart();
  });
  
  $: if (chartCanvas && (buyingData || sellingData)) {
    createChart();
  }
</script>

<div class="flow-comparison">
  <!-- Sentiment Indicator -->
  <div 
    class="sentiment-indicator {isBullish ? 'bullish' : 'bearish'}"
    on:mouseenter={() => showSentimentTooltip = true}
    on:mouseleave={() => showSentimentTooltip = false}
    role="button"
    tabindex="0"
  >
    <div class="sentiment-icon">
      {#if isBullish}
        <ArrowUpRight size={32} strokeWidth={3} />
      {:else}
        <ArrowDownLeft size={32} strokeWidth={3} />
      {/if}
    </div>
    
    {#if showSentimentTooltip}
      <div class="sentiment-tooltip">
        <div class="sentiment-label {isBullish ? 'bullish' : 'bearish'}">
          {sentimentLabel}
        </div>
        <div class="sentiment-description">
          {sentimentDescription}
        </div>
      </div>
    {/if}
  </div>
  
  <!-- Chart Container -->
  <div class="chart-container">
    <canvas bind:this={chartCanvas}></canvas>
  </div>
</div>

<style>
  .flow-comparison {
    position: relative;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: var(--spacing-xl);
    margin-bottom: var(--spacing-xl);
  }
  
  .sentiment-indicator {
    position: absolute;
    top: 20px;
    right: 20px;
    z-index: 10;
    cursor: help;
  }
  
  .sentiment-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: rgba(10, 10, 15, 0.8);
    border: 2px solid currentColor;
    filter: drop-shadow(0 0 20px currentColor);
    animation: glow 2s ease-in-out infinite;
    transition: transform 0.3s ease;
  }
  
  .sentiment-indicator.bullish .sentiment-icon {
    color: #10b981;
    border-color: #10b981;
  }
  
  .sentiment-indicator.bearish .sentiment-icon {
    color: #ef4444;
    border-color: #ef4444;
  }
  
  .sentiment-indicator:hover .sentiment-icon {
    transform: scale(1.1);
  }
  
  @keyframes glow {
    0%, 100% {
      filter: drop-shadow(0 0 20px currentColor);
    }
    50% {
      filter: drop-shadow(0 0 35px currentColor);
    }
  }
  
  .sentiment-tooltip {
    position: absolute;
    top: calc(100% + 12px);
    right: 0;
    background: rgba(10, 10, 15, 0.98);
    border: 2px solid currentColor;
    border-radius: 12px;
    padding: 16px;
    min-width: 250px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    animation: tooltipFadeIn 0.2s ease;
    pointer-events: none;
    white-space: nowrap;
  }
  
  .sentiment-indicator.bullish .sentiment-tooltip {
    border-color: #10b981;
  }
  
  .sentiment-indicator.bearish .sentiment-tooltip {
    border-color: #ef4444;
  }
  
  .sentiment-tooltip::before {
    content: '';
    position: absolute;
    bottom: 100%;
    right: 20px;
    border: 8px solid transparent;
    border-bottom-color: currentColor;
  }
  
  .sentiment-indicator.bullish .sentiment-tooltip::before {
    border-bottom-color: #10b981;
  }
  
  .sentiment-indicator.bearish .sentiment-tooltip::before {
    border-bottom-color: #ef4444;
  }
  
  @keyframes tooltipFadeIn {
    from {
      opacity: 0;
      transform: translateY(-5px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  
  .sentiment-label {
    font-size: 1.125rem;
    font-weight: 700;
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  
  .sentiment-label.bullish {
    color: #10b981;
  }
  
  .sentiment-label.bearish {
    color: #ef4444;
  }
  
  .sentiment-description {
    font-size: 0.875rem;
    color: var(--text-secondary);
    line-height: 1.4;
  }
  
  .chart-container {
    width: 100%;
    height: 500px;
    margin-top: var(--spacing-lg);
  }
  
  /* Responsive */
  @media (max-width: 768px) {
    .sentiment-indicator {
      top: 10px;
      right: 10px;
    }
    
    .sentiment-icon {
      width: 48px;
      height: 48px;
    }
    
    .chart-container {
      height: 400px;
    }
  }
</style>