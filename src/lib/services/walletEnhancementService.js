// Wallet Enhancement Service - PHASE 7.2: Parallel Processing
// 2-4x faster through concurrent batch processing of unknowns
// Maintains all Phase 7.1 caching with parallel execution

import fetch from 'node-fetch';
import { FLUX_CONFIG } from '../config.js';
import EnhancementCache from './enhancementCache.js';

class WalletEnhancementService {
  constructor(databaseService, classificationService) {
    this.db = databaseService;
    this.classifier = classificationService;
    this.isEnhancing = false;
    
    // PHASE 6.1: Initialize cache
    this.cache = new EnhancementCache();
    
    this.stats = {
      totalAnalyzed: 0,
      enhanced: {
        level1: 0,  // 1-hop
        level2: 0,  // 2-hop
        level3: 0   // 3-hop
      },
      historical: {
        level0: 0,  // Direct historical (coinbase)
        level1: 0,  // 1-hop historical (coinbase)
        level2: 0,  // 2-hop historical (coinbase)
        level3: 0   // 3-hop historical (coinbase)
      },
      historicalConnection: {
        level0: 0   // Direct historical connection (sent to node operator)
      },
      enhancedToBuying: 0,
      enhancedToSelling: 0,
      remainedUnknown: 0,
      errors: 0,
      circularDetections: 0
    };
    
    console.log('🔍 WalletEnhancementService initialized (Phase 7.2 - Parallel Processing)');
  }

  // PHASE 6.1: Cached node operator check
  isNodeOperator(address) {
    const cached = this.cache.getNodeOperatorStatus(address);
    if (cached !== null) return cached;
    const result = this.classifier.nodeOperators.has(address);
    this.cache.setNodeOperatorStatus(address, result);
    return result;
  }

  getNodeDetails(address) {
    if (!this.classifier.nodeOperators.has(address)) {
      return null;
    }
    
    const nodeData = this.classifier.nodeOperators.get(address);
    
    const nodeCount = nodeData.nodeCount || nodeData.count || nodeData.nodes?.length || 0;
    const tiers = nodeData.tiers || nodeData.tierBreakdown || nodeData.breakdown || { CUMULUS: 0, NIMBUS: 0, STRATUS: 0 };
    
    return {
      nodeCount,
      tiers
    };
  }

  /**
   * PHASE 6.1: Cached coinbase transaction check
   */
  async checkCoinbaseTransactions(walletAddress, fromBlock, toBlock) {
    try {
      // PHASE 6.1: Check cache first
      const cached = this.cache.getCoinbaseResult(walletAddress, fromBlock, toBlock);
      if (cached !== null) {
        if (cached.hasCoinbase) {
          console.log(`     💾 Coinbase cached! Count: ${cached.count}`);
        }
        return cached;
      }

      const addressUrl = `${FLUX_CONFIG.DATA_SOURCES.FLUX_INDEXER.baseUrl}/api/v1/addresses/${walletAddress}/transactions`;
      
      console.log(`     🪙 Checking coinbase: ${walletAddress.substring(0, 15)}...`);
      
      // PHASE 6.1: Try to get transactions from cache
      let transactions = this.cache.getWalletTransactions(walletAddress);
      
      if (!transactions) {
        const response = await fetch(addressUrl, { timeout: 10000 });
        if (!response.ok) {
          console.log(`     ⚠️  Coinbase check failed (API ${response.status})`);
          return { hasCoinbase: false };
        }

        const data = await response.json();
        transactions = data.transactions || [];
        
        // PHASE 6.1: Cache wallet transactions
        this.cache.setWalletTransactions(walletAddress, transactions);
      }

      // Filter for coinbase transactions in time window
      const coinbaseTxs = transactions.filter(tx => 
        tx.isCoinbase && 
        tx.blockHeight >= fromBlock && 
        tx.blockHeight <= toBlock
      );

      let result;
      if (coinbaseTxs.length > 0) {
        coinbaseTxs.sort((a, b) => b.blockHeight - a.blockHeight);
        
        const lastBlock = coinbaseTxs[0].blockHeight;
        const daysInactive = Math.floor((toBlock - lastBlock) * 30 / 86400);
        
        console.log(`     ✅ COINBASE FOUND! Count: ${coinbaseTxs.length}, Last block: ${lastBlock} (~${daysInactive} days ago)`);
        
        result = {
          hasCoinbase: true,
          count: coinbaseTxs.length,
          lastBlock: lastBlock,
          firstBlock: coinbaseTxs[coinbaseTxs.length - 1].blockHeight,
          daysInactive: daysInactive
        };
      } else {
        console.log(`     ⚪ No coinbase found in last ${Math.floor((toBlock - fromBlock) * 30 / 86400)} days`);
        result = { hasCoinbase: false };
      }

      // PHASE 6.1: Cache result
      this.cache.setCoinbaseResult(walletAddress, fromBlock, toBlock, result);
      
      return result;

    } catch (error) {
      console.error(`     ❌ Coinbase check error:`, error.message);
      return { hasCoinbase: false };
    }
  }

