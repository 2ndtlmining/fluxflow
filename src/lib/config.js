// Flux Flow Tracker Configuration
// All constants and configuration in one place for easy maintenance

export const FLUX_CONFIG = {
  // ============================================================================
  // BLOCK CONFIGURATION
  // ============================================================================
  BLOCK_TIME_SECONDS: 30,  // Flux block time
  
  // Time periods defined in blocks (based on 30-second blocks)
  PERIODS: {
    '24H': Math.floor((24 * 60 * 60) / 30),        // 2,880 blocks (~1 day)
    '7D': Math.floor((7 * 24 * 60 * 60) / 30),     // 20,160 blocks (~7 days)
    '30D': Math.floor((30 * 24 * 60 * 60) / 30),   // 86,400 blocks (~30 days)
    '90D': Math.floor((90 * 24 * 60 * 60) / 30),   // 259,200 blocks (~90 days)
    '1Y': Math.floor((365 * 24 * 60 * 60) / 30)    // 1,051,200 blocks (~1 year)
  },

  // Display names for periods
  PERIOD_LABELS: {
    '24H': 'Today',
    '7D': 'This Week', 
    '30D': 'This Month',
    '90D': 'This Quarter',
    '1Y': 'This Year'
  },

  // ============================================================================
  // BLOCK ANALYSIS CONFIGURATION - WEEK 1 CONSERVATIVE SETTINGS
  // ============================================================================
  
  // Maximum blocks to keep in memory
  MAX_BLOCKS_IN_MEMORY: 100000,  // ~34 days worth of blocks
  
  // How often to fetch new blocks (milliseconds)
  BLOCK_FETCH_INTERVAL: 30000,  // 30 seconds (match block time)
  
  // UPDATED: Batch size for initial sync - WEEK 1 CONSERVATIVE
  INITIAL_SYNC_BATCH_SIZE: 30,  // Conservative: 30 blocks per batch (was 20)
  
  // UPDATED: Delay between batches - WEEK 1 CONSERVATIVE
  BATCH_DELAY: 1000,  // Conservative: 1 second between batches (was 2000)
  
  // UPDATED: Maximum concurrent API requests - WEEK 1 CONSERVATIVE
  MAX_CONCURRENT_REQUESTS: 2,  // Conservative: Only 2 concurrent (was 5)
  
  // NEW: Minimum request delay - WEEK 1 CONSERVATIVE
  MIN_REQUEST_DELAY: 200,  // 200ms minimum between requests
  
  // Minimum blocks required before showing data for each period
  MIN_BLOCKS_REQUIRED: {
    '24H': Math.floor((24 * 60 * 60) / 30),
    '7D': Math.floor((7 * 24 * 60 * 60) / 30),
    '30D': Math.floor((30 * 24 * 60 * 60) / 30),
    '90D': Math.floor((90 * 24 * 60 * 60) / 30),
    '1Y': Math.floor((365 * 24 * 60 * 60) / 30)
  },

  // ============================================================================
  // API ENDPOINTS - MATCHING FLUXTRACKER
  // ============================================================================
  
  // Flux Core APIs
  FLUX_BASE: 'https://api.runonflux.io',
  DAEMON: 'https://api.runonflux.io/daemon',
  
  // Blockbook endpoints for transaction data (will try in order if one fails)
  BLOCKBOOK_ENDPOINTS: [
    'https://blockbook.runonflux.io/api/v2'         // Primary

  ],
  
  // Current active blockbook endpoint (will be rotated on rate limits)
  BLOCKBOOK_API: 'https://blockbook.runonflux.io/api/v2',
  
  // Flux Nodes API
  FLUX_NODES_API: 'https://explorer.runonflux.io/api/status?q=getFluxNodes',
  
  // API Rate Limiting
  API_RETRY_ATTEMPTS: 3,
  API_RETRY_DELAY: 2000,  // 2 seconds between retries
  API_TIMEOUT: 30000,  // 30 second timeout
  RATE_LIMIT_RETRY_DELAY: 5000,  // 5 seconds delay after rate limit before rotating endpoint

  // ============================================================================
  // NODE OPERATOR CONFIGURATION
  // ============================================================================
  
  // How often to refresh the node operator list (in blocks)
  NODE_REFRESH_BLOCKS: 100,  // Refresh every 100 blocks (~50 minutes)
  
  // Node tier information
  NODE_TIERS: {
    CUMULUS: {
      collateral: 1000,
      cores: 2,
      ram: 8,
      storage: 220
    },
    NIMBUS: {
      collateral: 12500,
      cores: 4,
      ram: 32,
      storage: 440
    },
    STRATUS: {
      collateral: 40000,
      cores: 8,
      ram: 64,
      storage: 880
    }
  },

  // ============================================================================
  // DATA CLASSIFICATION
  // ============================================================================
  
  // Path to exchange configuration file
  EXCHANGES_CONFIG_PATH: './src/lib/data/exchanges.json',
  
  // Minimum transaction value to consider (in FLUX)
  MIN_TRANSACTION_VALUE: 1,  // Ignore dust transactions
  
  // ============================================================================
  // UI CONFIGURATION
  // ============================================================================
  
  // Default selected period on load
  DEFAULT_PERIOD: '24H',
  
  // Chart configuration
  CHART_MAX_POINTS: 100,  // Maximum data points to show on charts
  
  // Auto-refresh interval for frontend (milliseconds)
  FRONTEND_REFRESH_INTERVAL: 300000,  // 5 minutes
  
  // ============================================================================
  // LOGGING & DEBUGGING - WEEK 1 PERFORMANCE MONITORING
  // ============================================================================
  
  LOGGING: {
    ENABLE_DEBUG: false,  // Enable debug logging
    LOG_BLOCK_PROCESSING: true,  // Log each block processed
    LOG_API_CALLS: false,  // Log API requests
    LOG_CLASSIFICATION: false  // Log wallet classifications
  },
  
  // NEW: Performance monitoring for Week 1
  PERFORMANCE: {
    LOG_BATCH_TIMING: true,   // Log how long each batch takes
    LOG_FETCH_TIMING: true,   // Log fetch performance
    LOG_PROCESS_TIMING: true, // Log processing performance
    TARGET_BLOCKS_PER_MINUTE: 60  // Week 1 target: 60 blocks/minute
  }
};

// ============================================================================
// ENDPOINT ROTATION HELPER
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
// HELPER FUNCTIONS
// ============================================================================

// Helper functions for time calculations
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

// Get period in blocks
export function getPeriodBlocks(period) {
  return FLUX_CONFIG.PERIODS[period] || FLUX_CONFIG.PERIODS['24H'];
}

// Check if we have enough blocks for a period
export function hasEnoughBlocks(currentBlockCount, period) {
  const required = FLUX_CONFIG.MIN_BLOCKS_REQUIRED[period];
  return currentBlockCount >= required;
}

// ============================================================================
// API URL CONFIGURATION (for frontend)
// ============================================================================

/**
 * Get the API URL based on environment
 * IMPORTANT: Only call this in the browser (client-side), not during SSR!
 */
export function getApiUrl() {
  // Check if we're in the browser
  if (typeof window === 'undefined') {
    console.warn('⚠️ getApiUrl() called during SSR!');
    return '';
  }

  // Check for explicit environment variable override
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }

  const hostname = window.location.hostname;
  
  // Development: Call API directly on port 3000
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'http://localhost:3000';
  }
  
  // Production: Use same origin (proxy will handle it)
  return window.location.origin;
}