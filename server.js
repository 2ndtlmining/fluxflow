// Server - UTXO-Aware Flow Tracker - PHASE 4
// Added background enhancement service and auto-enhancement

import express from 'express';
import cors from 'cors';
import { FLUX_CONFIG } from './src/lib/config.js';
import { startBlockSyncScheduler, getBlockSyncSchedulerStatus } from './src/lib/services/Blocksyncscheduler.js';
import ClassificationService from './src/lib/services/classificationService.js';
import FlowAnalysisService from './src/lib/services/flowAnalysisService.js';
import WalletEnhancementService from './src/lib/services/walletEnhancementService.js';
import BackgroundEnhancementService from './src/lib/services/backgroundenhancementservice.js'; // PHASE 4

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
let walletEnhancementService = null;
let backgroundEnhancementService = null; // PHASE 4
const classificationService = new ClassificationService();

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initialize() {
  console.log('='.repeat(70));
  console.log('Flux Flow Tracker - Phase 4: Auto-Enhancement');
  console.log('='.repeat(70));
  
  try {
    // Load classification data
    console.log('\n1️⃣ Loading classification data...');
    await classificationService.refreshNodeOperators();
    
    const stats = classificationService.getStats();
    console.log(`   ✓ Loaded ${stats.exchanges.count} exchanges`);
    console.log(`   ✓ Loaded ${stats.foundation.count} foundation addresses`);
    console.log(`   ✓ Loaded ${stats.nodeOperators.count} node operators (${stats.nodeOperators.totalNodes} total nodes)`);
    
    // Start block sync scheduler with database and classification
    console.log('\n2️⃣ Starting block sync scheduler with database...');
    const services = await startBlockSyncScheduler(classificationService);
    blockSyncService = services.blockSyncService;
    databaseService = services.databaseService;
    
    console.log('   ✓ Database service initialized:', !!databaseService);
    console.log('   ✓ Database connection:', !!databaseService?.db);
    
    // Create flow analysis service with initialized database
    console.log('\n3️⃣ Creating flow analysis service...');
    flowAnalysisService = new FlowAnalysisService(databaseService);
    console.log('   ✓ Flow analysis service created');
    console.log('   ✓ Has database reference:', !!flowAnalysisService.db);
    console.log('   ✓ Has database connection:', !!flowAnalysisService.db?.db);
    
    // PHASE 3: Create wallet enhancement service
    console.log('\n4️⃣ Creating wallet enhancement service (Phase 3 - Multi-hop)...');
    walletEnhancementService = new WalletEnhancementService(databaseService, classificationService);
    console.log('   ✓ Wallet enhancement service created');
    
    // PHASE 4: Create background enhancement service
    console.log('\n5️⃣ Creating background enhancement service (Phase 4)...');
    backgroundEnhancementService = new BackgroundEnhancementService(databaseService, walletEnhancementService);
    console.log('   ✓ Background enhancement service created');
    
    // PHASE 4: Start background enhancement job
    if (FLUX_CONFIG.ENHANCEMENT.BACKGROUND_JOB.ENABLED) {
      console.log('\n6️⃣ Starting background enhancement job...');
      backgroundEnhancementService.start();
      console.log('   ✓ Background enhancement started');
    } else {
      console.log('\n6️⃣ Background enhancement disabled in config');
    }
    
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
    if (dbStats.enhancementStats && dbStats.enhancementStats.length > 0) {
      console.log(`   Enhancement Stats:`);
      dbStats.enhancementStats.forEach(stat => {
        console.log(`     Level ${stat.classification_level}: ${stat.count} events`);
      });
    }
    console.log(`   Database size: ${dbStats.dbSize}`);
    
    console.log('\n' + '='.repeat(70));
    console.log('Server ready! Block sync running every 2 minutes.');
    console.log('Background enhancement running every ' + FLUX_CONFIG.ENHANCEMENT.BACKGROUND_JOB.INTERVAL_MINUTES + ' minutes.');
    console.log('UTXO-aware: Tracking individual outputs as flow events');
    console.log('Multi-hop detection: Up to ' + FLUX_CONFIG.ENHANCEMENT.MULTI_HOP.DEFAULT_DEPTH + '-hop chains');
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
  const bgStatus = backgroundEnhancementService ? backgroundEnhancementService.getStatus() : null;
  
  res.json({
    status: 'ok',
    database: {
      connected: !!databaseService,
      blocks: dbStats?.blocks || 0,
      transactions: dbStats?.transactions || 0,
      flowEvents: dbStats?.flowEvents || 0
    },
    sync: getBlockSyncSchedulerStatus(),
    backgroundEnhancement: bgStatus
  });
});

// Get block status
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