  /**
   * PHASE 5.1: Check if wallet has sent to current or historical node operators (within 1 year)
   */
  /**
   * PHASE 7.1: Fully cached historical connections check (outbound)
   */
  async checkHistoricalConnections(walletAddress, currentBlock) {
    try {
      const oneYearAgo = currentBlock - FLUX_CONFIG.ENHANCEMENT.HISTORICAL_DETECTION.TIME_WINDOW_BLOCKS;
      
      // PHASE 7.1: Check cache first
      const cached = this.cache.getHistoricalConnection(walletAddress, 'outbound', oneYearAgo);
      if (cached !== null) {
        if (cached.found) {
          console.log(`     💾 Historical connection cached (outbound)!`);
        }
        return cached;
      }

      const addressUrl = `${FLUX_CONFIG.DATA_SOURCES.FLUX_INDEXER.baseUrl}/api/v1/addresses/${walletAddress}/transactions`;
      
      console.log(`     🔗 Checking historical connections: ${walletAddress.substring(0, 15)}...`);
      
      // PHASE 7.1: Try to get transactions from cache
      let transactions = this.cache.getWalletTransactions(walletAddress);
      
      if (!transactions) {
        const response = await fetch(addressUrl, { timeout: 10000 });
        if (!response.ok) {
          console.log(`     ⚠️  Historical connection check failed (API ${response.status})`);
          const result = { found: false };
          this.cache.setHistoricalConnection(walletAddress, 'outbound', oneYearAgo, result);
          return result;
        }

        const data = await response.json();
        transactions = data.transactions || [];
        
        // PHASE 7.1: Cache wallet transactions
        this.cache.setWalletTransactions(walletAddress, transactions);
      }

      // Filter for outbound transactions within 1 year
      const outboundTxs = transactions.filter(tx => 
        tx.direction === 'sent' &&
        tx.blockHeight >= oneYearAgo &&
        tx.blockHeight <= currentBlock
      );

      // HOTFIX: Limit to most recent 20 transactions
      const limitedTxs = outboundTxs.slice(0, 20);
      
      console.log(`     📤 Found ${outboundTxs.length} outbound transactions in last year`);
      if (outboundTxs.length > 20) {
        console.log(`     ⚡ Limiting to most recent 20 for performance`);
      }

      // HOTFIX: Track checked wallets to avoid duplicates
      const checkedWallets = new Set();

      // Check each outbound transaction
      for (const tx of limitedTxs) {
        try {
          // PHASE 7.1: Check transaction details cache
          let txData = this.cache.getTransactionDetails(tx.txid);
          
          if (!txData) {
            const txUrl = `${FLUX_CONFIG.DATA_SOURCES.FLUX_INDEXER.baseUrl}/api/v1/transactions/${tx.txid}`;
            const txResponse = await fetch(txUrl, { timeout: 10000 });
            
            if (!txResponse.ok) continue;
            
            txData = await txResponse.json();
            
            // PHASE 7.1: Cache transaction details
            this.cache.setTransactionDetails(tx.txid, txData);
          }
          
          // Check each output
          for (const output of txData.vout || []) {
            const destWallet = output.scriptPubKey?.addresses?.[0];
            if (!destWallet) continue;
            
            // HOTFIX: Skip if we already checked this destination
            if (checkedWallets.has(destWallet)) {
              continue;
            }
            checkedWallets.add(destWallet);
            
            // Check if destination is current node operator
            if (this.isNodeOperator(destWallet)) {
              const daysAgo = Math.floor((currentBlock - tx.blockHeight) * 30 / 86400);
              console.log(`     ✅ HISTORICAL CONNECTION FOUND!`);
              console.log(`        Sent to current node operator: ${destWallet.substring(0, 15)}...`);
              console.log(`        Transaction: ${tx.txid.substring(0, 20)}...`);
              console.log(`        Block: ${tx.blockHeight} (~${daysAgo} days ago)`);
              
              const result = {
                found: true,
                method: 'current_node_operator',
                nodeWallet: destWallet,
                txid: tx.txid,
                blockHeight: tx.blockHeight,
                daysAgo: daysAgo
              };
              
              // PHASE 7.1: Cache result
              this.cache.setHistoricalConnection(walletAddress, 'outbound', oneYearAgo, result);
              
              return result;
            }
            
            // Check if destination has coinbase (historical node operator)
            const coinbaseCheck = await this.checkCoinbaseTransactions(
              destWallet, 
              oneYearAgo, 
              currentBlock
            );
            
            if (coinbaseCheck.hasCoinbase) {
              const daysAgo = Math.floor((currentBlock - tx.blockHeight) * 30 / 86400);
              console.log(`     ✅ HISTORICAL CONNECTION FOUND!`);
              console.log(`        Sent to historical node operator: ${destWallet.substring(0, 15)}...`);
              console.log(`        Transaction: ${tx.txid.substring(0, 20)}...`);
              console.log(`        Block: ${tx.blockHeight} (~${daysAgo} days ago)`);
              console.log(`        Destination had ${coinbaseCheck.count} coinbase transactions`);
              
              const result = {
                found: true,
                method: 'historical_node_operator',
                nodeWallet: destWallet,
                txid: tx.txid,
                blockHeight: tx.blockHeight,
                daysAgo: daysAgo,
                coinbaseCount: coinbaseCheck.count,
                coinbaseLastBlock: coinbaseCheck.lastBlock
              };
              
              // PHASE 7.1: Cache result
              this.cache.setHistoricalConnection(walletAddress, 'outbound', oneYearAgo, result);
              
              return result;
            }
          }
        } catch (txError) {
          console.error(`     ⚠️  Error checking tx ${tx.txid.substring(0, 10)}:`, txError.message);
          continue;
        }
      }

      console.log(`     ⚪ No historical connections found`);
      
      const result = { found: false };
      
      // PHASE 7.1: Cache negative result
      this.cache.setHistoricalConnection(walletAddress, 'outbound', oneYearAgo, result);
      
      return result;

    } catch (error) {
      console.error(`     ❌ Historical connection check error:`, error.message);
      return { found: false };
    }
  }

