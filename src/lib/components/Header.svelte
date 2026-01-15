<script>
  import { onMount, onDestroy } from 'svelte';
  import { getApiUrl } from '$lib/config.js';  // ← CHANGED: Import getApiUrl
  
  // CHANGED: Initialize empty, set in onMount
  let API_URL = '';
  
  // System stats
  let uptime = '0 days, 0:00';
  let os = 'Loading...';
  let cpuCores = 0;
  let dbSize = '0KB';
  
  // Block sync stats
  let blockCount = 0;
  let lastSync = null;
  
  // Status indicators
  let apiStatus = 'checking';
  let dbStatus = 'checking';
  
  let interval;
  
  onMount(async () => {
    // CHANGED: Set API_URL here (client-side only)
    API_URL = getApiUrl();
    console.log('✅ Header using API URL:', API_URL);
    
    await fetchSystemStats();
    
    // Update every 5 seconds
    interval = setInterval(fetchSystemStats, 5000);
  });
  
  onDestroy(() => {
    if (interval) clearInterval(interval);
  });
  
  async function fetchSystemStats() {
    try {
      // Get browser/system info first (always works)
      if (typeof window !== 'undefined') {
        os = getOSInfo();
        cpuCores = navigator.hardwareConcurrency || 4;
      }
      
      // Fetch health status
      const healthResponse = await fetch(`${API_URL}/api/health`);
      const health = await healthResponse.json();
      
      if (health.status === 'ok') {
        apiStatus = 'online';
        
        // Calculate uptime from last sync
        if (health.sync && health.sync.lastSync) {
          const lastSyncTime = new Date(health.sync.lastSync);
          const now = new Date();
          const uptimeMs = now - lastSyncTime;
          const uptimeSeconds = Math.floor(uptimeMs / 1000);
          const days = Math.floor(uptimeSeconds / 86400);
          const hours = Math.floor((uptimeSeconds % 86400) / 3600);
          const minutes = Math.floor((uptimeSeconds % 3600) / 60);
          uptime = `${days} days, ${hours}:${minutes.toString().padStart(2, '0')}`;
        }
        
        blockCount = health.database?.blocks || 0;
      }
      
      // Fetch database stats
      try {
        const dbResponse = await fetch(`${API_URL}/api/database/stats`);
        const dbStats = await dbResponse.json();
        
        if (dbStats) {
          dbStatus = 'online';
          dbSize = dbStats.size || '0KB';
          
          // Get last sync date from block range
          if (dbStats.blockRange?.maxHeight) {
            // Block height is not a timestamp, so we'll use current date
            lastSync = new Date().toISOString().split('T')[0];
          }
        }
      } catch (e) {
        console.error('Error fetching database stats:', e);
        dbStatus = 'offline';
        dbSize = '0KB';
      }
      
      // Fetch block sync status
      try {
        const blockResponse = await fetch(`${API_URL}/api/blocks/status`);
        const blockStatus = await blockResponse.json();
        
        if (blockStatus) {
          blockCount = blockStatus.blockCount || 0;
          if (blockStatus.lastSync) {
            lastSync = new Date(blockStatus.lastSync).toISOString().split('T')[0];
          }
        }
      } catch (e) {
        console.error('Error fetching block status:', e);
      }
      
    } catch (error) {
      console.error('Error fetching system stats:', error);
      apiStatus = 'offline';
      dbStatus = 'offline';
      
      // Still show browser stats even if API is down
      if (typeof window !== 'undefined') {
        os = getOSInfo();
        cpuCores = navigator.hardwareConcurrency || 4;
      }
    }
  }
  
  function getOSInfo() {
    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes('linux')) return 'Linux';
    if (userAgent.includes('mac')) return 'macOS';
    if (userAgent.includes('win')) return 'Windows';
    return 'Unknown';
  }
  
  function getStatusColor(status) {
    if (status === 'online') return 'green';
    if (status === 'offline') return 'red';
    return 'yellow';
  }
</script>

