<script>
  import { onMount, onDestroy } from 'svelte';
  import { getApiUrl } from '$lib/config.js';
  
  let API_URL = '';
  let isEnhancing = false;
  let enhancementStats = {
    totalAnalyzed: 0,
    enhancedToBuying: 0,
    enhancedToSelling: 0,
    remainedUnknown: 0,
    errors: 0
  };
  
  let unknownStats = {
    unknownBuys: 0,
    unknownSells: 0,
    totalUnknowns: 0
  };
  
  let statusCheckInterval;
  let showInfo = false;
  
  onMount(async () => {
    API_URL = getApiUrl();
    await loadUnknownStats();
    
    // Check status every 3 seconds
    statusCheckInterval = setInterval(async () => {
      if (isEnhancing) {
        await checkEnhancementStatus();
      }
    }, 3000);
  });
  
  onDestroy(() => {
    if (statusCheckInterval) clearInterval(statusCheckInterval);
  });
  
  async function loadUnknownStats() {
    try {
      const response = await fetch(`${API_URL}/api/unknowns/stats`);
      if (response.ok) {
        unknownStats = await response.json();
      }
    } catch (error) {
      console.error('Error loading unknown stats:', error);
    }
  }
  
  async function checkEnhancementStatus() {
    try {
      const response = await fetch(`${API_URL}/api/enhance-wallets/status`);
      if (response.ok) {
        const data = await response.json();
        isEnhancing = data.isRunning;
        if (data.stats) {
          enhancementStats = data.stats;
        }
      }
    } catch (error) {
      console.error('Error checking status:', error);
    }
  }
  
  async function triggerEnhancement() {
    if (isEnhancing) return;
    
    if (!confirm('🔍 Wallet Enhancement - 1-Hop Analysis\n\nThis will analyze all unknown wallets to detect node operators using intermediary wallets.\n\n⏱️ This may take 2-5 minutes depending on transaction count.\n\nContinue?')) {
      return;
    }
    
    isEnhancing = true;
    enhancementStats = {
      totalAnalyzed: 0,
      enhancedToBuying: 0,
      enhancedToSelling: 0,
      remainedUnknown: 0,
      errors: 0
    };
    
    try {
      const response = await fetch(`${API_URL}/api/enhance-wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      const result = await response.json();
      
      if (result.success) {
        enhancementStats = result.stats;
        alert(`✅ Enhancement Complete!\n\n📊 Analyzed: ${result.stats.totalAnalyzed}\n🔵 Enhanced Buying: ${result.stats.enhancedToBuying}\n🔴 Enhanced Selling: ${result.stats.enhancedToSelling}\n⚪ Remained Unknown: ${result.stats.remainedUnknown}\n❌ Errors: ${result.stats.errors}`);
        
        // Reload stats
        await loadUnknownStats();
        
        // Refresh page to show updated data
        window.location.reload();
      } else {
        alert('❌ Enhancement failed: ' + result.message);
      }
    } catch (error) {
      console.error('Enhancement error:', error);
      alert('❌ Enhancement error: ' + error.message);
    } finally {
      isEnhancing = false;
    }
  }
</script>

<div class="enhancement-panel card">
  <div class="panel-header">
    <div class="title-section">
      <h3>🔍 Wallet Enhancement (Phase 2)</h3>
      <button class="info-button" on:click={() => showInfo = !showInfo}>
        {showInfo ? '▼' : 'ℹ️'}
      </button>
    </div>
    {#if showInfo}
      <div class="info-box">
        <p><strong>What is 1-hop analysis?</strong></p>
        <p>Many node operators use intermediary wallets between exchanges and their node wallets. This feature detects those patterns:</p>
        <ul>
          <li>🔵 <strong>Buying:</strong> Exchange → Intermediary Wallet → Node Wallet</li>
          <li>🔴 <strong>Selling:</strong> Node Wallet → Intermediary Wallet → Exchange</li>
        </ul>
        <p>When detected, we classify the flow as a node operator transaction (Level 1).</p>
      </div>
    {/if}
  </div>
  
  <div class="stats-grid">
    <div class="stat-card unknown">
      <div class="stat-icon">❓</div>
      <div class="stat-content">
        <div class="stat-label">Unknown Wallets</div>
        <div class="stat-value">{unknownStats.totalUnknowns}</div>
        <div class="stat-breakdown">
          <span class="buy-color">{unknownStats.unknownBuys} buying</span>
          <span class="separator">·</span>
          <span class="sell-color">{unknownStats.unknownSells} selling</span>
        </div>
      </div>
    </div>
    
    {#if enhancementStats.totalAnalyzed > 0}
      <div class="stat-card enhanced">
        <div class="stat-icon">✅</div>
        <div class="stat-content">
          <div class="stat-label">Enhanced to Nodes</div>
          <div class="stat-value">{enhancementStats.enhancedToBuying + enhancementStats.enhancedToSelling}</div>
          <div class="stat-breakdown">
            <span class="buy-color">{enhancementStats.enhancedToBuying} buying</span>
            <span class="separator">·</span>
            <span class="sell-color">{enhancementStats.enhancedToSelling} selling</span>
          </div>
        </div>
      </div>
    {/if}
  </div>
  
  <div class="action-section">
    <button 
      class="enhance-button" 
      class:disabled={isEnhancing || unknownStats.totalUnknowns === 0}
      disabled={isEnhancing || unknownStats.totalUnknowns === 0}
      on:click={triggerEnhancement}
    >
      {#if isEnhancing}
        <span class="spinner"></span>
        <span>Analyzing... ({enhancementStats.totalAnalyzed} processed)</span>
      {:else if unknownStats.totalUnknowns === 0}
        <span>✅ No Unknown Wallets</span>
      {:else}
        <span>🔍 Run Enhancement Analysis</span>
      {/if}
    </button>
    
    {#if isEnhancing}
      <div class="progress-info">
        <p>⏱️ Analysis in progress... This may take a few minutes.</p>
        <div class="live-stats">
          <span>✅ Enhanced: {enhancementStats.enhancedToBuying + enhancementStats.enhancedToSelling}</span>
          <span>⚪ Unknown: {enhancementStats.remainedUnknown}</span>
          {#if enhancementStats.errors > 0}
            <span>❌ Errors: {enhancementStats.errors}</span>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .enhancement-panel {
    margin-bottom: var(--spacing-xl);
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: var(--spacing-lg);
  }
  
  .panel-header {
    margin-bottom: var(--spacing-lg);
  }
  
  .title-section {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--spacing-sm);
  }
  
  .title-section h3 {
    margin: 0;
    color: var(--text-primary);
    font-size: 1.25rem;
  }
  
  .info-button {
    background: rgba(6, 182, 212, 0.1);
    border: 1px solid rgba(6, 182, 212, 0.3);
    color: var(--flux-cyan);
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    transition: all 0.2s;
  }
  
  .info-button:hover {
    background: rgba(6, 182, 212, 0.2);
    border-color: var(--flux-cyan);
  }
  
  .info-box {
    background: rgba(6, 182, 212, 0.05);
    border: 1px solid rgba(6, 182, 212, 0.2);
    border-radius: 6px;
    padding: var(--spacing-md);
    margin-top: var(--spacing-md);
    color: var(--text-secondary);
    font-size: 0.875rem;
    line-height: 1.6;
  }
  
  .info-box strong {
    color: var(--text-primary);
  }
  
  .info-box ul {
    margin: var(--spacing-sm) 0;
    padding-left: var(--spacing-lg);
  }
  
  .info-box li {
    margin: var(--spacing-xs) 0;
  }
  
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: var(--spacing-md);
    margin-bottom: var(--spacing-lg);
  }
  
  .stat-card {
    background: rgba(6, 182, 212, 0.05);
    border: 1px solid rgba(6, 182, 212, 0.2);
    border-radius: 6px;
    padding: var(--spacing-md);
    display: flex;
    align-items: center;
    gap: var(--spacing-md);
  }
  
  .stat-card.enhanced {
    background: rgba(16, 185, 129, 0.05);
    border-color: rgba(16, 185, 129, 0.2);
  }
  
  .stat-icon {
    font-size: 2rem;
  }
  
  .stat-content {
    flex: 1;
  }
  
  .stat-label {
    color: var(--text-muted);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.25rem;
  }
  
  .stat-value {
    color: var(--text-primary);
    font-size: 2rem;
    font-weight: 700;
    line-height: 1;
    margin-bottom: 0.25rem;
  }
  
  .stat-breakdown {
    color: var(--text-secondary);
    font-size: 0.875rem;
  }
  
  .buy-color {
    color: var(--accent-green);
  }
  
  .sell-color {
    color: var(--accent-red);
  }
  
  .separator {
    color: var(--text-dim);
    margin: 0 0.5rem;
  }
  
  .action-section {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-md);
  }
  
  .enhance-button {
    background: linear-gradient(135deg, var(--flux-cyan), var(--flux-blue));
    color: white;
    border: none;
    padding: var(--spacing-md) var(--spacing-xl);
    border-radius: 6px;
    font-weight: 600;
    font-size: 1rem;
    cursor: pointer;
    transition: all 0.3s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--spacing-sm);
    box-shadow: 0 4px 12px rgba(6, 182, 212, 0.3);
  }
  
  .enhance-button:hover:not(.disabled) {
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(6, 182, 212, 0.4);
  }
  
  .enhance-button.disabled {
    background: rgba(255, 255, 255, 0.1);
    color: var(--text-dim);
    cursor: not-allowed;
    box-shadow: none;
  }
  
  .spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  
  .progress-info {
    background: rgba(6, 182, 212, 0.05);
    border: 1px solid rgba(6, 182, 212, 0.2);
    border-radius: 6px;
    padding: var(--spacing-md);
    text-align: center;
  }
  
  .progress-info p {
    color: var(--text-secondary);
    margin: 0 0 var(--spacing-sm) 0;
    font-size: 0.875rem;
  }
  
  .live-stats {
    display: flex;
    justify-content: center;
    gap: var(--spacing-lg);
    flex-wrap: wrap;
    font-size: 0.875rem;
    color: var(--text-secondary);
  }
  
  @media (max-width: 768px) {
    .stats-grid {
      grid-template-columns: 1fr;
    }
    
    .live-stats {
      flex-direction: column;
      gap: var(--spacing-sm);
    }
  }
</style>