  async enhanceUnknownWallets() {
    if (this.isEnhancing) {
      return { success: false, message: 'Enhancement already running', stats: this.stats };
    }

    try {
      this.isEnhancing = true;
      
      // PHASE 7.2: Start cache session
      this.cache.startSession();
      console.log('\n🔍 PHASE 7.2: Parallel Processing + Full Method Caching\n');

      this.stats = { 
        totalAnalyzed: 0, 
        enhanced: { level1: 0, level2: 0, level3: 0 },
        historical: { level0: 0, level1: 0, level2: 0, level3: 0 },
        historicalConnection: { level0: 0 },
        enhancedToBuying: 0, 
        enhancedToSelling: 0, 
        remainedUnknown: 0, 
        errors: 0,
        circularDetections: 0
      };

      const unknowns = this.db.getUnknownWallets();
      console.log(`📊 Found ${unknowns.buys.length} unknown buying, ${unknowns.sells.length} unknown selling\n`);

      const maxDepth = FLUX_CONFIG.ENHANCEMENT.MULTI_HOP.DEFAULT_DEPTH;
      const parallelConfig = FLUX_CONFIG.ENHANCEMENT.PARALLEL_PROCESSING;
      
      console.log(`🎯 Multi-hop depth: ${maxDepth} (max: ${FLUX_CONFIG.ENHANCEMENT.MULTI_HOP.MAX_DEPTH})`);
      console.log(`🪙 Historical coinbase: ${FLUX_CONFIG.ENHANCEMENT.HISTORICAL_DETECTION.ENABLED ? 'Enabled' : 'Disabled'}`);
      console.log(`🔗 Historical connections: ${FLUX_CONFIG.ENHANCEMENT.HISTORICAL_CONNECTIONS.ENABLED ? 'Enabled' : 'Disabled'}`);
      console.log(`💾 Smart caching: Enabled`);
      console.log(`⚡ Performance hotfix: Enabled (20 tx limit + duplicate tracking)`);
      console.log(`🚀 Parallel processing: ${parallelConfig.ENABLED ? `Enabled (batch size: ${parallelConfig.BATCH_SIZE})` : 'Disabled'}`);
      console.log(`⏰ Time window: ${FLUX_CONFIG.ENHANCEMENT.HISTORICAL_DETECTION.TIME_WINDOW_BLOCKS} blocks (~${Math.floor(FLUX_CONFIG.ENHANCEMENT.HISTORICAL_DETECTION.TIME_WINDOW_BLOCKS * 30 / 86400)} days)\n`);

      // PHASE 7.2: Process buying events (parallel or sequential based on config)
      if (unknowns.buys.length > 0) {
        console.log('🔵 Analyzing BUYING events...\n');
        
        if (parallelConfig.ENABLED && unknowns.buys.length >= 2) {
          await this.processEventsInParallel(unknowns.buys, 'buying', maxDepth, parallelConfig);
        } else {
          // Sequential fallback
          console.log('   ℹ️  Sequential mode (parallel disabled or only 1 unknown)\n');
          for (const event of unknowns.buys) {
            await this.analyzeBuyingEventMultiHop(event, maxDepth);
            this.stats.totalAnalyzed++;
          }
        }
      }

      // PHASE 7.2: Process selling events (parallel or sequential based on config)
      if (unknowns.sells.length > 0) {
        console.log('\n🔴 Analyzing SELLING events...\n');
        
        if (parallelConfig.ENABLED && unknowns.sells.length >= 2) {
          await this.processEventsInParallel(unknowns.sells, 'selling', maxDepth, parallelConfig);
        } else {
          // Sequential fallback
          console.log('   ℹ️  Sequential mode (parallel disabled or only 1 unknown)\n');
          for (const event of unknowns.sells) {
            await this.analyzeSellingEventMultiHop(event, maxDepth);
            this.stats.totalAnalyzed++;
          }
        }
      }

      console.log('\n✅ Enhancement Complete');
      console.log(`📊 Total: ${this.stats.totalAnalyzed}`);
      console.log(`   Current API Detection:`);
      console.log(`     L1 (1-hop): ${this.stats.enhanced.level1}`);
      console.log(`     L2 (2-hop): ${this.stats.enhanced.level2}`);
      console.log(`     L3 (3-hop): ${this.stats.enhanced.level3}`);
      console.log(`   Historical Coinbase Detection:`);
      console.log(`     L0 (direct): ${this.stats.historical.level0}`);
      console.log(`     L1 (1-hop): ${this.stats.historical.level1}`);
      console.log(`     L2 (2-hop): ${this.stats.historical.level2}`);
      console.log(`     L3 (3-hop): ${this.stats.historical.level3}`);
      console.log(`   Historical Connection Detection:`);
      console.log(`     L0 (sent to node): ${this.stats.historicalConnection.level0}`);
      console.log(`   Unknown: ${this.stats.remainedUnknown}`);
      console.log(`   Circular detections: ${this.stats.circularDetections}\n`);

      // PHASE 6.1: Print cache statistics
      this.cache.printStats();

      return { success: true, stats: this.stats, cache: this.cache.endSession() };

    } catch (error) {
      console.error('❌ Enhancement error:', error);
      return { success: false, message: error.message, stats: this.stats };
    } finally {
      this.isEnhancing = false;
      
      // PHASE 6.1: Clear expired cache entries
      this.cache.clearExpired();
    }
  }

