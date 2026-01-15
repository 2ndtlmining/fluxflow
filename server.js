// Server - UTXO-Aware Flow Tracker
import express from 'express';
import cors from 'cors';
import { FLUX_CONFIG } from './src/lib/config.js';
import { startBlockSyncScheduler, getBlockSyncSchedulerStatus } from './src/lib/services/Blocksyncscheduler.js';
import ClassificationService from './src/lib/services/classificationService.js';
import FlowAnalysisService from './src/lib/services/flowAnalysisService.js';

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration
const corsOptions = {
  origin: [
    'http://localhost:5173',
    'http://localhost:4173',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:4173',
  ],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// ============================================================================
// SERVICE INSTANCES
// ============================================================================

let blockSyncService = null;
let databaseService = null;
let flowAnalysisService = null;
const classificationService = new ClassificationService();

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initialize() {
  console.log('='.repeat(70));
  console.log('Flux Flow Tracker - UTXO-Aware Version');
  console.log('='.repeat(70));
  
  try {
    // Load classification data
    console.log('\n1. Loading classification data...');
    await classificationService.refreshNodeOperators();
    
    const stats = classificationService.getStats();
    console.log(`   ✓ Loaded ${stats.exchanges.count} exchanges`);
    console.log(`   ✓ Loaded ${stats.foundation.count} foundation addresses`);
    console.log(`   ✓ Loaded ${stats.nodeOperators.count} node operators (${stats.nodeOperators.totalNodes} total nodes)`);
    
    // Start block sync scheduler with database and classification
    console.log('\n2. Starting block sync scheduler with database...');
    const services = await startBlockSyncScheduler(classificationService);
    blockSyncService = services.blockSyncService;
    databaseService = services.databaseService;
    
    console.log('   ✓ Database service initialized:', !!databaseService);
    console.log('   ✓ Database connection:', !!databaseService?.db);
    
    // Create flow analysis service with initialized database
    console.log('\n3. Creating flow analysis service...');
    flowAnalysisService = new FlowAnalysisService(databaseService);
    console.log('   ✓ Flow analysis service created');
    console.log('   ✓ Has database reference:', !!flowAnalysisService.db);
    console.log('   ✓ Has database connection:', !!flowAnalysisService.db?.db);
    
    // Show database stats
    const dbStats = databaseService.getStats();
    console.log(`\n📊 Database Stats:`);
    console.log(`   Blocks: ${dbStats.blocks.toLocaleString()}`);
    console.log(`   Transactions: ${dbStats.transactions.toLocaleString()}`);
    console.log(`   Flow Events: ${dbStats.flowEvents.toLocaleString()}`);
    if (dbStats.flowStats.length > 0) {
      console.log(`   Flow Breakdown:`);
      dbStats.flowStats.forEach(stat => {
        console.log(`     ${stat.flow_type}: ${stat.count} events (${stat.total_amount.toFixed(2)} FLUX)`);
      });
    }
    console.log(`   Database size: ${dbStats.dbSize}`);
    
    console.log('\n' + '='.repeat(70));
    console.log('Server ready! Block sync running every 2 minutes.');
    console.log('UTXO-aware: Tracking individual outputs as flow events');
    console.log('='.repeat(70) + '\n');
    
  } catch (error) {
    console.error('\n✗ Initialization failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

// ============================================================================
// API ENDPOINTS - ALL DEFINED BEFORE app.listen()
// ============================================================================

// Health check
app.get('/api/health', (req, res) => {
  const dbStats = databaseService ? databaseService.getStats() : null;
  
  res.json({
    status: 'ok',
    database: {
      connected: !!databaseService,
      blocks: dbStats?.blocks || 0,
      transactions: dbStats?.transactions || 0,
      flowEvents: dbStats?.flowEvents || 0
    },
    sync: getBlockSyncSchedulerStatus()
  });
});

// Get block status - FIXED: Returns correct property names matching frontend
app.get('/api/blocks/status', (req, res) => {
  try {
    const syncStatus = getBlockSyncSchedulerStatus();
    const dbStats = databaseService ? databaseService.getStats() : null;
    
    res.json({
      currentBlockHeight: syncStatus.currentBlock || 0,
      blockCount: syncStatus.blockCount || 0,
      syncInProgress: syncStatus.syncInProgress || false,
      syncProgress: syncStatus.syncProgress || 0,
      lastSync: syncStatus.lastSync,
      transactionCount: databaseService ? databaseService.getTransactionCount() : 0,
      flowEventCount: dbStats?.flowEvents || 0,
      isAnalyzing: syncStatus.isInitialSync || false
    });
  } catch (error) {
    console.error('Error in /api/blocks/status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get classification stats - FIXED: Singular endpoint name /classification/stats
app.get('/api/classification/stats', (req, res) => {
  try {
    const stats = classificationService.getStats();
    res.json(stats);
  } catch (error) {
    console.error('Error in /api/classification/stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Also support plural version for backward compatibility
app.get('/api/classifications/stats', (req, res) => {
  try {
    const stats = classificationService.getStats();
    res.json(stats);
  } catch (error) {
    console.error('Error in /api/classifications/stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get flow analysis for a period
app.get('/api/flow/:period', (req, res) => {
  try {
    // Check if services are initialized
    if (!flowAnalysisService) {
      return res.status(503).json({ 
        error: 'Service not ready',
        message: 'Flow analysis service is still initializing. Please wait a moment and try again.'
      });
    }
    
    const period = req.params.period.toUpperCase();
    
    if (!FLUX_CONFIG.PERIODS[period]) {
      return res.status(400).json({ error: 'Invalid period' });
    }
    
    const syncStatus = getBlockSyncSchedulerStatus();
    const blockCount = syncStatus.blockCount || 0;
    
    // Calculate data completeness
    const requiredBlocks = FLUX_CONFIG.MIN_BLOCKS_REQUIRED[period];
    const hasAnyData = blockCount > 0;
    const isComplete = blockCount >= requiredBlocks;
    const progress = (blockCount / requiredBlocks * 100).toFixed(1);
    
    // Always try to analyze if we have ANY data
    if (!hasAnyData) {
      return res.json({
        period: period,
        ready: false,
        partial: false,
        message: 'No data available yet. Syncing blocks...',
        progress: 0,
        blocksNeeded: requiredBlocks,
        blocksSynced: 0
      });
    }
    
    // Get analysis with whatever data we have
    const analysis = flowAnalysisService.analyzeFlow(period);
    
    res.json({
      period: period,
      ready: isComplete,
      partial: !isComplete,
      partialWarning: !isComplete ? `Data is incomplete (${progress}% synced). Results may not be fully representative.` : null,
      progress: parseFloat(progress),
      blocksNeeded: requiredBlocks,
      blocksSynced: blockCount,
      syncInProgress: syncStatus.syncInProgress || false,
      ...analysis
    });
    
  } catch (error) {
    console.error('Flow analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get top buyers
app.get('/api/flow/:period/buyers', (req, res) => {
  try {
    if (!flowAnalysisService) {
      return res.status(503).json({ error: 'Service not ready' });
    }
    
    const period = req.params.period.toUpperCase();
    const limit = parseInt(req.query.limit) || 10;
    
    if (!FLUX_CONFIG.PERIODS[period]) {
      return res.status(400).json({ error: 'Invalid period' });
    }
    
    const buyers = flowAnalysisService.getTopBuyers(period, limit);
    res.json({ buyers });
    
  } catch (error) {
    console.error('Top buyers error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get top sellers
app.get('/api/flow/:period/sellers', (req, res) => {
  try {
    if (!flowAnalysisService) {
      return res.status(503).json({ error: 'Service not ready' });
    }
    
    const period = req.params.period.toUpperCase();
    const limit = parseInt(req.query.limit) || 10;
    
    if (!FLUX_CONFIG.PERIODS[period]) {
      return res.status(400).json({ error: 'Invalid period' });
    }
    
    const sellers = flowAnalysisService.getTopSellers(period, limit);
    res.json({ sellers });
    
  } catch (error) {
    console.error('Top sellers error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get database stats for frontend
app.get('/api/database/stats', (req, res) => {
  try {
    if (!databaseService) {
      return res.status(503).json({ error: 'Database not initialized' });
    }
    
    const stats = databaseService.getStats();
    const oneYearBlocks = FLUX_CONFIG.PERIODS['1Y'];
    const blockSpan = stats.blockRange.maxHeight - stats.blockRange.minHeight;
    const dataAge = (blockSpan / oneYearBlocks * 365).toFixed(1); // in days
    
    res.json({
      size: stats.dbSize,
      sizeBytes: stats.dbSizeBytes,
      blocks: stats.blocks,
      transactions: stats.transactions,
      flowEvents: stats.flowEvents,
      blockRange: stats.blockRange,
      dataSpan: blockSpan,
      dataAgeDays: parseFloat(dataAge),
      oneYearBlockTarget: oneYearBlocks,
      percentOfTarget: ((stats.blocks / oneYearBlocks) * 100).toFixed(1)
    });
  } catch (error) {
    console.error('Error in /api/database/stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, async () => {
  console.log(`\n🚀 Server listening on port ${PORT}`);
  await initialize();
});