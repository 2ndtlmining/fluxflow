<script>
  import { onMount, onDestroy } from 'svelte';
  import { getApiUrl } from '$lib/client/api';

  /*
   * One request every 30 s, paused while the tab is hidden (#3).
   *
   * This used to poll /api/health, /api/database/stats and /api/blocks/status every 5 s per
   * tab, and showed the *browser's* OS and CPU count as if they were the server's, with an
   * "uptime" that was really time since the last sync (#25). Everything below now comes
   * from the server's cached /api/status snapshot.
   */
  const POLL_MS = 30_000;

  let API_URL = '';
  let version = '';
  let uptime = '-';
  let blockCount = 0;
  let latestHeight = 0;
  let lastSync = null;
  let dbSize = '-';
  let source = '-';

  let apiStatus = 'checking';
  let syncStatus = 'checking';

  let timer;

  onMount(() => {
    API_URL = getApiUrl();
    refresh();
    timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisible);
    }
  });

  function onVisible() {
    if (!document.hidden) refresh();
  }

  async function refresh() {
    try {
      const response = await fetch(`${API_URL}/api/status`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const status = await response.json();

      apiStatus = 'online';
      syncStatus = status.sync?.degraded ? 'degraded' : 'online';
      version = status.version ?? '';
      uptime = formatDuration(status.uptimeSeconds ?? 0);
      blockCount = status.database?.blocks ?? 0;
      latestHeight = status.sync?.latestHeight ?? 0;
      lastSync = status.sync?.lastSuccessfulSyncAt ?? null;
      dbSize = formatBytes(status.database?.sizeBytes ?? 0);
      source = status.dataSources?.active ?? '-';
    } catch {
      apiStatus = 'offline';
      syncStatus = 'offline';
    }
  }

  function formatDuration(seconds) {
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    return `${days}d ${hours}:${String(minutes).padStart(2, '0')}`;
  }

  function formatBytes(bytes) {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${Math.round(bytes / 1e3)} KB`;
  }

  function formatTime(ms) {
    return ms ? new Date(ms).toLocaleTimeString() : 'N/A';
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
        FLUX<br />FLOW
      </h1>
      <div class="build-info">
        Build: <span class="text-cyan">{version || '-'}</span>
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
          last sync: <span class="system-stat-value">{formatTime(lastSync)}</span>
        </span>
        <span class="status-indicators">
          <span class="status-item">
            <span class="status-label">API:</span>
            <span class="status-dot {getStatusColor(apiStatus)}"></span>
          </span>
          <span class="status-item">
            <span class="status-label">Sync:</span>
            <span class="status-dot {getStatusColor(syncStatus)}"></span>
          </span>
        </span>
      </div>

      <!-- Bottom line: data source, chain height, DB -->
      <div class="stats-line">
        <span class="system-stat">
          <span class="system-stat-label">Source:</span>
          <span class="system-stat-value">{source}</span>
        </span>
        <span class="stat-separator">|</span>
        <span class="system-stat">
          <span class="system-stat-label">Height:</span>
          <span class="system-stat-value">{latestHeight.toLocaleString()}</span>
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
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
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
