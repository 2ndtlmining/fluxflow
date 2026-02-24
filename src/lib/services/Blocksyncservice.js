// Block Sync Service - PHASE 1B
// Updated to use Flux Indexer (192.168.10.65) as primary, Blockbook as fallback

import fetch from 'node-fetch';
import { FLUX_CONFIG, getIndexerUrl, getBlockbookUrl, switchToFallbackDataSource, getActiveDataSource } from '../config.js';

class BlockSyncService {
  constructor(databaseService) {
    this.db = databaseService;
    this.isSyncing = false;
    this.currentBlock = 0;
    this.targetBlock = 0;
    this.isInitialSync = true;
    
    // PHASE 1B: Track which data source we're using
    this.activeSource = getActiveDataSource();
    
    // PHASE 1B: Load source-specific settings
    this.loadSyncSettings();
    
    // Performance tracking
    this.stats = {
      totalBlocks: 0,
      totalTime: 0,
      avgBlocksPerMinute: 0,
      lastBatchBlocks: 0,
      lastBatchTime: 0
    };
    
    console.log('📌 BlockSyncService initialized with settings:');
    console.log(`   - Data source: ${this.activeSource}`);
    console.log(`   - Batch size: ${this.batchSize}`);
    console.log(`   - Concurrent requests: ${this.maxConcurrent}`);
    console.log(`   - Min request delay: ${this.minRequestDelay}ms`);
    console.log(`   - Batch delay: ${this.batchDelay}ms`);
    console.log(`   - Rate limiting: ${this.enableRateLimiting ? 'enabled' : 'disabled'}`);
  }

  /**
   * PHASE 1B: Load sync settings based on active data source
   */
  loadSyncSettings() {
    const settings = FLUX_CONFIG.SYNC_SETTINGS[this.activeSource];
    
    if (settings) {
      this.batchSize = settings.BATCH_SIZE;
      this.maxConcurrent = settings.MAX_CONCURRENT;
      this.minRequestDelay = settings.MIN_REQUEST_DELAY;
      this.batchDelay = settings.BATCH_DELAY;
      this.enableRateLimiting = settings.ENABLE_RATE_LIMITING;
      this.transactionFetchLimit = settings.TRANSACTION_FETCH_LIMIT;
    } else {
      // Fallback to legacy settings
      this.batchSize = FLUX_CONFIG.INITIAL_SYNC_BATCH_SIZE || 30;
      this.maxConcurrent = FLUX_CONFIG.MAX_CONCURRENT_REQUESTS || 2;
      this.minRequestDelay = FLUX_CONFIG.MIN_REQUEST_DELAY || 200;
      this.batchDelay = FLUX_CONFIG.BATCH_DELAY || 1000;
      this.enableRateLimiting = true;
      this.transactionFetchLimit = 20;
    }
    
    // Rate limiting state
    this.consecutiveErrors = 0;
    this.lastRequestTime = 0;
  }

  /**
   * PHASE 1B: Reload settings when data source changes
   */
  reloadSettings() {
    this.activeSource = getActiveDataSource();
    this.loadSyncSettings();
    
    console.log(`🔄 Reloaded settings for ${this.activeSource}:`);
    console.log(`   - Batch size: ${this.batchSize}`);
    console.log(`   - Concurrent: ${this.maxConcurrent}`);
    console.log(`   - Delay: ${this.minRequestDelay}ms`);
  }