  /**
   * PHASE 7.2: Process events in parallel batches with extensive logging
   */
  async processEventsInParallel(events, flowType, maxDepth, config) {
    const batchSize = Math.min(config.BATCH_SIZE, config.MAX_CONCURRENT);
    const batches = [];
    
    // Split events into batches
    for (let i = 0; i < events.length; i += batchSize) {
      batches.push(events.slice(i, i + batchSize));
    }
    
    const totalBatches = batches.length;
    const totalEvents = events.length;
    const estimatedSequentialTime = totalEvents * 4.8; // Rough estimate based on Phase 7.1
    
    console.log(`   📦 Parallel Configuration:`);
    console.log(`      Total events: ${totalEvents}`);
    console.log(`      Batch size: ${batchSize}`);
    console.log(`      Total batches: ${totalBatches}`);
    console.log(`      Estimated sequential time: ${estimatedSequentialTime.toFixed(1)}s`);
    console.log(`      Expected speedup: ${(batchSize * 0.85).toFixed(1)}x\n`);
    
    let batchNumber = 0;
    const overallStartTime = Date.now();
    
    for (const batch of batches) {
      batchNumber++;
      const batchStartTime = Date.now();
      
      console.log(`   🚀 Batch ${batchNumber}/${totalBatches}: Processing ${batch.length} ${flowType} events in parallel...`);
      
      if (config.LOG_BATCH_PROGRESS) {
        batch.forEach((event, idx) => {
          const wallet = flowType === 'buying' ? event.to_address : event.from_address;
          console.log(`      ⚡ [${idx + 1}/${batch.length}] Starting: ${wallet.substring(0, 15)}... (tx: ${event.txid.substring(0, 10)}...)`);
        });
      }
      
      // Process batch in parallel with individual timing
      const batchPromises = batch.map(async (event, idx) => {
        const eventStartTime = Date.now();
        const wallet = flowType === 'buying' ? event.to_address : event.from_address;
        
        try {
          if (flowType === 'buying') {
            await this.analyzeBuyingEventMultiHop(event, maxDepth);
          } else {
            await this.analyzeSellingEventMultiHop(event, maxDepth);
          }
          
          this.stats.totalAnalyzed++;
          
          const eventDuration = ((Date.now() - eventStartTime) / 1000).toFixed(2);
          
          if (config.LOG_INDIVIDUAL_TIMING) {
            console.log(`      ✅ [${idx + 1}/${batch.length}] Complete: ${wallet.substring(0, 15)}... (${eventDuration}s)`);
          }
          
          return { success: true, wallet, duration: eventDuration };
        } catch (error) {
          const eventDuration = ((Date.now() - eventStartTime) / 1000).toFixed(2);
          console.error(`      ❌ [${idx + 1}/${batch.length}] Error: ${wallet.substring(0, 15)}... (${eventDuration}s) - ${error.message}`);
          this.stats.errors++;
          return { success: false, wallet, duration: eventDuration, error: error.message };
        }
      });
      
      // Wait for entire batch to complete
      const results = await Promise.all(batchPromises);
      
      const batchDuration = ((Date.now() - batchStartTime) / 1000).toFixed(2);
      const successCount = results.filter(r => r.success).length;
      const errorCount = results.filter(r => !r.success).length;
      const avgEventTime = (results.reduce((sum, r) => sum + parseFloat(r.duration), 0) / results.length).toFixed(2);
      const maxEventTime = Math.max(...results.map(r => parseFloat(r.duration))).toFixed(2);
      const minEventTime = Math.min(...results.map(r => parseFloat(r.duration))).toFixed(2);
      
      // Calculate speedup
      const sequentialTimeEstimate = batch.length * 4.8;
      const actualSpeedup = (sequentialTimeEstimate / parseFloat(batchDuration)).toFixed(2);
      
      console.log(`\n   📊 Batch ${batchNumber}/${totalBatches} Complete:`);
      console.log(`      Duration: ${batchDuration}s (would be ~${sequentialTimeEstimate.toFixed(1)}s sequential)`);
      console.log(`      Speedup: ${actualSpeedup}x faster than sequential`);
      console.log(`      Success: ${successCount}/${batch.length}`);
      if (errorCount > 0) {
        console.log(`      Errors: ${errorCount}`);
      }
      console.log(`      Timing: min=${minEventTime}s, avg=${avgEventTime}s, max=${maxEventTime}s`);
      console.log('');
    }
    
    const overallDuration = ((Date.now() - overallStartTime) / 1000).toFixed(2);
    const overallSpeedup = (estimatedSequentialTime / parseFloat(overallDuration)).toFixed(2);
    
    console.log(`   🎉 All ${totalBatches} batches complete!`);
    console.log(`      Total duration: ${overallDuration}s`);
    console.log(`      Estimated sequential: ${estimatedSequentialTime.toFixed(1)}s`);
    console.log(`      Overall speedup: ${overallSpeedup}x faster! 🚀\n`);
  }

  /**
   * PHASE 5.1: Multi-hop buying event analysis with historical detection at each level
   */
  async analyzeBuyingEventMultiHop(event, maxDepth = 2) {
    try {
      const startWallet = event.to_address;
      console.log(`\n  🔎 BUYING: ${startWallet.substring(0, 15)}... (tx: ${event.txid.substring(0, 10)}...)`);
      console.log(`     📍 Event at block: ${event.block_height}, timestamp: ${event.block_time}`);
      console.log(`     🎯 Max depth: ${maxDepth} hops`);

      // PHASE 5: Check direct wallet for historical node operator (Level 0 - Coinbase)
      if (FLUX_CONFIG.ENHANCEMENT.HISTORICAL_DETECTION.ENABLED) {
        console.log(`\n     🔍 Level 0: Checking direct wallet for coinbase...`);
        const oneYearBlocks = FLUX_CONFIG.ENHANCEMENT.HISTORICAL_DETECTION.TIME_WINDOW_BLOCKS;
        const oneYearAgo = event.block_height - oneYearBlocks;
        
        const historical = await this.checkCoinbaseTransactions(startWallet, oneYearAgo, event.block_height);
        
        if (historical.hasCoinbase) {
          console.log(`     ✅ HISTORICAL NODE (COINBASE) FOUND at Level 0!`);
          
          this.updateFlowEventToHistorical({
            id: event.id,
            flowType: 'buying',
            level: 0,
            nodeWallet: startWallet,
            historicalData: historical,
            detectionMethod: 'coinbase'
          });
          
          this.stats.historical.level0++;
          this.stats.enhancedToBuying++;
          return;
        }
        
        console.log(`     ⚪ No coinbase found at Level 0`);
      }

      // PHASE 5.1: Check direct wallet for historical connections (Level 0 - Sent to Node)
      if (FLUX_CONFIG.ENHANCEMENT.HISTORICAL_CONNECTIONS.ENABLED) {
        console.log(`\n     🔍 Level 0: Checking for historical connections...`);
        
        const connection = await this.checkHistoricalConnections(startWallet, event.block_height);
        
        if (connection.found) {
          console.log(`     ✅ HISTORICAL CONNECTION FOUND at Level 0!`);
          
          this.updateFlowEventToHistoricalConnection({
            id: event.id,
            flowType: 'buying',
            level: 0,
            sourceWallet: startWallet,
            connectionData: connection
          });
          
          this.stats.historicalConnection.level0++;
          this.stats.enhancedToBuying++;
          return;
        }
        
        console.log(`     ⚪ No historical connections found at Level 0`);
      }

      console.log(`\n     ➡️  Continuing to multi-hop analysis...`);

      // Continue with multi-hop analysis
      const result = await this.analyzeMultiHop({
        startWallet,
        direction: 'outbound',
        startBlockHeight: event.block_height,
        startTimestamp: event.block_time,
        maxDepth,
        visitedWallets: new Set([startWallet])
      });

      if (!result) {
        console.log(`     ⚪ No node operator found in ${maxDepth}-hop chain`);
        this.stats.remainedUnknown++;
        return;
      }

      console.log(`     ✅ FOUND: ${result.level}-hop chain to ${result.status} node operator!`);
      console.log(`     📋 Chain: ${result.chain.map(w => w.substring(0, 10)).join(' → ')} → ${result.nodeWallet.substring(0, 10)}`);
      console.log(`     🔖 Method: ${result.detectionMethod}`);

      this.updateFlowEventToMultiHop({
        id: event.id,
        flowType: 'buying',
        newType: 'node_operator',
        level: result.level,
        hopChain: result.chain,
        nodeWallet: result.nodeWallet,
        intermediaryTxids: result.txids,
        detectionMethod: result.detectionMethod,
        status: result.status,
        historicalData: result.detectionMethod === 'historical_coinbase' ? {
          lastCoinbaseBlock: result.lastCoinbaseBlock,
          coinbaseCount: result.coinbaseCount,
          daysInactive: result.daysInactive
        } : null
      });

      if (result.detectionMethod === 'current_api') {
        this.stats.enhanced[`level${result.level}`]++;
      } else {
        this.stats.historical[`level${result.level}`]++;
      }
      this.stats.enhancedToBuying++;

    } catch (error) {
      console.error(`     ❌ Error:`, error.message);
      this.stats.errors++;
    }
  }

