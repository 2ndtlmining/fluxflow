// Flux Flow Tracker Configuration
// PHASE 1: Added Flux Indexer (192.168.10.65) as primary data source

export const FLUX_CONFIG = {
  // ============================================================================
  // BLOCK CONFIGURATION
  // ============================================================================
  BLOCK_TIME_SECONDS: 30,
  
  PERIODS: {
    '24H': Math.floor((24 * 60 * 60) / 30),
    '7D': Math.floor((7 * 24 * 60 * 60) / 30),
    '30D': Math.floor((30 * 24 * 60 * 60) / 30),
    '90D': Math.floor((90 * 24 * 60 * 60) / 30),
    '1Y': Math.floor((365 * 24 * 60 * 60) / 30)
  },

  PERIOD_LABELS: {
    '24H': 'Today',
    '7D': 'This Week', 
    '30D': 'This Month',
    '90D': 'This Quarter',
    '1Y': 'This Year'
  },

  // ============================================================================
  // DATA SOURCES - FLUX INDEXER PRIMARY, BLOCKBOOK FALLBACK
  // ============================================================================
  
  DATA_SOURCES: {
    FLUX_INDEXER: {
      enabled: true,
      baseUrl: 'http://192.168.10.65:42067',
      apiVersion: 'v1',
      timeout: 30000,
      endpoints: {
        health: '/health',
        status: '/api/v1/status',
        latestBlocks: '/api/v1/blocks/latest',
        block: '/api/v1/blocks',
        transaction: '/api/v1/transactions',
        address: '/api/v1/addresses',
        addressTxs: '/api/v1/addresses',
        addressUtxos: '/api/v1/addresses',
        dashboard: '/api/v1/stats/dashboard'
      }
    },
    
    BLOCKBOOK: {
      enabled: true,
      baseUrl: 'https://blockbook.runonflux.io',
      apiVersion: 'v2',
      timeout: 30000,
      endpoints: {
        root: '/api/v2',
        block: '/api/v2/block',
        transaction: '/api/v2/tx',
        address: '/api/v2/address'
      }
    }
  },

  ACTIVE_DATA_SOURCE: 'FLUX_INDEXER',

  // ============================================================================
  // BLOCK SYNC CONFIGURATION - DUAL SETTINGS
  // ============================================================================
  
  // Default/legacy settings (used as fallback)
  MAX_BLOCKS_IN_MEMORY: 100000,
  BLOCK_FETCH_INTERVAL: 30000,
  INITIAL_SYNC_BATCH_SIZE: 30,
  BATCH_DELAY: 1000,
  MAX_CONCURRENT_REQUESTS: 2,
  MIN_REQUEST_DELAY: 200,
  
  // PHASE 1B: Source-specific sync settings
  SYNC_SETTINGS: {
    FLUX_INDEXER: {
      // Aggressive settings for local indexer (no rate limits!)
      BATCH_SIZE: 500,              // 100 blocks per batch (vs 30)
      MAX_CONCURRENT: 10,           // 10 concurrent requests (vs 2)
      MIN_REQUEST_DELAY: 10,        // 10ms delay (vs 200ms)
      BATCH_DELAY: 100,             // 100ms between batches (vs 1000ms)
      ENABLE_RATE_LIMITING: false,  // No rate limit backoff needed
      TRANSACTION_FETCH_LIMIT: 50   // Fetch up to 50 txs per block
    },
    
    BLOCKBOOK: {
      // Conservative settings for public API (rate limited)
      BATCH_SIZE: 30,               // 30 blocks per batch
      MAX_CONCURRENT: 2,            // Only 2 concurrent
      MIN_REQUEST_DELAY: 200,       // 200ms delay
      BATCH_DELAY: 1000,            // 1 second between batches
      ENABLE_RATE_LIMITING: true,   // Use exponential backoff
      TRANSACTION_FETCH_LIMIT: 20   // Fetch up to 20 txs per block
    }
  },
  
  MIN_BLOCKS_REQUIRED: {
    '24H': Math.floor((24 * 60 * 60) / 30),
    '7D': Math.floor((7 * 24 * 60 * 60) / 30),
    '30D': Math.floor((30 * 24 * 60 * 60) / 30),
    '90D': Math.floor((90 * 24 * 60 * 60) / 30),
    '1Y': Math.floor((365 * 24 * 60 * 60) / 30)
  },

  // ============================================================================
  // LEGACY ENDPOINTS (for compatibility)
  // ============================================================================
  
  FLUX_BASE: 'https://api.runonflux.io',
  DAEMON: 'https://api.runonflux.io/daemon',
  BLOCKBOOK_ENDPOINTS: ['https://blockbook.runonflux.io/api/v2'],
  BLOCKBOOK_API: 'https://blockbook.runonflux.io/api/v2',
  FLUX_NODES_API: 'https://explorer.runonflux.io/api/status?q=getFluxNodes',
  
  API_RETRY_ATTEMPTS: 3,
  API_RETRY_DELAY: 2000,
  API_TIMEOUT: 30000,
  RATE_LIMIT_RETRY_DELAY: 5000,

  // ============================================================================
  // NODE OPERATOR CONFIGURATION
  // ============================================================================
  
  NODE_REFRESH_BLOCKS: 100,
  
  NODE_TIERS: {
    CUMULUS: { collateral: 1000, cores: 2, ram: 8, storage: 220 },
    NIMBUS: { collateral: 12500, cores: 4, ram: 32, storage: 440 },
    STRATUS: { collateral: 40000, cores: 8, ram: 64, storage: 880 }
  },

  // ============================================================================
  // DATA CLASSIFICATION
  // ============================================================================
  
  EXCHANGES_CONFIG_PATH: './src/lib/data/exchanges.json',
  MIN_TRANSACTION_VALUE: 1,

  // ============================================================================
  // WALLET ENHANCEMENT (PHASE 1 - New!)
  // ============================================================================
  
  ENHANCEMENT: {
    MAX_HOPS: 1,  // Only analyze 1 level deep
    TIME_WINDOW_BLOCKS: 100,  // 50 minutes at 30s/block
    MIN_CONFIDENCE: 0.8,
    BATCH_SIZE: 100
  },

  // ============================================================================
  // UI CONFIGURATION
  // ============================================================================
  
  DEFAULT_PERIOD: '24H',
  CHART_MAX_POINTS: 100,
  FRONTEND_REFRESH_INTERVAL: 300000,

  // ============================================================================
  // LOGGING
  // ============================================================================
  
  LOGGING: {
    ENABLE_DEBUG: false,
    LOG_BLOCK_PROCESSING: true,
    LOG_API_CALLS: false,
    LOG_CLASSIFICATION: false,
    LOG_DATA_SOURCE_SWITCHES: true  // NEW: Log when switching sources
  },
  
  PERFORMANCE: {
    LOG_BATCH_TIMING: true,
    LOG_FETCH_TIMING: true,
    LOG_PROCESS_TIMING: true,
    TARGET_BLOCKS_PER_MINUTE: 60
  }
};