  /**
   * PHASE 1B: Get current blockchain tip from active data source
   */
  async getCurrentHeight() {
    try {
      if (this.activeSource === 'FLUX_INDEXER') {
        // Flux Indexer: Try status endpoint first, fallback to latest blocks
        let url = getIndexerUrl('status');
        let response = await fetch(url, { timeout: 10000 });
        
        if (!response.ok) {
          // If status fails, try getting latest blocks
          console.log('   Status endpoint failed, trying latest blocks...');
          url = getIndexerUrl('latestBlocks');
          response = await fetch(url, { timeout: 10000 });
        }
        
        if (!response.ok) {
          throw new Error(`Indexer returned ${response.status}`);
        }
        
        const data = await response.json();
        
        // Flux Indexer status response format (nested structure)
        if (data.indexer && data.indexer.currentHeight) {
          return data.indexer.currentHeight;
        }
        if (data.indexer && data.indexer.chainHeight) {
          return data.indexer.chainHeight;
        }
        if (data.daemon && data.daemon.blocks) {
          return data.daemon.blocks;
        }
        
        // Fallback: Try direct properties
        if (data.height) return data.height;
        if (data.chainHeight) return data.chainHeight;
        if (data.blockHeight) return data.blockHeight;
        if (data.bestHeight) return data.bestHeight;
        if (data.currentHeight) return data.currentHeight;
        
        // If data is an array of blocks (from latest blocks endpoint)
        if (Array.isArray(data) && data.length > 0) {
          return data[0].height;
        }
        
        // If data has a blocks array (latest blocks endpoint format)
        if (data.blocks && Array.isArray(data.blocks) && data.blocks.length > 0) {
          return data.blocks[0].height;
        }
        
        console.error('Indexer response:', JSON.stringify(data).substring(0, 200));
        throw new Error('Could not determine height from Indexer response');
        
      } else {
        // Blockbook: Use root endpoint
        const url = `${FLUX_CONFIG.BLOCKBOOK_API}/`;
        const response = await fetch(url, { timeout: 10000 });
        
        if (!response.ok) {
          throw new Error(`Blockbook returned ${response.status}`);
        }
        
        const data = await response.json();
        return data.blockbook.bestHeight;
      }
    } catch (error) {
      console.error(`⚠️  ${this.activeSource} failed to get height: ${error.message}`);
      
      // Only try fallback once
      if (this.activeSource === 'FLUX_INDEXER') {
        this.activeSource = switchToFallbackDataSource();
        this.reloadSettings(); // PHASE 1B: Reload settings for new source
        return this.getCurrentHeight(); // Retry with fallback
      } else {
        throw error; // Both sources failed
      }
    }
  }