<header class="header terminal-border">
  <div class="header-content">
    <!-- Left side: Title and Build Info -->
    <div class="header-left">
      <h1 class="header-title glow-text">
        FLUX<br/>FLOW
      </h1>
      <div class="build-info">
        Build: <span class="text-cyan">v.01</span>
      </div>
    </div>
    
    <!-- Right side: System Stats (Two lines) -->
    <div class="header-stats">
      <!-- Top line: Uptime, Blocks, Last Sync -->
      <div class="stats-line">
        <span class="system-stat">
          up <span class="system-stat-value">{uptime}</span>
        </span>
        <span class="stat-separator">|</span>
        <span class="system-stat">
          <span class="system-stat-value">{blockCount.toLocaleString()}</span> blocks
        </span>
        <span class="stat-separator">|</span>
        <span class="system-stat">
          last sync: <span class="system-stat-value">{lastSync || 'N/A'}</span>
        </span>
        <span class="status-indicators">
          <span class="status-item">
            <span class="status-label">API:</span>
            <span class="status-dot {getStatusColor(apiStatus)}"></span>
          </span>
          <span class="status-item">
            <span class="status-label">DB:</span>
            <span class="status-dot {getStatusColor(dbStatus)}"></span>
          </span>
        </span>
      </div>
      
      <!-- Bottom line: OS, CPU, DB -->
      <div class="stats-line">
        <span class="system-stat">
          <span class="system-stat-label">OS:</span> 
          <span class="system-stat-value">{os}</span>
        </span>
        <span class="stat-separator">|</span>
        <span class="system-stat">
          <span class="system-stat-label">CPU:</span> 
          <span class="system-stat-value">{cpuCores} cores</span>
        </span>
        <span class="stat-separator">|</span>
        <span class="system-stat">
          <span class="system-stat-label">DB:</span> 
          <span class="system-stat-value">{dbSize}</span>
        </span>
      </div>
    </div>
  </div>
</header>

<style>
  .header {
    background: var(--bg-header);
    padding: var(--spacing-lg) var(--spacing-xl);
    margin-bottom: var(--spacing-xl);
    border-left: none;
    border-right: none;
    border-top: none;
    border-radius: 0;
  }
  
  .header-content {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--spacing-xl);
    max-width: 1600px;
    margin: 0 auto;
  }
  
  .header-left {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs);
  }
  
  .header-title {
    font-size: 2.5rem;
    line-height: 1.1;
    font-weight: 700;
    letter-spacing: 3px;
    margin: 0;
    text-transform: uppercase;
    color: var(--text-primary);
    text-shadow: var(--glow-cyan);
  }
  
  .build-info {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-weight: 400;
  }
  
  .text-cyan {
    color: var(--accent-cyan);
  }
  
  .header-stats {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
    align-items: flex-end;
    font-size: 0.75rem;
    white-space: nowrap;
  }
  
  .stats-line {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
  }
  
  .system-stat {
    color: var(--text-dim);
    font-weight: 500;
  }
  
  .system-stat-label {
    color: var(--text-muted);
  }
  
  .system-stat-value {
    color: var(--text-white);
    font-weight: 600;
  }
  
  .system-stat-value.good {
    color: var(--accent-green);
  }
  
  .system-stat-value.warn {
    color: var(--accent-yellow);
  }
  
  .system-stat-value.error {
    color: var(--accent-red);
  }
  
  .stat-separator {
    color: var(--border-color);
    opacity: 0.5;
  }
  
  .status-indicators {
    display: flex;
    gap: var(--spacing-md);
    margin-left: var(--spacing-md);
  }
  
  .status-item {
    display: flex;
    align-items: center;
    gap: var(--spacing-xs);
  }
  
  .status-label {
    color: var(--text-muted);
    font-weight: 500;
    font-size: 0.75rem;
  }
  
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    animation: pulse 2s ease-in-out infinite;
  }
  
  .status-dot.green {
    background: var(--accent-green);
    box-shadow: 0 0 10px var(--accent-green);
  }
  
  .status-dot.red {
    background: var(--accent-red);
    box-shadow: 0 0 10px var(--accent-red);
  }
  
  .status-dot.yellow {
    background: var(--accent-yellow);
    box-shadow: 0 0 10px var(--accent-yellow);
  }
  
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  
  /* Responsive */
  @media (max-width: 1024px) {
    .header-content {
      flex-direction: column;
      align-items: flex-start;
    }
    
    .header-stats {
      width: 100%;
      align-items: flex-start;
    }
    
    .header-title {
      font-size: 2rem;
    }
  }
  
  @media (max-width: 768px) {
    .header {
      padding: var(--spacing-md);
    }
    
    .header-title {
      font-size: 1.5rem;
      letter-spacing: 2px;
    }
    
    .stats-line {
      flex-wrap: wrap;
      font-size: 0.65rem;
    }
    
    .system-stat {
      font-size: 0.65rem;
    }
  }
</style>