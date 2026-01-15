// Block Sync Service - WEEK 1 CONSERVATIVE APPROACH
// Optimized with concurrent fetching, transaction filtering, and batch inserts
// Conservative settings: 2 concurrent, 30 blocks/batch, transaction pre-filtering

import fetch from 'node-fetch';
import { FLUX_CONFIG } from '../config.js';

class BlockSyncService {
  constructor(databaseService) {
    this.db = databaseService;
    this.isSyncing = false;
    this.currentBlock = 0;
    this.targetBlock = 0;
    this.isInitialSync = true;
    
    // Rate limiting - CONSERVATIVE WEEK 1 SETTINGS
    this.consecutiveErrors = 0;
    this.lastRequestTime = 0;
    this.minRequestDelay = FLUX_CONFIG.MIN_REQUEST_DELAY || 200;
    this.maxConcurrent = FLUX_CONFIG.MAX_CONCURRENT_REQUESTS || 2;
    
    // Performance tracking
    this.stats = {
      totalBlocks: 0,
      totalTime: 0,
      avgBlocksPerMinute: 0,
      lastBatchBlocks: 0,
      lastBatchTime: 0
    };
    
    console.log('📌 BlockSyncService initialized with settings:');
    console.log(`   - Concurrent requests: ${this.maxConcurrent}`);
    console.log(`   - Min request delay: ${this.minRequestDelay}ms`);
    console.log(`   - Batch size: ${FLUX_CONFIG.INITIAL_SYNC_BATCH_SIZE}`);
  }

  /**
   * Initialize the service
   */
  async initialize() {
    console.log('🔄 Initializing BlockSyncService...');
    
    try {
      const tipResponse = await fetch(`${FLUX_CONFIG.BLOCKBOOK_API}/`);
      const tipData = await tipResponse.json();
      this.currentBlock = tipData.blockbook.bestHeight;
      
      console.log(`📊 Current blockchain height: ${this.currentBlock.toLocaleString()}`);
      
      const latestSynced = this.db.getLatestBlockHeight();
      console.log(`📊 Latest synced block: ${latestSynced.toLocaleString()}`);
      
      const oneYearBlocks = FLUX_CONFIG.PERIODS['1Y'];
      this.targetBlock = Math.max(this.currentBlock - oneYearBlocks, 1);
      
      console.log(`📊 Target block (1 year back): ${this.targetBlock.toLocaleString()}`);
      
      const stats = this.db.getStats();
      console.log(`📊 Blocks in database: ${stats.blocks.toLocaleString()}`);
      
      this.isInitialSync = stats.blocks < oneYearBlocks;
      
      console.log('✓ BlockSyncService initialized');
      
    } catch (error) {
      console.error('⚠️ BlockSyncService initialization error:', error.message);
    }
  }

  /**
   * Get service status
   */
  getStatus() {
    const latestSynced = this.db.getLatestBlockHeight();
    const stats = this.db.getStats();
    const oneYearBlocks = FLUX_CONFIG.PERIODS['1Y'];
    const syncProgress = Math.min(100, (stats.blocks / oneYearBlocks) * 100);
    
    return {
      currentBlock: this.currentBlock,
      latestSynced: latestSynced,
      targetBlock: this.targetBlock,
      blockCount: stats.blocks,
      blocksToSync: Math.max(0, this.currentBlock - latestSynced),
      isInitialSync: this.isInitialSync,
      syncProgress: syncProgress,
      isSyncing: this.isSyncing,
      performance: this.stats
    };
  }

  /**
   * Fetch a block with retry and smart rate limiting
   */
  async fetchBlock(height, retries = 3) {
    const url = `${FLUX_CONFIG.BLOCKBOOK_API}/block/${height}`;
    
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        // Smart delay based on consecutive errors (exponential backoff)
        const delay = this.minRequestDelay * Math.pow(2, this.consecutiveErrors);
        const timeSinceLastRequest = Date.now() - this.lastRequestTime;
        
        if (timeSinceLastRequest < delay) {
          await new Promise(resolve => setTimeout(resolve, delay - timeSinceLastRequest));
        }
        
        this.lastRequestTime = Date.now();
        
        const response = await fetch(url, { 
          timeout: FLUX_CONFIG.API_TIMEOUT,
          signal: AbortSignal.timeout(FLUX_CONFIG.API_TIMEOUT)
        });
        
        if (!response.ok) {
          if (response.status === 429) {
            this.consecutiveErrors++;
            console.log(`⚠️ Rate limited on block ${height}, backing off... (delay now: ${delay * 2}ms)`);
            await new Promise(resolve => setTimeout(resolve, 5000 * (attempt + 1)));
            continue;
          }
          throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        // Success - gradually reduce error counter
        if (this.consecutiveErrors > 0) {
          this.consecutiveErrors--;
        }
        
        return data;
        
      } catch (error) {
        this.consecutiveErrors++;
        
        if (attempt === retries - 1) {
          console.error(`❌ Failed to fetch block ${height} after ${retries} attempts:`, error.message);
          return null;
        }
        
        // Exponential backoff
        const backoffDelay = 1000 * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      }
    }
    