// ============================================================================
// DATA SOURCE HELPERS
// ============================================================================

export function getIndexerUrl(endpoint, param = '') {
  const config = FLUX_CONFIG.DATA_SOURCES.FLUX_INDEXER;
  const path = config.endpoints[endpoint];
  
  if (!path) throw new Error(`Unknown indexer endpoint: ${endpoint}`);
  
  return param ? `${config.baseUrl}${path}/${param}` : `${config.baseUrl}${path}`;
}

export function getBlockbookUrl(endpoint, param = '') {
  const config = FLUX_CONFIG.DATA_SOURCES.BLOCKBOOK;
  const path = config.endpoints[endpoint];
  
  if (!path) throw new Error(`Unknown blockbook endpoint: ${endpoint}`);
  
  return param ? `${path}/${param}` : path;
}

export function switchToFallbackDataSource() {
  const current = FLUX_CONFIG.ACTIVE_DATA_SOURCE;
  
  if (current === 'FLUX_INDEXER') {
    FLUX_CONFIG.ACTIVE_DATA_SOURCE = 'BLOCKBOOK';
    console.log('⚠️  Switched to Blockbook fallback');
    return 'BLOCKBOOK';
  } else {
    FLUX_CONFIG.ACTIVE_DATA_SOURCE = 'FLUX_INDEXER';
    console.log('🔄 Switched back to Flux Indexer');
    return 'FLUX_INDEXER';
  }
}

export function getActiveDataSource() {
  return FLUX_CONFIG.ACTIVE_DATA_SOURCE;
}

// ============================================================================
// LEGACY HELPERS
// ============================================================================

let currentEndpointIndex = 0;

export function getCurrentBlockbookEndpoint() {
  return FLUX_CONFIG.BLOCKBOOK_ENDPOINTS[currentEndpointIndex];
}

export function rotateBlockbookEndpoint() {
  const previousEndpoint = FLUX_CONFIG.BLOCKBOOK_ENDPOINTS[currentEndpointIndex];
  currentEndpointIndex = (currentEndpointIndex + 1) % FLUX_CONFIG.BLOCKBOOK_ENDPOINTS.length;
  FLUX_CONFIG.BLOCKBOOK_API = FLUX_CONFIG.BLOCKBOOK_ENDPOINTS[currentEndpointIndex];
  
  console.log(`⚠️  Rotated Blockbook endpoint`);
  console.log(`   Previous: ${previousEndpoint}`);
  console.log(`   Current:  ${FLUX_CONFIG.BLOCKBOOK_API}`);
  
  return FLUX_CONFIG.BLOCKBOOK_API;
}

export function resetBlockbookEndpoint() {
  currentEndpointIndex = 0;
  FLUX_CONFIG.BLOCKBOOK_API = FLUX_CONFIG.BLOCKBOOK_ENDPOINTS[0];
  console.log(`🔄 Reset to primary Blockbook endpoint: ${FLUX_CONFIG.BLOCKBOOK_API}`);
}

// ============================================================================
// TIME HELPERS
// ============================================================================

export function blocksToTime(blocks) {
  const seconds = blocks * FLUX_CONFIG.BLOCK_TIME_SECONDS;
  const days = Math.floor(seconds / (24 * 60 * 60));
  const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));
  const minutes = Math.floor((seconds % (60 * 60)) / 60);
  
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function timeToBlocks(hours) {
  return Math.floor((hours * 60 * 60) / FLUX_CONFIG.BLOCK_TIME_SECONDS);
}

export function getPeriodBlocks(period) {
  return FLUX_CONFIG.PERIODS[period] || FLUX_CONFIG.PERIODS['24H'];
}

export function hasEnoughBlocks(currentBlockCount, period) {
  const required = FLUX_CONFIG.MIN_BLOCKS_REQUIRED[period];
  return currentBlockCount >= required;
}

// ============================================================================
// FRONTEND API URL
// ============================================================================

export function getApiUrl() {
  if (typeof window === 'undefined') {
    console.warn('⚠️ getApiUrl() called during SSR!');
    return '';
  }

  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }

  const hostname = window.location.hostname;
  
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'http://localhost:3000';
  }
  
  return window.location.origin;
}