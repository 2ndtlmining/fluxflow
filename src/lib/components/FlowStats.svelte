<script>
  import { onMount } from 'svelte';
  import { getApiUrl } from '$lib/config.js';  // ← ADDED
  import { 
    Activity, 
    Database, 
    TrendingUp, 
    Receipt,
    Building2,
    Landmark,
    Server,
    Infinity
  } from 'lucide-svelte';
  import exchangeData from '$lib/data/exchanges.json';
  
  // ADDED: API_URL variable
  let API_URL = '';
  
  let blockStatus = null;
  let classificationStats = null;
  let loading = true;
  
  // Tooltip state
  let showExchangeTooltip = false;
  
  // Extract exchange names from imported JSON
  const exchangeNames = exchangeData.exchanges.map(e => e.name);
  
  async function fetchData() {
    try {
      const [blockResponse, classResponse] = await Promise.all([
        fetch(`${API_URL}/api/blocks/status`),  // ← CHANGED
        fetch(`${API_URL}/api/classification/stats`)  // ← CHANGED
      ]);
      
      blockStatus = await blockResponse.json();
      classificationStats = await classResponse.json();
    } catch (error) {
      console.error('Error fetching flow stats:', error);
    } finally {
      loading = false;
    }
  }
  
  onMount(() => {
    // ADDED: Set API_URL in browser
    API_URL = getApiUrl();
    console.log('✅ FlowStats using API URL:', API_URL);
    
    fetchData();
    
    // Refresh every 30 seconds
    const interval = setInterval(fetchData, 30000);
    
    return () => clearInterval(interval);
  });
</script>