  /**
   * PHASE 5.1: Multi-hop selling event analysis (similar structure)
   */
  async analyzeSellingEventMultiHop(event, maxDepth = 2) {
    try {
      const startWallet = event.from_address;
      console.log(`\n  🔎 SELLING: ${startWallet.substring(0, 15)}... (tx: ${event.txid.substring(0, 10)}...)`);
      console.log(`     📍 Event at block: ${event.block_height}, timestamp: ${event.block_time}`);
      console.log(`     🎯 Max depth: ${maxDepth} hops`);

      // PHASE 5: Check direct wallet for historical node operator (Level 0 - Coinbase)
      if (FLUX_CONFIG.ENHANCEMENT.HISTORICAL_DETECTION.ENABLED) {
        console.log(`\n     🔍 Level 0: Checking direct wallet for coinbase...`);
        const oneYearBlocks = FLUX_CONFIG.ENHANCEMENT.HISTORICAL_DETECTION.TIME_WINDOW_BLOCKS;
        const oneYearAgo = event.block_height - oneYearBlocks;
        
        const historical = await this.checkCoinbaseTransactions(startWallet, oneYearAgo, event.block_height);
        
        if (historical.hasCoinbase) {
          console.log(`     ✅ HISTORICAL NODE (COINBASE) FOUND at Level 0!`);
          
          this.updateFlowEventToHistorical({
            id: event.id,
            flowType: 'selling',
            level: 0,
            nodeWallet: startWallet,
            historicalData: historical,
            detectionMethod: 'coinbase'
          });
          
          this.stats.historical.level0++;
          this.stats.enhancedToSelling++;
          return;
        }
        
        console.log(`     ⚪ No coinbase found at Level 0`);
      }

      // PHASE 5.1: Check direct wallet for historical connections (Level 0 - Received from Node)
      // Note: For selling, we check if this wallet historically RECEIVED from node operators
      if (FLUX_CONFIG.ENHANCEMENT.HISTORICAL_CONNECTIONS.ENABLED) {
        console.log(`\n     🔍 Level 0: Checking for historical connections...`);
        
        // For selling, check inbound connections from nodes
        const connection = await this.checkHistoricalConnectionsInbound(startWallet, event.block_height);
        
        if (connection.found) {
          console.log(`     ✅ HISTORICAL CONNECTION FOUND at Level 0!`);
          
          this.updateFlowEventToHistoricalConnection({
            id: event.id,
            flowType: 'selling',
            level: 0,
            sourceWallet: startWallet,
            connectionData: connection
          });
          
          this.stats.historicalConnection.level0++;
          this.stats.enhancedToSelling++;
          return;
        }
        
        console.log(`     ⚪ No historical connections found at Level 0`);
      }

      console.log(`\n     ➡️  Continuing to multi-hop analysis...`);

      // Continue with multi-hop analysis
      const result = await this.analyzeMultiHop({
        startWallet,
        direction: 'inbound',
        startBlockHeight: event.block_height,
        startTimestamp: event.block_time,
        maxDepth,
        visitedWallets: new Set([startWallet])
      });

      if (!result) {
        console.log(`     ⚪ No node operator found in ${maxDepth}-hop chain`);
        this.stats.remainedUnknown++;
        return;
      }

      console.log(`     ✅ FOUND: ${result.level}-hop chain from ${result.status} node operator!`);
      console.log(`     📋 Chain: ${result.nodeWallet.substring(0, 10)} → ${result.chain.map(w => w.substring(0, 10)).join(' → ')}`);
      console.log(`     🔖 Method: ${result.detectionMethod}`);

      this.updateFlowEventToMultiHop({
        id: event.id,
        flowType: 'selling',
        newType: 'node_operator',
        level: result.level,
        hopChain: result.chain,
        nodeWallet: result.nodeWallet,
        intermediaryTxids: result.txids,
        detectionMethod: result.detectionMethod,
        status: result.status,
        historicalData: result.detectionMethod === 'historical_coinbase' ? {
          lastCoinbaseBlock: result.lastCoinbaseBlock,
          coinbaseCount: result.coinbaseCount,
          daysInactive: result.daysInactive
        } : null
      });

      if (result.detectionMethod === 'current_api') {
        this.stats.enhanced[`level${result.level}`]++;
      } else {
        this.stats.historical[`level${result.level}`]++;
      }
      this.stats.enhancedToSelling++;

    } catch (error) {
      console.error(`     ❌ Error:`, error.message);
      this.stats.errors++;
    }
  }