    return null;
  }

  /**
   * Fetch multiple blocks concurrently (controlled batches)
   */
  async fetchBlocksConcurrent(heights) {
    const results = [];
    const chunks = [];
    
    // Split into small chunks based on maxConcurrent
    for (let i = 0; i < heights.length; i += this.maxConcurrent) {
      chunks.push(heights.slice(i, i + this.maxConcurrent));
    }
    
    // Process each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      
      // Fetch this chunk concurrently
      const promises = chunk.map(height => this.fetchBlock(height));
      const chunkResults = await Promise.all(promises);
      results.push(...chunkResults);
      
      // Small delay between chunks (except last one)
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    
    const successCount = results.filter(r => r !== null).length;
    
    return results;
  }

  /**
   * Pre-filter transactions - only process if they involve known addresses
   * This is a HUGE performance boost - skips ~98% of transactions
   */
  isRelevantTransaction(tx, classifier) {
    if (!tx.vin || !tx.vout) return false;
    
    // Quick check inputs
    for (const input of tx.vin) {
      if (input.addresses && input.addresses.length > 0) {
        const classification = classifier.classifyAddress(input.addresses[0]);
        if (classification.type !== 'unknown') {
          return true;
        }
      }
    }
    
    // Quick check outputs
    for (const output of tx.vout) {
      if (output.addresses && output.addresses.length > 0) {
        const classification = classifier.classifyAddress(output.addresses[0]);
        if (classification.type !== 'unknown') {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * Classify a flow event based on from/to addresses
   */
  classifyFlow(fromType, toType) {
    const fromIsExchange = fromType === 'exchange';
    const toIsExchange = toType === 'exchange';
    
    if (toIsExchange && !fromIsExchange) {
      return 'selling';
    } else if (fromIsExchange && !toIsExchange) {
      return 'buying';
    } else {
      return 'p2p';
    }
  }

  /**
   * Process a single transaction and return flow events
   */
  async processTransaction(tx, blockHeight, blockTime, classifier) {
    if (!tx.vin || !tx.vout) {
      return [];
    }
    
    // Save transaction
    this.db.saveTransaction({
      txid: tx.txid,
      blockHeight,
      blockTime,
      vin: tx.vin,
      vout: tx.vout
    });
    
    // Get input classifications
    const inputAddresses = [];
    for (const input of tx.vin) {
      if (input.addresses && input.addresses.length > 0) {
        inputAddresses.push(...input.addresses);
      }
    }
    
    const inputClassifications = inputAddresses.map(addr => 
      classifier.classifyAddress(addr)
    );
    
    // Determine primary input type
    let primaryInputType = 'unknown';
    let primaryInputDetails = null;
    let primaryInputAddress = inputAddresses[0] || 'unknown';
    
    const exchangeInput = inputClassifications.find(c => c.type === 'exchange');
    if (exchangeInput) {
      primaryInputType = 'exchange';
      primaryInputDetails = { name: exchangeInput.name, logo: exchangeInput.logo };
      primaryInputAddress = exchangeInput.address;
    } else {
      const nodeOpInput = inputClassifications.find(c => c.type === 'node_operator');
      if (nodeOpInput) {
        primaryInputType = 'node_operator';
        primaryInputDetails = { nodeCount: nodeOpInput.nodeCount, tiers: nodeOpInput.tiers };
        primaryInputAddress = nodeOpInput.address;
      } else {
        const foundationInput = inputClassifications.find(c => c.type === 'foundation');
        if (foundationInput) {
          primaryInputType = 'foundation';
          primaryInputDetails = { name: foundationInput.name };
          primaryInputAddress = foundationInput.address;
        }
      }
    }
    
    // Process each output and build flow events
    const flowEvents = [];
    
    for (let vout = 0; vout < tx.vout.length; vout++) {
      const output = tx.vout[vout];
      
      if (!output.addresses || output.addresses.length === 0) {
        continue;
      }
      
      const outputAddress = output.addresses[0];
      const outputClassification = classifier.classifyAddress(outputAddress);
      const flowType = this.classifyFlow(primaryInputType, outputClassification.type);
      
      flowEvents.push({
        txid: tx.txid,
        vout: vout,
        blockHeight: blockHeight,
        blockTime: blockTime,
        fromAddress: primaryInputAddress,
        fromType: primaryInputType,
        fromDetails: primaryInputDetails,
        toAddress: outputAddress,
        toType: outputClassification.type,
        toDetails: outputClassification.type === 'exchange' 
          ? { name: outputClassification.name, logo: outputClassification.logo }
          : outputClassification.type === 'node_operator'
          ? { nodeCount: outputClassification.nodeCount, tiers: outputClassification.tiers }
          : outputClassification.type === 'foundation'
          ? { name: outputClassification.name }
          : null,
        flowType: flowType,
        amount: parseFloat(output.value) / 100000000
      });
    }
    
    return flowEvents;
  }

  /**
   * Process a single block
   */
  async processBlock(blockData, classifier) {
    if (!blockData || !blockData.txs) {
      return { relevant: 0, total: 0, flowEvents: [] };
    }
    
    // Save block
    this.db.saveBlock({
      height: blockData.height,
      hash: blockData.hash,
      time: blockData.time,
      txCount: blockData.txs.length,
      size: blockData.size
    });
    
    let relevantCount = 0;
    const allFlowEvents = [];
    
    // Filter and process only relevant transactions
    for (const tx of blockData.txs) {
      if (this.isRelevantTransaction(tx, classifier)) {
        const flowEvents = await this.processTransaction(tx, blockData.height, blockData.time, classifier);
        if (flowEvents && flowEvents.length > 0) {
          allFlowEvents.push(...flowEvents);
          relevantCount++;
        }
      }
    }
    
    return { 
      relevant: relevantCount, 
      total: blockData.txs.length,
      flowEvents: allFlowEvents
    };
  }

  /**
   * Process multiple blocks and do BATCH INSERT (prevents DB locks)
   */
  async processBlocksBatch(blockDataArray, classifier) {
    let totalRelevant = 0;
    let totalTx = 0;
    const allFlowEvents = [];
    
    // Process each block and collect ALL flow events
    for (const blockData of blockDataArray) {
      if (blockData) {
        const result = await this.processBlock(blockData, classifier);
        totalRelevant += result.relevant;
        totalTx += result.total;
        allFlowEvents.push(...result.flowEvents);
      }
    }
    
    // CRITICAL: Single batch insert for ALL flow events
    // This prevents DB locks by doing ONE transaction instead of hundreds
    if (allFlowEvents.length > 0) {
      this.db.saveFlowEventsBatch(allFlowEvents);
    }
    
    return { relevant: totalRelevant, total: totalTx };
  }

  /**
   * Main sync method - processes batches with concurrent fetching
   */
  async syncLatest(classifier) {
    if (this.isSyncing) {
      return { synced: 0, transactions: 0 };
    }
    
    try {
      this.isSyncing = true;
      
      const batchStartTime = Date.now();
      
      // Update blockchain tip
      const tipResponse = await fetch(`${FLUX_CONFIG.BLOCKBOOK_API}/`);
      const tipData = await tipResponse.json();
      this.currentBlock = tipData.blockbook.bestHeight;
      
      let latestSynced = this.db.getLatestBlockHeight();
      
      if (latestSynced === 0) {
        latestSynced = this.currentBlock;
        console.log(`🏁 Starting from current block: ${this.currentBlock.toLocaleString()}`);
      }
      
      const stats = this.db.getStats();
      const oneYearBlocks = FLUX_CONFIG.PERIODS['1Y'];
      
      let synced = 0;
      let relevantTx = 0;
      const batchSize = FLUX_CONFIG.INITIAL_SYNC_BATCH_SIZE || 30;
      
      // Sync forward (catching up to current)
      if (latestSynced < this.currentBlock) {
        const blocksToSync = this.currentBlock - latestSynced;
        const actualBatch = Math.min(batchSize, blocksToSync);
        const startHeight = latestSynced + 1;
        const endHeight = startHeight + actualBatch - 1;
        
        console.log(`⬆️ Syncing forward: blocks ${startHeight.toLocaleString()} to ${endHeight.toLocaleString()} (${actualBatch} blocks)`);
        
        // Build array of heights to fetch
        const heights = [];
        for (let height = startHeight; height <= endHeight; height++) {
          heights.push(height);
        }
        
        // Fetch all blocks concurrently
        const fetchStart = Date.now();
        const blockDataArray = await this.fetchBlocksConcurrent(heights);
        const fetchTime = Date.now() - fetchStart;
        
        console.log(`  ⏱️  Fetched in ${(fetchTime / 1000).toFixed(1)}s (${(fetchTime / actualBatch).toFixed(0)}ms/block)`);
        
        // Process blocks with batch insert
        const processStart = Date.now();
        const result = await this.processBlocksBatch(blockDataArray, classifier);
        const processTime = Date.now() - processStart;
        
        synced = blockDataArray.filter(b => b !== null).length;
        relevantTx = result.relevant;
        
        console.log(`  ⏱️  Processed in ${(processTime / 1000).toFixed(1)}s`);
        console.log(`  📊 ${result.relevant} relevant txs out of ${result.total} total (${((result.relevant / result.total) * 100).toFixed(1)}%)`);
      }
      // Sync backwards (filling historical data)
      else if (stats.blocks < oneYearBlocks && latestSynced > this.targetBlock) {
        const minBlock = this.db.db.prepare('SELECT MIN(height) as min FROM blocks').get();
        const oldestBlock = minBlock?.min || latestSynced;
        
        const startHeight = oldestBlock - 1;
        const endHeight = Math.max(this.targetBlock, startHeight - batchSize + 1);
        const actualBatch = startHeight - endHeight + 1;
        
        console.log(`⬇️ Syncing backwards: blocks ${startHeight.toLocaleString()} down to ${endHeight.toLocaleString()} (${actualBatch} blocks)`);
        
        // Build array of heights to fetch (in descending order)
        const heights = [];
        for (let height = startHeight; height >= endHeight; height--) {
          heights.push(height);
        }
        
        // Fetch all blocks concurrently
        const fetchStart = Date.now();
        const blockDataArray = await this.fetchBlocksConcurrent(heights);
        const fetchTime = Date.now() - fetchStart;
        
        console.log(`  ⏱️  Fetched in ${(fetchTime / 1000).toFixed(1)}s (${(fetchTime / actualBatch).toFixed(0)}ms/block)`);
        
        // Process blocks with batch insert
        const processStart = Date.now();
        const result = await this.processBlocksBatch(blockDataArray, classifier);
        const processTime = Date.now() - processStart;
        
        synced = blockDataArray.filter(b => b !== null).length;
        relevantTx = result.relevant;
        
        console.log(`  ⏱️  Processed in ${(processTime / 1000).toFixed(1)}s`);
        console.log(`  📊 ${result.relevant} relevant txs out of ${result.total} total`);
      }
      
      // Update performance stats
      const batchTime = Date.now() - batchStartTime;
      this.stats.totalBlocks += synced;
      this.stats.totalTime += batchTime;
      this.stats.lastBatchBlocks = synced;
      this.stats.lastBatchTime = batchTime;
      
      if (this.stats.totalTime > 0) {
        this.stats.avgBlocksPerMinute = (this.stats.totalBlocks / (this.stats.totalTime / 1000 / 60)).toFixed(1);
      }
      
      console.log(`  📈 Performance: ${this.stats.avgBlocksPerMinute} blocks/min average`);
      console.log(`  🎯 Error counter: ${this.consecutiveErrors}`);
      
      // Update sync status
      const updatedStats = this.db.getStats();
      this.isInitialSync = updatedStats.blocks < oneYearBlocks;
      
      return { synced, transactions: relevantTx };
      
    } catch (error) {
      console.error('❌ Sync error:', error);
      return { synced: 0, transactions: 0 };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Sync batch - calls syncLatest
   */
  async syncBatch(classifier) {
    const stats = this.db.getStats();
    const oneYearBlocks = FLUX_CONFIG.PERIODS['1Y'];
    const complete = stats.blocks >= oneYearBlocks;
    
    if (complete) {
      this.isInitialSync = false;
      return { synced: 0, complete: true };
    }
    
    const result = await this.syncLatest(classifier);
    return { synced: result.synced, complete: false };
  }
}

export default BlockSyncService;