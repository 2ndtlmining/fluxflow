<script>
  import { onMount } from 'svelte';
  import { FLUX_CONFIG } from '$lib/config.js';
  import { getApiUrl } from '$lib/config.js';
  import Header from '$lib/components/Header.svelte';
  import FlowStats from '$lib/components/FlowStats.svelte';
  import PeriodSelector from '$lib/components/PeriodSelector.svelte';
  import FlowComparison from '$lib/components/FlowComparison.svelte';
  import TransactionTable from '$lib/components/TransactionTable.svelte';
  // PHASE 4: Removed WalletEnhancement component - now handled by background job
  
  let API_URL = '';
  
  let selectedPeriod = FLUX_CONFIG.DEFAULT_PERIOD;
  let flowData = null;
  let loading = true;
  let error = null;
  
  // Transaction table state (inline, not modal)
  let showTransactionTable = false;
  let transactionTableData = {
    transactions: [],
    title: '',
    type: 'selling'
  };
  
  // Fetch flow data for selected period
  async function fetchFlowData() {
    try {
      loading = true;
      error = null;
      
      const response = await fetch(`${API_URL}/api/flow/${selectedPeriod}`);
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch flow data');
      }
      
      flowData = data;
      
    } catch (err) {
      console.error('Error fetching flow data:', err);
      error = err.message;
    } finally {
      loading = false;
    }
  }
  
  // Handle period change
  function handlePeriodChange(event) {
    selectedPeriod = event.detail.period;
    showTransactionTable = false; // Hide table when period changes
    fetchFlowData();
  }
  
  // Handle show details from FlowCard (inline display)
  function handleShowDetails(event) {
    transactionTableData = event.detail;
    showTransactionTable = true;
    
    // Smooth scroll to transaction table
    setTimeout(() => {
      const tableElement = document.getElementById('transaction-table');
      if (tableElement) {
        tableElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 100);
  }
  
  // Initial load and refresh
  onMount(() => {
    API_URL = getApiUrl();
    console.log('✅ Using API URL:', API_URL);
    
    fetchFlowData();
    
    // Auto-refresh every 5 minutes
    const interval = setInterval(fetchFlowData, FLUX_CONFIG.FRONTEND_REFRESH_INTERVAL);
    
    return () => clearInterval(interval);
  });
</script>

<Header />

<div class="container">
  <FlowStats />
  
  <!-- PHASE 4: WalletEnhancement panel removed - auto-enhancement runs in background -->
  
  <PeriodSelector 
    selected={selectedPeriod} 
    on:change={handlePeriodChange}
  />
  
  {#if loading}
    <div class="loading-container">
      <div class="loading"></div>
      <p>Loading flow data...</p>
    </div>
  {:else if error}
    <div class="error-container">
      <p>Error: {error}</p>
      <button class="btn" on:click={fetchFlowData}>Retry</button>
    </div>
  {:else if flowData && flowData.partial}
    <!-- Partial data warning banner -->
    <div class="warning-banner card">
      <div class="warning-icon">⚠️</div>
      <div class="warning-content">
        <h3>Partial Data - Sync in Progress</h3>
        <p>{flowData.partialWarning}</p>
        <div class="progress-bar">
          <div class="progress-fill" style="width: {flowData.progress}%"></div>
        </div>
        <p class="progress-text">
          {flowData.blocksSynced?.toLocaleString() || 0} / {flowData.blocksNeeded?.toLocaleString() || 0} blocks 
          ({flowData.progress?.toFixed(1) || 0}% complete)
        </p>
      </div>
    </div>
    
    <!-- Show data even though partial -->
    <FlowComparison
      buyingData={flowData.buying}
      sellingData={flowData.selling}
      on:showDetails={handleShowDetails}
    />
    
    <!-- Inline Transaction Table -->
    {#if showTransactionTable}
      <div id="transaction-table">
        <TransactionTable 
          transactions={transactionTableData.transactions}
          title={transactionTableData.title}
          type={transactionTableData.type}
        />
      </div>
    {/if}
  {:else if flowData && !flowData.ready && !flowData.partial}
    <div class="info-container card">
      <h3>No Data Available</h3>
      <p>{flowData.message}</p>
      <div class="progress-bar">
        <div class="progress-fill" style="width: {flowData.progress || 0}%"></div>
      </div>
      <p class="progress-text">{flowData.progress?.toFixed(1) || 0}% complete</p>
    </div>
  {:else if flowData}
    <!-- Full data - no warning -->
    <FlowComparison
      buyingData={flowData.buying}
      sellingData={flowData.selling}
      on:showDetails={handleShowDetails}
    />
    
    <!-- Inline Transaction Table -->
    {#if showTransactionTable}
      <div id="transaction-table">
        <TransactionTable 
          transactions={transactionTableData.transactions}
          title={transactionTableData.title}
          type={transactionTableData.type}
        />
      </div>
    {/if}
  {/if}
</div>

<style>
  :global(:root) {
    --flux-cyan: #06b6d4;
    --flux-blue: #0ea5e9;
    --bg-primary: #0a0a0f;
    --bg-secondary: #1a1a2e;
    --bg-header: #0f0f1a;
    --border-color: rgba(6, 182, 212, 0.2);
    --text-primary: #ffffff;
    --text-white: #ffffff;
    --text-secondary: #a0aec0;
    --text-muted: #718096;
    --text-dim: #4a5568;
    --accent-cyan: #06b6d4;
    --accent-green: #10b981;
    --accent-red: #ef4444;
    --accent-yellow: #f59e0b;
    --glow-cyan: 0 0 20px rgba(6, 182, 212, 0.5);
    --spacing-xs: 0.25rem;
    --spacing-sm: 0.5rem;
    --spacing-md: 1rem;
    --spacing-lg: 1.5rem;
    --spacing-xl: 2rem;
  }
  
  :global(body) {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background: var(--bg-primary);
    color: var(--text-primary);
    min-height: 100vh;
  }
  
  .container {
    max-width: 1400px;
    margin: 0 auto;
    padding: var(--spacing-lg);
  }

  .card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: var(--spacing-lg);
  }

  #transaction-table {
    scroll-margin-top: var(--spacing-lg);
  }

  .warning-banner {
    display: flex;
    gap: var(--spacing-lg);
    margin-bottom: var(--spacing-xl);
    background: rgba(245, 158, 11, 0.1);
    border-color: #f59e0b;
  }
  
  .warning-icon {
    font-size: 2rem;
  }
  
  .warning-content {
    flex: 1;
  }
  
  .warning-content h3 {
    color: #f59e0b;
    margin: 0 0 var(--spacing-sm) 0;
  }
  
  .warning-content p {
    color: var(--text-secondary);
    margin: 0 0 var(--spacing-md) 0;
  }
  
  .progress-bar {
    width: 100%;
    height: 8px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: var(--spacing-sm);
  }
  
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--flux-cyan), var(--flux-blue));
    transition: width 0.3s ease;
  }
  
  .progress-text {
    color: var(--text-secondary);
    font-size: 0.875rem;
    margin: 0;
  }
  
  .loading-container,
  .error-container,
  .info-container {
    text-align: center;
    padding: var(--spacing-xl);
    color: var(--text-secondary);
  }
  
  .loading {
    display: inline-block;
    width: 50px;
    height: 50px;
    border: 4px solid rgba(6, 182, 212, 0.2);
    border-top-color: var(--flux-cyan);
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-bottom: var(--spacing-md);
  }
  
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  
  .btn {
    background: var(--flux-cyan);
    color: white;
    border: none;
    padding: var(--spacing-md) var(--spacing-xl);
    border-radius: 4px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .btn:hover {
    background: var(--flux-blue);
    transform: translateY(-2px);
  }
  
  @media (max-width: 768px) {
    .container {
      padding: var(--spacing-md);
    }
  }
</style>