  /**
   * PHASE 5.1: Check inbound historical connections (for selling events)
   */
  /**
   * PHASE 7.1: Fully cached historical connections check (inbound)
   */
  async checkHistoricalConnectionsInbound(walletAddress, currentBlock) {
    try {
      const oneYearAgo = currentBlock - FLUX_CONFIG.ENHANCEMENT.HISTORICAL_DETECTION.TIME_WINDOW_BLOCKS;
      
      // PHASE 7.1: Check cache first
      const cached = this.cache.getHistoricalConnection(walletAddress, 'inbound', oneYearAgo);
      if (cached !== null) {
        if (cached.found) {
          console.log(`     💾 Historical connection cached (inbound)!`);
        }
        return cached;
      }

      const addressUrl = `${FLUX_CONFIG.DATA_SOURCES.FLUX_INDEXER.baseUrl}/api/v1/addresses/${walletAddress}/transactions`;
      
      console.log(`     🔗 Checking historical inbound connections: ${walletAddress.substring(0, 15)}...`);
      
      // PHASE 7.1: Try to get transactions from cache
      let transactions = this.cache.getWalletTransactions(walletAddress);
      
      if (!transactions) {
        const response = await fetch(addressUrl, { timeout: 10000 });
        if (!response.ok) {
          console.log(`     ⚠️  Historical connection check failed (API ${response.status})`);
          const result = { found: false };
          this.cache.setHistoricalConnection(walletAddress, 'inbound', oneYearAgo, result);
          return result;
        }

        const data = await response.json();
        transactions = data.transactions || [];
        
        // PHASE 7.1: Cache wallet transactions
        this.cache.setWalletTransactions(walletAddress, transactions);
      }

      // Filter for inbound transactions within 1 year
      const inboundTxs = transactions.filter(tx => 
        tx.direction === 'received' &&
        tx.blockHeight >= oneYearAgo &&
        tx.blockHeight <= currentBlock
      );

      // HOTFIX: Limit to most recent 20 transactions
      const limitedTxs = inboundTxs.slice(0, 20);

      console.log(`     📥 Found ${inboundTxs.length} inbound transactions in last year`);
      if (inboundTxs.length > 20) {
        console.log(`     ⚡ Limiting to most recent 20 for performance`);
      }

      // HOTFIX: Track checked wallets to avoid duplicates
      const checkedWallets = new Set();

      // Check each inbound transaction
      for (const tx of limitedTxs) {
        try {
          // PHASE 7.1: Check transaction details cache
          let txData = this.cache.getTransactionDetails(tx.txid);
          
          if (!txData) {
            const txUrl = `${FLUX_CONFIG.DATA_SOURCES.FLUX_INDEXER.baseUrl}/api/v1/transactions/${tx.txid}`;
            const txResponse = await fetch(txUrl, { timeout: 10000 });
            
            if (!txResponse.ok) continue;
            
            txData = await txResponse.json();
            
            // PHASE 7.1: Cache transaction details
            this.cache.setTransactionDetails(tx.txid, txData);
          }
          
          // Check each input
          for (const input of txData.vin || []) {
            const sourceWallet = input.addresses?.[0];
            if (!sourceWallet) continue;
            
            // HOTFIX: Skip if we already checked this source
            if (checkedWallets.has(sourceWallet)) {
              continue;
            }
            checkedWallets.add(sourceWallet);
            
            // Check if source is current node operator
            if (this.isNodeOperator(sourceWallet)) {
              const daysAgo = Math.floor((currentBlock - tx.blockHeight) * 30 / 86400);
              console.log(`     ✅ HISTORICAL CONNECTION FOUND!`);
              console.log(`        Received from current node operator: ${sourceWallet.substring(0, 15)}...`);
              console.log(`        Transaction: ${tx.txid.substring(0, 20)}...`);
              console.log(`        Block: ${tx.blockHeight} (~${daysAgo} days ago)`);
              
              const result = {
                found: true,
                method: 'current_node_operator',
                nodeWallet: sourceWallet,
                txid: tx.txid,
                blockHeight: tx.blockHeight,
                daysAgo: daysAgo
              };
              
              // PHASE 7.1: Cache result
              this.cache.setHistoricalConnection(walletAddress, 'inbound', oneYearAgo, result);
              
              return result;
            }
            
            // Check if source has coinbase (historical node operator)
            const coinbaseCheck = await this.checkCoinbaseTransactions(
              sourceWallet, 
              oneYearAgo, 
              currentBlock
            );
            
            if (coinbaseCheck.hasCoinbase) {
              const daysAgo = Math.floor((currentBlock - tx.blockHeight) * 30 / 86400);
              console.log(`     ✅ HISTORICAL CONNECTION FOUND!`);
              console.log(`        Received from historical node operator: ${sourceWallet.substring(0, 15)}...`);
              console.log(`        Transaction: ${tx.txid.substring(0, 20)}...`);
              console.log(`        Block: ${tx.blockHeight} (~${daysAgo} days ago)`);
              console.log(`        Source had ${coinbaseCheck.count} coinbase transactions`);
              
              const result = {
                found: true,
                method: 'historical_node_operator',
                nodeWallet: sourceWallet,
                txid: tx.txid,
                blockHeight: tx.blockHeight,
                daysAgo: daysAgo,
                coinbaseCount: coinbaseCheck.count,
                coinbaseLastBlock: coinbaseCheck.lastBlock
              };
              
              // PHASE 7.1: Cache result
              this.cache.setHistoricalConnection(walletAddress, 'inbound', oneYearAgo, result);
              
              return result;
            }
          }
        } catch (txError) {
          console.error(`     ⚠️  Error checking tx ${tx.txid.substring(0, 10)}:`, txError.message);
          continue;
        }
      }

      console.log(`     ⚪ No historical inbound connections found`);
      
      const result = { found: false };
      
      // PHASE 7.1: Cache negative result
      this.cache.setHistoricalConnection(walletAddress, 'inbound', oneYearAgo, result);
      
      return result;

    } catch (error) {
      console.error(`     ❌ Historical connection check error:`, error.message);
      return { found: false };
    }
  }