<div class="flow-stats-container">
  <div class="section-header">
    <h2 class="section-title">Flow Stats</h2>
    <p class="section-subtitle">Real-time sync and wallet tracking metrics</p>
  </div>
  
  {#if loading}
    <div class="loading-container">
      <div class="loading"></div>
    </div>
  {:else}
    <div class="stats-grid">
      <!-- SYNC STATS SECTION -->
      <div class="stats-section sync-section">
        <div class="section-label">
          <Database size={18} />
          <span>Sync Stats</span>
        </div>
        
        <div class="stats-row">
          <div class="stat-item">
            <div class="stat-icon cyan">
              <Activity size={20} />
            </div>
            <div class="stat-content">
              <div class="stat-label">Current Height</div>
              <div class="stat-value">{(blockStatus?.currentBlockHeight || 0).toLocaleString()}</div>
            </div>
          </div>
          
          <div class="stat-item">
            <div class="stat-icon blue">
              <Database size={20} />
            </div>
            <div class="stat-content">
              <div class="stat-label">Synced Blocks</div>
              <div class="stat-value">{(blockStatus?.blockCount || 0).toLocaleString()}</div>
            </div>
          </div>
          
          <div class="stat-item">
            <div class="stat-icon green">
              <TrendingUp size={20} />
            </div>
            <div class="stat-content">
              <div class="stat-label">
                Progress
                {#if blockStatus?.isAnalyzing}
                  <span class="sync-indicator" title="Syncing...">●</span>
                {/if}
              </div>
              <div class="stat-value stat-progress">{(blockStatus?.syncProgress || 0).toFixed(1)}%</div>
              <div class="progress-bar">
                <div class="progress-fill" style="width: {blockStatus?.syncProgress || 0}%"></div>
              </div>
            </div>
          </div>
          
          <div class="stat-item">
            <div class="stat-icon purple">
              <Receipt size={20} />
            </div>
            <div class="stat-content">
              <div class="stat-label">Transactions</div>
              <div class="stat-value">{(blockStatus?.transactionCount || 0).toLocaleString()}</div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- WALLETS SECTION -->
      <div class="stats-section wallets-section">
        <div class="section-label">
          <Building2 size={18} />
          <span>Wallets</span>
        </div>
        
        <div class="wallet-grid">
          <!-- Exchanges -->
          <div 
            class="wallet-card has-tooltip"
            on:mouseenter={() => showExchangeTooltip = true}
            on:mouseleave={() => showExchangeTooltip = false}
            role="button"
            tabindex="0"
          >
            <div class="wallet-icon exchanges">
              <Building2 size={28} />
            </div>
            <div class="wallet-content">
              <div class="wallet-label">
                Exchanges
                <span class="info-icon" title="Hover to see tracked exchanges">ⓘ</span>
              </div>
              <div class="wallet-value">{classificationStats?.exchanges?.count || 0}</div>
              <div class="wallet-sublabel">wallets tracked</div>
            </div>
            
            {#if showExchangeTooltip && exchangeNames.length > 0}
              <div class="tooltip">
                <div class="tooltip-title">Tracked Exchanges</div>
                <div class="tooltip-list">
                  {#each exchangeNames as exchange}
                    <div class="tooltip-item">• {exchange}</div>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
          
          <!-- Foundation -->
          <div class="wallet-card">
            <div class="wallet-icon foundation">
              <Landmark size={28} />
            </div>
            <div class="wallet-content">
              <div class="wallet-label">Foundation</div>
              <div class="wallet-value">{classificationStats?.foundation?.count || 0}</div>
              <div class="wallet-sublabel">wallets tracked</div>
            </div>
          </div>
          
          <!-- Node Operators -->
          <div class="wallet-card">
            <div class="wallet-icon nodes">
              <Server size={28} />
            </div>
            <div class="wallet-content">
              <div class="wallet-label">Node Operators</div>
              <div class="wallet-value">{classificationStats?.nodeOperators?.count || 0}</div>
              <div class="wallet-sublabel">{(classificationStats?.nodeOperators?.totalNodes || 0).toLocaleString()} total nodes</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .flow-stats-container {
    margin-bottom: var(--spacing-xl);
  }
  
  .section-header {
    margin-bottom: var(--spacing-lg);
    border-left: 4px solid var(--flux-cyan);
    padding-left: var(--spacing-md);
  }
  
  .section-title {
    font-size: 1.75rem;
    font-weight: 700;
    color: var(--text-primary);
    margin: 0 0 var(--spacing-xs) 0;
    font-family: 'Courier New', monospace;
    letter-spacing: 0.5px;
  }
  
  .section-subtitle {
    font-size: 0.875rem;
    color: var(--text-secondary);
    margin: 0;
  }
  
  .loading-container {
    display: flex;
    justify-content: center;
    padding: var(--spacing-xl);
  }
  
  .loading {
    width: 40px;
    height: 40px;
    border: 3px solid rgba(6, 182, 212, 0.2);
    border-top-color: var(--flux-cyan);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  
  .stats-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--spacing-lg);
  }
  
  .stats-section {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: var(--spacing-lg);
    transition: all 0.3s ease;
  }
  
  .stats-section:hover {
    border-color: rgba(6, 182, 212, 0.4);
    box-shadow: 0 4px 20px rgba(6, 182, 212, 0.1);
  }
  
  .section-label {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: var(--spacing-lg);
    padding-bottom: var(--spacing-sm);
    border-bottom: 1px solid var(--border-color);
  }
  
  /* SYNC STATS */
  .stats-row {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--spacing-md);
  }
  
  .stat-item {
    display: flex;
    align-items: flex-start;
    gap: var(--spacing-md);
    padding: var(--spacing-md);
    background: rgba(6, 182, 212, 0.03);
    border-radius: 8px;
    transition: all 0.2s ease;
  }
  
  .stat-item:hover {
    background: rgba(6, 182, 212, 0.08);
    transform: translateY(-2px);
  }
  
  .stat-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 8px;
    flex-shrink: 0;
  }
  
  .stat-icon.cyan {
    background: rgba(6, 182, 212, 0.15);
    color: var(--flux-cyan);
  }
  
  .stat-icon.blue {
    background: rgba(14, 165, 233, 0.15);
    color: #0ea5e9;
  }
  
  .stat-icon.green {
    background: rgba(16, 185, 129, 0.15);
    color: #10b981;
  }
  
  .stat-icon.purple {
    background: rgba(139, 92, 246, 0.15);
    color: #8b5cf6;
  }
  
  .stat-content {
    flex: 1;
    min-width: 0;
  }
  
  .stat-label {
    font-size: 0.75rem;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 4px;
  }
  
  .stat-value {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--text-primary);
    font-family: 'Courier New', monospace;
    line-height: 1.2;
  }
  
  .stat-progress {
    color: var(--flux-cyan);
  }
  
  .progress-bar {
    margin-top: 8px;
    width: 100%;
    height: 6px;
    background: rgba(6, 182, 212, 0.1);
    border-radius: 3px;
    overflow: hidden;
  }
  
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--flux-cyan), #0ea5e9);
    border-radius: 3px;
    transition: width 0.5s ease;
  }
  
  /* Sync indicator */
  .sync-indicator {
    display: inline-block;
    margin-left: 6px;
    color: #f59e0b;
    font-size: 1rem;
    animation: pulse-sync 1.5s ease-in-out infinite;
  }
  
  @keyframes pulse-sync {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  
  /* WALLETS */
  .wallet-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--spacing-md);
  }
  
  .wallet-card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: var(--spacing-lg);
    background: rgba(6, 182, 212, 0.03);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    transition: all 0.3s ease;
    cursor: pointer;
  }
  
  .wallet-card:hover {
    border-color: var(--flux-cyan);
    background: rgba(6, 182, 212, 0.08);
    transform: translateY(-4px);
    box-shadow: 0 8px 24px rgba(6, 182, 212, 0.15);
  }
  
  .wallet-card.has-tooltip {
    cursor: help;
  }
  
  .wallet-card.has-tooltip:hover {
    border-color: var(--flux-cyan);
  }
  
  .wallet-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 60px;
    height: 60px;
    border-radius: 12px;
    margin-bottom: var(--spacing-md);
  }
  
  .wallet-icon.exchanges {
    background: linear-gradient(135deg, rgba(6, 182, 212, 0.2), rgba(14, 165, 233, 0.2));
    color: var(--flux-cyan);
  }
  
  .wallet-icon.foundation {
    background: linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(251, 191, 36, 0.2));
    color: #f59e0b;
  }
  
  .wallet-icon.nodes {
    background: linear-gradient(135deg, rgba(16, 185, 129, 0.2), rgba(5, 150, 105, 0.2));
    color: #10b981;
  }
  
  .wallet-content {
    width: 100%;
  }
  
  .wallet-label {
    font-size: 0.75rem;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: var(--spacing-xs);
    font-weight: 600;
  }
  
  .info-icon {
    display: inline-block;
    margin-left: 4px;
    font-size: 0.875rem;
    color: var(--flux-cyan);
    opacity: 0.6;
    transition: opacity 0.2s;
  }
  
  .wallet-card:hover .info-icon {
    opacity: 1;
  }
  
  .wallet-value {
    font-size: 2rem;
    font-weight: 700;
    color: var(--flux-cyan);
    font-family: 'Courier New', monospace;
    line-height: 1;
    margin-bottom: var(--spacing-xs);
  }
  
  .wallet-sublabel {
    font-size: 0.75rem;
    color: var(--text-dim);
  }
  
  /* TOOLTIPS */
  .tooltip {
    position: absolute;
    bottom: calc(100% + 12px);
    left: 50%;
    transform: translateX(-50%);
    background: rgba(10, 10, 15, 0.98);
    border: 1px solid var(--flux-cyan);
    border-radius: 8px;
    padding: var(--spacing-md);
    min-width: 200px;
    z-index: 1000;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    animation: tooltipFadeIn 0.2s ease;
  }
  
  .tooltip::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 6px solid transparent;
    border-top-color: var(--flux-cyan);
  }
  
  @keyframes tooltipFadeIn {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(-5px);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }
  
  .tooltip-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--flux-cyan);
    margin-bottom: var(--spacing-sm);
    padding-bottom: var(--spacing-xs);
    border-bottom: 1px solid rgba(6, 182, 212, 0.3);
  }
  
  .tooltip-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  
  .tooltip-item {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    padding: 4px 0;
  }
  
  /* RESPONSIVE */
  @media (max-width: 1200px) {
    .stats-grid {
      grid-template-columns: 1fr;
    }
    
    .wallet-grid {
      grid-template-columns: repeat(3, 1fr);
    }
  }
  
  @media (max-width: 768px) {
    .stats-row {
      grid-template-columns: 1fr;
    }
    
    .wallet-grid {
      grid-template-columns: 1fr;
    }
    
    .section-header {
      padding-left: var(--spacing-sm);
    }
    
    .section-title {
      font-size: 1.5rem;
    }
  }
</style>