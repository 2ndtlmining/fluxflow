/**
 * BLOCK SYNC SCHEDULER WITH DATABASE
 * 
 * Runs block sync every 2 minutes with persistent storage
 */

import BlockSyncService from './Blocksyncservice.js';
import DatabaseService from './databaseService.js';

const SYNC_INTERVAL_MS = 2 * 60 * 1000;  // 2 minutes

let intervalId = null;
let blockSyncService = null;
let databaseService = null;
let classificationService = null;
let isRunning = false;
let lastRun = null;

/**
 * Run a sync cycle
 */
async function runSyncCycle() {
  const now = new Date();
  console.log(`\n⏰ Block sync cycle at ${now.toLocaleTimeString()}`);
  
  if (isRunning) {
    console.log('⏸️ Previous sync still running, skipping...');
    return;
  }
  
  try {
    isRunning = true;
    
    // Step 1: Sync latest blocks (highest priority) - with transaction processing
    console.log('\n🔥 Step 1: Syncing latest blocks...');
    const latestResult = await blockSyncService.syncLatest(classificationService);
    
    if (latestResult.synced > 0) {
      console.log(`✓ Synced ${latestResult.synced} blocks, ${latestResult.transactions} transactions`);
    }
    
    // Step 2: Sync historical batch (if not complete) - with transaction processing
    const status = blockSyncService.getStatus();
    
    if (status.isInitialSync) {
      console.log(`\n📚 Step 2: Syncing historical batch (${status.syncProgress.toFixed(1)}% complete)...`);
      
      // Wait 2 seconds before historical sync (rate limiting)
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const result = await blockSyncService.syncBatch(classificationService);
      
      if (result.complete) {
        console.log('\n🎉 Historical sync complete! Now have 1 year of data.');
      }
    } else {
      console.log('\n✓ Historical sync already complete');
    }
    
    lastRun = Date.now();
    console.log('\n✅ Sync cycle completed\n');
    
  } catch (error) {
    console.error('❌ Sync cycle failed:', error.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Initialize and start the scheduler
 */
export async function startBlockSyncScheduler(classifier) {
  if (intervalId) {
    console.warn('⚠️ Block sync scheduler already running');
    return { blockSyncService, databaseService };
  }
  
  // Store classifier for use in sync cycles
  classificationService = classifier;
  
  console.log('🚀 Initializing database and block sync service...');
  
  // Create database service
  databaseService = new DatabaseService('./data/flux-flow.db');
  
  // Create block sync service
  blockSyncService = new BlockSyncService(databaseService);
  
  // Initialize (non-fatal - will use cached data if API fails)
  try {
    await blockSyncService.initialize();
  } catch (error) {
    console.warn('⚠️ Initialization had issues, but continuing with saved state');
  }
  
  console.log('\n⏰ Starting block sync scheduler...');
  console.log(`   Sync interval: ${SYNC_INTERVAL_MS / 1000 / 60} minutes`);
  console.log(`   Blocks per batch: 10`);
  console.log(`   Batch delay: 2 seconds`);
  console.log(`   Delay between blocks: 500ms`);
  
  // Run first cycle immediately
  runSyncCycle();
  
  // Then run every 2 minutes
  intervalId = setInterval(() => runSyncCycle(), SYNC_INTERVAL_MS);
  
  console.log('✅ Block sync scheduler started\n');
  
  return { blockSyncService, databaseService };
}

/**
 * Stop the scheduler
 */
export function stopBlockSyncScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('🛑 Block sync scheduler stopped');
  }
  
  if (databaseService) {
    databaseService.close();
  }
}

/**
 * Get scheduler status
 */
export function getBlockSyncSchedulerStatus() {
  if (!blockSyncService) {
    return { 
      running: false,
      currentBlock: 0,
      blockCount: 0,
      syncInProgress: false,
      syncProgress: 0,
      isInitialSync: true
    };
  }
  
  const status = blockSyncService.getStatus();
  
  return {
    running: !!intervalId,
    syncInProgress: isRunning,
    lastRun,
    ...status
  };
}

/**
 * Get service instances
 */
export function getServices() {
  return { blockSyncService, databaseService };
}