  /**
   * PHASE 1B: Fetch a block from active data source with fallback
   */
  async fetchBlock(height, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        // PHASE 1B: Smart delay - only if rate limiting is enabled
        if (this.enableRateLimiting) {
          const delay = this.minRequestDelay * Math.pow(2, this.consecutiveErrors);
          const timeSinceLastRequest = Date.now() - this.lastRequestTime;
          
          if (timeSinceLastRequest < delay) {
            await new Promise(resolve => setTimeout(resolve, delay - timeSinceLastRequest));
          }
        } else {
          // Flux Indexer: minimal delay only
          const timeSinceLastRequest = Date.now() - this.lastRequestTime;
          if (timeSinceLastRequest < this.minRequestDelay) {
            await new Promise(resolve => setTimeout(resolve, this.minRequestDelay - timeSinceLastRequest));
          }
        }
        
        this.lastRequestTime = Date.now();
        
        // PHASE 1B: Use appropriate endpoint based on active source
        let url, response, data;
        
        if (this.activeSource === 'FLUX_INDEXER') {
          url = getIndexerUrl('block', height.toString());
          response = await fetch(url, { 
            timeout: FLUX_CONFIG.API_TIMEOUT,
            signal: AbortSignal.timeout(FLUX_CONFIG.API_TIMEOUT)
          });
          
          if (!response.ok) {
            if (response.status === 429) {
              console.log(`⚠️  Flux Indexer rate limited (unusual!), backing off...`);
              this.consecutiveErrors++;
              await new Promise(resolve => setTimeout(resolve, 5000 * (attempt + 1)));
              continue;
            }
            throw new Error(`Indexer returned ${response.status}`);
          }
          
          data = await response.json();
          
          // PHASE 1B: Normalize Flux Indexer response
          // Indexer uses 'tx' (array of txids) + 'txDetails' (full transaction data)
          // We need to convert this to Blockbook format with txs array containing vin/vout
          
          if (!data.txs) {
            if (data.txDetails && Array.isArray(data.txDetails)) {
              // Indexer provides full tx details, but we need to fetch vin/vout separately
              // For now, convert txDetails to basic format
              data.txs = data.tx || [];
              
              // Note: Indexer doesn't include vin/vout in block response
              // We'll need to filter these during processing
            } else if (data.tx && Array.isArray(data.tx)) {
              // Just txid array, convert to basic format
              data.txs = data.tx.map(txid => ({
                txid: typeof txid === 'string' ? txid : txid,
                vin: [],
                vout: []
              }));
            } else {
              data.txs = [];
            }
          }
          
        } else {
          // Blockbook
          url = `${FLUX_CONFIG.BLOCKBOOK_API}/block/${height}`;
          response = await fetch(url, { 
            timeout: FLUX_CONFIG.API_TIMEOUT,
            signal: AbortSignal.timeout(FLUX_CONFIG.API_TIMEOUT)
          });
          
          if (!response.ok) {
            if (response.status === 429) {
              this.consecutiveErrors++;
              console.log(`⚠️  Blockbook rate limited on block ${height}, backing off...`);
              await new Promise(resolve => setTimeout(resolve, 5000 * (attempt + 1)));
              continue;
            }
            throw new Error(`Blockbook returned ${response.status}`);
          }
          
          data = await response.json();
        }
        
        // Success - reset error counter
        if (this.consecutiveErrors > 0) {
          this.consecutiveErrors--;
        }
        
        return data;
        
      } catch (error) {
        this.consecutiveErrors++;
        
        console.error(`❌ ${this.activeSource} failed on block ${height} (attempt ${attempt + 1}/${retries}): ${error.message}`);
        
        if (attempt === retries - 1) {
          // Last attempt failed, try switching data source
          console.log(`🔄 Switching data source after ${retries} failed attempts...`);
          this.activeSource = switchToFallbackDataSource();
          this.reloadSettings(); // PHASE 1B: Reload settings
          
          // One more try with fallback
          return this.fetchBlock(height, 1);
        }
        
        // Exponential backoff
        const backoffDelay = 1000 * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      }
    }
    
    return null;
  }

  /**
   * Initialize the service
   */
  async initialize() {
    console.log('🔄 Initializing BlockSyncService...');
    
    try {
      // PHASE 1B: Use new getCurrentHeight method
      this.currentBlock = await this.getCurrentHeight();
      
      console.log(`📊 Current blockchain height: ${this.currentBlock.toLocaleString()}`);
      console.log(`📊 Using data source: ${this.activeSource}`);
      
      const latestSynced = this.db.getLatestBlockHeight();
      console.log(`📊 Latest synced block: ${latestSynced.toLocaleString()}`);
      
      const sixMonthBlocks = FLUX_CONFIG.PERIODS['6M'];
      this.targetBlock = Math.max(this.currentBlock - sixMonthBlocks, 1);

      console.log(`📊 Target block (6 months back): ${this.targetBlock.toLocaleString()}`);

      const stats = this.db.getStats();
      console.log(`📊 Blocks in database: ${stats.blocks.toLocaleString()}`);

      this.isInitialSync = stats.blocks < sixMonthBlocks;
      
      console.log('✓ BlockSyncService initialized');
      
    } catch (error) {
      console.error('⚠️ BlockSyncService initialization error:', error.message);
    }
  }

  getStatus() {
    const latestSynced = this.db.getLatestBlockHeight();
    const stats = this.db.getStats();
    const sixMonthBlocks = FLUX_CONFIG.PERIODS['6M'];
    const syncProgress = Math.min(100, (stats.blocks / sixMonthBlocks) * 100);
    
    return {
      currentBlock: this.currentBlock,
      latestSynced: latestSynced,
      targetBlock: this.targetBlock,
      blockCount: stats.blocks,
      blocksToSync: Math.max(0, this.currentBlock - latestSynced),
      isInitialSync: this.isInitialSync,
      syncProgress: syncProgress,
      isSyncing: this.isSyncing,
      performance: this.stats,
      dataSource: this.activeSource  // PHASE 1B: Expose active source
    };
  }

  /**
   * PHASE 1B: Fetch full transaction details (needed for Flux Indexer)
   */
  async fetchTransaction(txid) {
    try {
      let url, response, data;
      
      if (this.activeSource === 'FLUX_INDEXER') {
        url = getIndexerUrl('transaction', txid);
        response = await fetch(url, { timeout: 10000 });
        
        if (!response.ok) {
          return null;
        }
        
        data = await response.json();
        
        // CRITICAL FIX: Flux Indexer transaction format differs from Blockbook
        // Normalize to Blockbook format with vin/vout arrays
        
        // Fix vout: Flux Indexer uses vout[].scriptPubKey.addresses instead of vout[].addresses
        if (data.vout && Array.isArray(data.vout)) {
          for (const output of data.vout) {
            // If addresses are nested in scriptPubKey, move them up
            if (!output.addresses && output.scriptPubKey && output.scriptPubKey.addresses) {
              output.addresses = output.scriptPubKey.addresses;
            }
          }
        }
        
        // If still no vin/vout, try alternative formats
        if (!data.vin || !data.vout) {
          if (data.inputs && Array.isArray(data.inputs)) {
            data.vin = data.inputs.map(input => ({
              addresses: input.address ? [input.address] : (input.addresses || []),
              value: input.value || input.valueSat || 0
            }));
          } else {
            data.vin = data.vin || [];
          }
          
          if (data.outputs && Array.isArray(data.outputs)) {
            data.vout = data.outputs.map((output, index) => ({
              addresses: output.address ? [output.address] : (output.addresses || []),
              value: output.value || output.valueSat || 0,
              n: output.n !== undefined ? output.n : index
            }));
          } else {
            data.vout = data.vout || [];
          }
        }
        
        return data;
        
      } else {
        // Blockbook
        url = `${FLUX_CONFIG.BLOCKBOOK_API}/tx/${txid}`;
        response = await fetch(url, { timeout: 10000 });
        
        if (!response.ok) {
          return null;
        }
        
        return await response.json();
      }
      
    } catch (error) {
      console.error(`Failed to fetch tx ${txid}: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch multiple blocks concurrently
   */
  async fetchBlocksConcurrent(heights) {
    const results = [];
    const chunks = [];
    
    // PHASE 1B: Use source-specific concurrent limit
    for (let i = 0; i < heights.length; i += this.maxConcurrent) {
      chunks.push(heights.slice(i, i + this.maxConcurrent));
    }
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      
      const promises = chunk.map(height => this.fetchBlock(height));
      const chunkResults = await Promise.all(promises);
      results.push(...chunkResults);
      
      // PHASE 1B: Use source-specific batch delay
      if (i < chunks.length - 1 && this.batchDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, this.batchDelay));
      }
    }
    
    const successCount = results.filter(r => r !== null).length;
    
    return results;
  }

  /**
   * Pre-filter transactions
   */
  isRelevantTransaction(tx, classifier) {
    if (!tx.vin || !tx.vout) return false;
    
    for (const input of tx.vin) {
      if (input.addresses && input.addresses.length > 0) {
        const classification = classifier.classifyAddress(input.addresses[0]);
        if (classification.type !== 'unknown') {
          return true;
        }
      }
    }
    
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

  async processTransaction(tx, blockHeight, blockTime, classifier) {
    if (!tx.vin || !tx.vout) {
      return [];
    }
    
    this.db.saveTransaction({
      txid: tx.txid,
      blockHeight,
      blockTime,
      vin: tx.vin,
      vout: tx.vout
    });
    
    const inputAddresses = [];
    for (const input of tx.vin) {
      if (input.addresses && input.addresses.length > 0) {
        inputAddresses.push(...input.addresses);
      }
    }
    
    const inputClassifications = inputAddresses.map(addr => 
      classifier.classifyAddress(addr)
    );
    
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

  async processBlock(blockData, classifier) {
    if (!blockData || (!blockData.txs && !blockData.tx)) {
      return { relevant: 0, total: 0, flowEvents: [] };
    }
    
    this.db.saveBlock({
      height: blockData.height,
      hash: blockData.hash,
      time: blockData.time,
      txCount: blockData.txCount || blockData.tx_count || blockData.tx?.length || blockData.txs?.length || 0,
      size: blockData.size
    });
    
    // PHASE 1B: Handle Flux Indexer format
    let transactions = blockData.txs || [];
    
    // OPTIMIZATION: Filter transactions by 'kind' BEFORE fetching full details
    // We only care about 'transfer' transactions, not 'coinbase' or 'fluxnode_confirm'
    if (this.activeSource === 'FLUX_INDEXER' && blockData.tx && Array.isArray(blockData.tx)) {
      // Use txDetails (summary data) to filter by 'kind' before fetching full transactions
      const txDetails = blockData.txDetails || [];
      
      // Filter to ONLY 'transfer' transactions (ignore coinbase, fluxnode_confirm, etc.)
      const relevantTxDetails = txDetails.filter(tx => tx.kind === 'transfer');
      
      if (relevantTxDetails.length > 0) {
        console.log(`  🎯 Filtered to ${relevantTxDetails.length} transfer txs (out of ${txDetails.length} total)`);
        
        // Fetch full details ONLY for relevant transactions
        const limit = Math.min(relevantTxDetails.length, this.transactionFetchLimit);
        const txPromises = relevantTxDetails.slice(0, limit).map(tx => this.fetchTransaction(tx.txid));
        const fullTxs = await Promise.all(txPromises);
        transactions = fullTxs.filter(tx => tx !== null);
      } else {
        // No relevant transactions in this block
        transactions = [];
      }
    }
    
    let relevantCount = 0;
    const allFlowEvents = [];
    
    // DEBUG: Log transaction processing
    if (transactions.length > 0) {
      console.log(`  📝 Processing ${transactions.length} transactions from block ${blockData.height}`);
    }
    
    for (const tx of transactions) {
      if (tx && this.isRelevantTransaction(tx, classifier)) {
        const flowEvents = await this.processTransaction(tx, blockData.height, blockData.time, classifier);
        if (flowEvents && flowEvents.length > 0) {
          allFlowEvents.push(...flowEvents);
          relevantCount++;
        }
      }
    }
    
    // DEBUG: Log if we found flow events
    if (allFlowEvents.length > 0) {
      console.log(`  ✅ Found ${allFlowEvents.length} flow events in ${relevantCount} transactions`);
    }
    
    return { 
      relevant: relevantCount, 
      total: blockData.txCount || blockData.tx_count || transactions.length,
      flowEvents: allFlowEvents
    };
  }

  async processBlocksBatch(blockDataArray, classifier) {
    let totalRelevant = 0;
    let totalTx = 0;
    const allFlowEvents = [];
    
    for (const blockData of blockDataArray) {
      if (blockData) {
        const result = await this.processBlock(blockData, classifier);
        totalRelevant += result.relevant;
        totalTx += result.total;
        allFlowEvents.push(...result.flowEvents);
      }
    }
    
    if (allFlowEvents.length > 0) {
      this.db.saveFlowEventsBatch(allFlowEvents);
    }
    
    return { relevant: totalRelevant, total: totalTx };
  }

  async syncLatest(classifier) {
    if (this.isSyncing) {
      return { synced: 0, transactions: 0 };
    }
    
    try {
      this.isSyncing = true;
      
      const batchStartTime = Date.now();
      
      // PHASE 1B: Get current height from active source
      this.currentBlock = await this.getCurrentHeight();
      
      let latestSynced = this.db.getLatestBlockHeight();
      
      if (latestSynced === 0) {
        latestSynced = this.currentBlock;
        console.log(`🏁 Starting from current block: ${this.currentBlock.toLocaleString()}`);
      }
      
      const stats = this.db.getStats();
      const sixMonthBlocks = FLUX_CONFIG.PERIODS['6M'];

      let synced = 0;
      let relevantTx = 0;
      const batchSize = this.batchSize; // Use source-specific batch size

      // Sync forward
      if (latestSynced < this.currentBlock) {
        const blocksToSync = this.currentBlock - latestSynced;
        const actualBatch = Math.min(batchSize, blocksToSync);
        const startHeight = latestSynced + 1;
        const endHeight = startHeight + actualBatch - 1;
        
        console.log(`⬆️  Syncing forward: blocks ${startHeight.toLocaleString()} to ${endHeight.toLocaleString()} (${actualBatch} blocks)`);
        console.log(`📡 Using: ${this.activeSource}`);
        
        const heights = [];
        for (let height = startHeight; height <= endHeight; height++) {
          heights.push(height);
        }
        
        const fetchStart = Date.now();
        const blockDataArray = await this.fetchBlocksConcurrent(heights);
        const fetchTime = Date.now() - fetchStart;
        
        console.log(`  ⏱️  Fetched in ${(fetchTime / 1000).toFixed(1)}s (${(fetchTime / actualBatch).toFixed(0)}ms/block)`);
        
        const processStart = Date.now();
        const result = await this.processBlocksBatch(blockDataArray, classifier);
        const processTime = Date.now() - processStart;
        
        synced = blockDataArray.filter(b => b !== null).length;
        relevantTx = result.relevant;
        
        console.log(`  ⏱️  Processed in ${(processTime / 1000).toFixed(1)}s`);
        console.log(`  📊 ${result.relevant} relevant txs out of ${result.total} total (${((result.relevant / result.total) * 100).toFixed(1)}%)`);
      }
      else if (stats.blocks < sixMonthBlocks && latestSynced > this.targetBlock) {
        const minBlock = this.db.db.prepare('SELECT MIN(height) as min FROM blocks').get();
        const oldestBlock = minBlock?.min || latestSynced;
        
        const startHeight = oldestBlock - 1;
        const endHeight = Math.max(this.targetBlock, startHeight - batchSize + 1);
        const actualBatch = startHeight - endHeight + 1;
        
        console.log(`⬇️  Syncing backwards: blocks ${startHeight.toLocaleString()} down to ${endHeight.toLocaleString()} (${actualBatch} blocks)`);
        console.log(`📡 Using: ${this.activeSource}`);
        
        const heights = [];
        for (let height = startHeight; height >= endHeight; height--) {
          heights.push(height);
        }
        
        const fetchStart = Date.now();
        const blockDataArray = await this.fetchBlocksConcurrent(heights);
        const fetchTime = Date.now() - fetchStart;
        
        console.log(`  ⏱️  Fetched in ${(fetchTime / 1000).toFixed(1)}s (${(fetchTime / actualBatch).toFixed(0)}ms/block)`);
        
        const processStart = Date.now();
        const result = await this.processBlocksBatch(blockDataArray, classifier);
        const processTime = Date.now() - processStart;
        
        synced = blockDataArray.filter(b => b !== null).length;
        relevantTx = result.relevant;
        
        console.log(`  ⏱️  Processed in ${(processTime / 1000).toFixed(1)}s`);
        console.log(`  📊 ${result.relevant} relevant txs out of ${result.total} total`);
      }
      
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
      
      const updatedStats = this.db.getStats();
      this.isInitialSync = updatedStats.blocks < sixMonthBlocks;
      
      return { synced, transactions: relevantTx };
      
    } catch (error) {
      console.error('❌ Sync error:', error);
      return { synced: 0, transactions: 0 };
    } finally {
      this.isSyncing = false;
    }
  }

  async syncBatch(classifier) {
    const stats = this.db.getStats();
    const sixMonthBlocks = FLUX_CONFIG.PERIODS['6M'];
    const complete = stats.blocks >= sixMonthBlocks;
    
    if (complete) {
      this.isInitialSync = false;
      return { synced: 0, complete: true };
    }
    
    const result = await this.syncLatest(classifier);
    return { synced: result.synced, complete: false };
  }
}

export default BlockSyncService;