  /**
   * PHASE 5: Core BFS multi-hop algorithm (unchanged from Phase 5)
   */
  async analyzeMultiHop({ startWallet, direction, startBlockHeight, startTimestamp, maxDepth, visitedWallets }) {
    const queue = [{
      wallet: startWallet,
      depth: 0,
      chain: [],
      txids: []
    }];

    const timeWindowBlocks = FLUX_CONFIG.ENHANCEMENT.MULTI_HOP.TIME_WINDOW_BLOCKS;
    const maxBranches = FLUX_CONFIG.ENHANCEMENT.MULTI_HOP.MAX_BRANCHES_PER_WALLET;
    const historicalEnabled = FLUX_CONFIG.ENHANCEMENT.HISTORICAL_DETECTION.ENABLED;
    const historicalWindow = FLUX_CONFIG.ENHANCEMENT.HISTORICAL_DETECTION.TIME_WINDOW_BLOCKS;
    
    let nodesExplored = 0;

    while (queue.length > 0) {
      const current = queue.shift();
      nodesExplored++;

      if (current.depth >= maxDepth) {
        continue;
      }

      console.log(`\n     🔍 Level ${current.depth + 1}: Exploring hop ${current.depth + 1}...`);

      const nextTxs = direction === 'outbound'
        ? await this.getNextTransactionFromWallet(current.wallet, startBlockHeight, startTimestamp)
        : await this.getPreviousTransactionToWallet(current.wallet, startBlockHeight, startTimestamp);

      if (!nextTxs) {
        console.log(`     ⚪ No transactions found for this hop`);
        continue;
      }

      const txsToExplore = Array.isArray(nextTxs) 
        ? nextTxs.slice(0, maxBranches) 
        : [nextTxs];

      for (const tx of txsToExplore) {
        const nextWallet = direction === 'outbound' ? tx.toAddress : tx.fromAddress;
        
        console.log(`     📍 Checking wallet: ${nextWallet.substring(0, 15)}...`);
        
        if (visitedWallets.has(nextWallet)) {
          console.log(`     🔄 Circular: Already visited`);
          this.stats.circularDetections++;
          continue;
        }

        // ✅ STEP 1: Check Current Node API
        console.log(`     🔍 Step 1: Checking current node API...`);
        if (this.isNodeOperator(nextWallet)) {
          console.log(`     ✅ CURRENT NODE OPERATOR FOUND!`);
          return {
            level: current.depth + 1,
            chain: [...current.chain, current.wallet],
            nodeWallet: nextWallet,
            txids: [...current.txids, tx.txid],
            detectionMethod: 'current_api',
            status: 'active'
          };
        }
        console.log(`     ⚪ Not in current node API`);

        // ✅ STEP 2: Check Historical (Coinbase)
        if (historicalEnabled) {
          console.log(`     🔍 Step 2: Checking historical coinbase...`);
          const oneYearAgo = startBlockHeight - historicalWindow;
          const historical = await this.checkCoinbaseTransactions(nextWallet, oneYearAgo, startBlockHeight);
          
          if (historical.hasCoinbase) {
            console.log(`     ✅ HISTORICAL NODE OPERATOR FOUND!`);
            return {
              level: current.depth + 1,
              chain: [...current.chain, current.wallet],
              nodeWallet: nextWallet,
              txids: [...current.txids, tx.txid],
              detectionMethod: 'historical_coinbase',
              status: 'historical',
              lastCoinbaseBlock: historical.lastBlock,
              coinbaseCount: historical.count,
              daysInactive: historical.daysInactive
            };
          }
          console.log(`     ⚪ Not a historical node operator`);
        }

        // ✅ STEP 3: Not Found - Continue to Next Hop
        if (current.depth + 1 < maxDepth) {
          console.log(`     ➡️  Adding to queue for deeper exploration`);
          visitedWallets.add(nextWallet);
          queue.push({
            wallet: nextWallet,
            depth: current.depth + 1,
            chain: [...current.chain, current.wallet],
            txids: [...current.txids, tx.txid]
          });
        } else {
          console.log(`     🛑 Max depth reached, stopping here`);
        }
      }
    }

    console.log(`     📊 Explored ${nodesExplored} nodes, no node operator found`);
    return null;
  }

  async getNextTransactionFromWallet(walletAddress, afterBlockHeight, afterTimestamp) {
    try {
      const addressUrl = `${FLUX_CONFIG.DATA_SOURCES.FLUX_INDEXER.baseUrl}/api/v1/addresses/${walletAddress}/transactions`;
      
      const response = await fetch(addressUrl, { timeout: 10000 });
      if (!response.ok) throw new Error(`Indexer returned ${response.status}`);

      const data = await response.json();
      const transactions = data.transactions || [];
      
      for (const tx of transactions) {
        if (tx.blockHeight <= afterBlockHeight) continue;
        if (tx.timestamp <= afterTimestamp) continue;
        if (tx.direction !== 'sent') continue;

        const txUrl = `${FLUX_CONFIG.DATA_SOURCES.FLUX_INDEXER.baseUrl}/api/v1/transactions/${tx.txid}`;
        const txResponse = await fetch(txUrl, { timeout: 10000 });
        
        if (!txResponse.ok) continue;
        
        const fullTx = await txResponse.json();
        
        if (fullTx.vout && Array.isArray(fullTx.vout)) {
          for (const output of fullTx.vout) {
            const addresses = output.scriptPubKey?.addresses;
            if (addresses && Array.isArray(addresses) && addresses.length > 0) {
              const outputAddr = addresses[0];
              
              if (outputAddr !== walletAddress) {
                return {
                  txid: tx.txid,
                  fromAddress: walletAddress,
                  toAddress: outputAddr,
                  blockHeight: tx.blockHeight,
                  amount: parseFloat(output.value) / 100000000
                };
              }
            }
          }
        }
      }
      
      return null;

    } catch (error) {
      console.error(`     ❌ Error fetching next tx:`, error.message);
      return null;
    }
  }