// Get classification stats
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
    
    const requiredBlocks = FLUX_CONFIG.MIN_BLOCKS_REQUIRED[period];
    const hasAnyData = blockCount > 0;
    const isComplete = blockCount >= requiredBlocks;
    const progress = (blockCount / requiredBlocks * 100).toFixed(1);
    
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
    const dataAge = (blockSpan / oneYearBlocks * 365).toFixed(1);
    
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
// PHASE 2/3: WALLET ENHANCEMENT ENDPOINTS
// ============================================================================

// Enhance unknown wallets - trigger multi-hop analysis
app.post('/api/enhance-wallets', async (req, res) => {
  try {
    if (!walletEnhancementService) {
      return res.status(503).json({ 
        error: 'Service not ready',
        message: 'Wallet enhancement service is still initializing'
      });
    }
    
    if (walletEnhancementService.isEnhancementRunning()) {
      return res.status(409).json({
        success: false,
        message: 'Enhancement already in progress'
      });
    }

    console.log('\n🔍 API: Starting wallet enhancement...');
    
    const result = await walletEnhancementService.enhanceUnknownWallets();

    console.log('✅ API: Enhancement complete\n');

    res.json({
      success: true,
      message: 'Wallet enhancement completed',
      stats: result.stats
    });

  } catch (error) {
    console.error('❌ Enhancement API error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Get enhancement status
app.get('/api/enhance-wallets/status', (req, res) => {
  try {
    if (!walletEnhancementService) {
      return res.json({
        isRunning: false,
        stats: { totalAnalyzed: 0, enhanced: { level1: 0, level2: 0, level3: 0 }, enhancedToBuying: 0, enhancedToSelling: 0, remainedUnknown: 0, errors: 0 }
      });
    }
    
    res.json({
      isRunning: walletEnhancementService.isEnhancementRunning(),
      stats: walletEnhancementService.getStats()
    });
  } catch (error) {
    console.error('Enhancement status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get unknown wallet statistics
app.get('/api/unknowns/stats', (req, res) => {
  try {
    if (!databaseService) {
      return res.status(503).json({ error: 'Database not ready' });
    }
    
    const unknowns = databaseService.getUnknownWallets();
    const stats = databaseService.getStats();
    
    res.json({
      unknownBuys: unknowns.buys.length,
      unknownSells: unknowns.sells.length,
      totalUnknowns: unknowns.total,
      enhancementStats: stats.enhancementStats || [],
      totalFlowEvents: stats.flowEvents
    });
    
  } catch (error) {
    console.error('Unknown stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// PHASE 4: BACKGROUND ENHANCEMENT ENDPOINTS
// ============================================================================

// Get background enhancement status
app.get('/api/enhancement/background/status', (req, res) => {
  try {
    if (!backgroundEnhancementService) {
      return res.json({
        enabled: false,
        isRunning: false,
        message: 'Background enhancement service not initialized'
      });
    }
    
    const status = backgroundEnhancementService.getStatus();
    res.json(status);
    
  } catch (error) {
    console.error('Background enhancement status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Manually trigger background enhancement
app.post('/api/enhancement/background/trigger', async (req, res) => {
  try {
    if (!backgroundEnhancementService) {
      return res.status(503).json({ 
        error: 'Service not ready',
        message: 'Background enhancement service not initialized'
      });
    }
    
    const result = await backgroundEnhancementService.triggerManualRun();
    res.json(result);
    
  } catch (error) {
    console.error('Manual trigger error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start background enhancement
app.post('/api/enhancement/background/start', (req, res) => {
  try {
    if (!backgroundEnhancementService) {
      return res.status(503).json({ error: 'Service not initialized' });
    }
    
    backgroundEnhancementService.start();
    res.json({ success: true, message: 'Background enhancement started' });
    
  } catch (error) {
    console.error('Start background enhancement error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stop background enhancement
app.post('/api/enhancement/background/stop', (req, res) => {
  try {
    if (!backgroundEnhancementService) {
      return res.status(503).json({ error: 'Service not initialized' });
    }
    
    backgroundEnhancementService.stop();
    res.json({ success: true, message: 'Background enhancement stopped' });
    
  } catch (error) {
    console.error('Stop background enhancement error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// START SERVER & GRACEFUL SHUTDOWN
// ============================================================================

app.listen(PORT, async () => {
  console.log(`\n🚀 Server listening on port ${PORT}`);
  await initialize();
});

// PHASE 4: Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n📛 SIGTERM received: closing HTTP server');
  
  if (backgroundEnhancementService) {
    backgroundEnhancementService.stop();
  }
  
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n📛 SIGINT received: closing HTTP server');
  
  if (backgroundEnhancementService) {
    backgroundEnhancementService.stop();
  }
  
  process.exit(0);
});