  async getPreviousTransactionToWallet(walletAddress, beforeBlockHeight, beforeTimestamp) {
    try {
      const addressUrl = `${FLUX_CONFIG.DATA_SOURCES.FLUX_INDEXER.baseUrl}/api/v1/addresses/${walletAddress}/transactions`;
      
      const response = await fetch(addressUrl, { timeout: 10000 });
      if (!response.ok) throw new Error(`Indexer returned ${response.status}`);

      const data = await response.json();
      const transactions = data.transactions || [];
      
      const relevantTxs = transactions
        .filter(tx => tx.blockHeight < beforeBlockHeight && tx.timestamp < beforeTimestamp)
        .sort((a, b) => b.blockHeight - a.blockHeight);

      for (const tx of relevantTxs) {
        if (tx.direction !== 'received') continue;

        const txUrl = `${FLUX_CONFIG.DATA_SOURCES.FLUX_INDEXER.baseUrl}/api/v1/transactions/${tx.txid}`;
        const txResponse = await fetch(txUrl, { timeout: 10000 });
        
        if (!txResponse.ok) continue;
        
        const fullTx = await txResponse.json();
        
        if (fullTx.vin && Array.isArray(fullTx.vin)) {
          for (const input of fullTx.vin) {
            if (input.addresses && input.addresses.length > 0) {
              const inputAddr = input.addresses[0];
              
              if (inputAddr !== walletAddress) {
                return {
                  txid: tx.txid,
                  fromAddress: inputAddr,
                  toAddress: walletAddress,
                  blockHeight: tx.blockHeight,
                  amount: parseFloat(input.value) / 100000000
                };
              }
            }
          }
        }
      }
      
      return null;

    } catch (error) {
      console.error(`     ❌ Error fetching prev tx:`, error.message);
      return null;
    }
  }

  /**
   * PHASE 5: Update flow event with multi-hop or historical detection results
   */
  updateFlowEventToMultiHop(params) {
    const { id, flowType, newType, level, hopChain, nodeWallet, intermediaryTxids, detectionMethod, status, historicalData } = params;

    try {
      const nodeDetails = this.getNodeDetails(nodeWallet);
      
      const details = {
        nodeWallet: nodeWallet,
        detectedAt: Math.floor(Date.now() / 1000),
        hopCount: level,
        intermediaryTxids: intermediaryTxids,
        detectionMethod: detectionMethod,
        status: status,
        ...(historicalData && {
          lastCoinbaseBlock: historicalData.lastCoinbaseBlock,
          coinbaseCount: historicalData.coinbaseCount,
          daysInactive: historicalData.daysInactive
        }),
        ...(nodeDetails && {
          nodeCount: nodeDetails.nodeCount,
          tiers: nodeDetails.tiers
        })
      };

      const updates = {
        classificationLevel: level,
        hopChain: hopChain,
        intermediaryWallet: hopChain[0],
        analysisTimestamp: Math.floor(Date.now() / 1000),
        dataSource: 'enhanced'
      };

      if (flowType === 'buying') {
        updates.toType = newType;
        updates.toDetails = details;
      } else if (flowType === 'selling') {
        updates.fromType = newType;
        updates.fromDetails = details;
      }

      this.db.updateFlowEventClassification(id, updates);

      console.log(`     💾 Updated flow event #${id} to Level ${level} (${flowType}, ${detectionMethod})`);

    } catch (error) {
      console.error(`     ❌ DB update error:`, error.message);
      throw error;
    }
  }

  /**
   * PHASE 5: Update flow event for historical node detection at Level 0
   */
  updateFlowEventToHistorical(params) {
    const { id, flowType, level, nodeWallet, historicalData, detectionMethod } = params;

    try {
      const details = {
        nodeWallet: nodeWallet,
        detectedAt: Math.floor(Date.now() / 1000),
        hopCount: level,
        detectionMethod: detectionMethod === 'coinbase' ? 'historical_coinbase' : detectionMethod,
        status: 'historical',
        lastCoinbaseBlock: historicalData.lastBlock,
        coinbaseCount: historicalData.count,
        daysInactive: historicalData.daysInactive
      };

      const updates = {
        classificationLevel: level,
        hopChain: null,
        intermediaryWallet: null,
        analysisTimestamp: Math.floor(Date.now() / 1000),
        dataSource: 'enhanced'
      };

      if (flowType === 'buying') {
        updates.toType = 'node_operator';
        updates.toDetails = details;
      } else if (flowType === 'selling') {
        updates.fromType = 'node_operator';
        updates.fromDetails = details;
      }

      this.db.updateFlowEventClassification(id, updates);

      console.log(`     💾 Updated flow event #${id} to Historical Level 0 (${flowType})`);

    } catch (error) {
      console.error(`     ❌ DB update error:`, error.message);
      throw error;
    }
  }

  /**
   * PHASE 5.1: Update flow event for historical connection detection
   */
  updateFlowEventToHistoricalConnection(params) {
    const { id, flowType, level, sourceWallet, connectionData } = params;

    try {
      const nodeDetails = this.getNodeDetails(connectionData.nodeWallet);
      
      const details = {
        nodeWallet: connectionData.nodeWallet,
        detectedAt: Math.floor(Date.now() / 1000),
        hopCount: level,
        detectionMethod: 'historical_connection',
        status: connectionData.method === 'current_node_operator' ? 'active' : 'historical',
        connectionTxid: connectionData.txid,
        connectionBlock: connectionData.blockHeight,
        daysAgo: connectionData.daysAgo,
        ...(connectionData.coinbaseCount && {
          destinationCoinbaseCount: connectionData.coinbaseCount,
          destinationLastCoinbase: connectionData.coinbaseLastBlock
        }),
        ...(nodeDetails && {
          nodeCount: nodeDetails.nodeCount,
          tiers: nodeDetails.tiers
        })
      };

      const updates = {
        classificationLevel: level,
        hopChain: null,
        intermediaryWallet: null,
        analysisTimestamp: Math.floor(Date.now() / 1000),
        dataSource: 'enhanced'
      };

      if (flowType === 'buying') {
        updates.toType = 'node_operator';
        updates.toDetails = details;
      } else if (flowType === 'selling') {
        updates.fromType = 'node_operator';
        updates.fromDetails = details;
      }

      this.db.updateFlowEventClassification(id, updates);

      console.log(`     💾 Updated flow event #${id} to Historical Connection Level 0 (${flowType})`);

    } catch (error) {
      console.error(`     ❌ DB update error:`, error.message);
      throw error;
    }
  }

  getStats() {
    return this.stats;
  }

  isEnhancementRunning() {
    return this.isEnhancing;
  }
}

export default WalletEnhancementService;