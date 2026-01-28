// Wallet Enhancement Service - PHASE 3: Multi-Hop Detection
// Implements BFS algorithm for 2-hop and 3-hop wallet chain analysis

import fetch from 'node-fetch';
import { FLUX_CONFIG } from '../config.js';

class WalletEnhancementService {
  constructor(databaseService, classificationService) {
    this.db = databaseService;
    this.classifier = classificationService;
    this.isEnhancing = false;
    
    this.stats = {
      totalAnalyzed: 0,
      enhanced: {
        level1: 0,  // 1-hop
        level2: 0,  // 2-hop
        level3: 0   // 3-hop
      },
      enhancedToBuying: 0,
      enhancedToSelling: 0,
      remainedUnknown: 0,
      errors: 0,
      circularDetections: 0
    };
    
    console.log('🔍 WalletEnhancementService initialized (Phase 3 - Multi-hop)');
  }

  isNodeOperator(address) {
    return this.classifier.nodeOperators.has(address);
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

  async enhanceUnknownWallets() {
    if (this.isEnhancing) {
      return { success: false, message: 'Enhancement already running', stats: this.stats };
    }

    try {
      this.isEnhancing = true;
      console.log('\n🔍 PHASE 3: Multi-Hop Wallet Enhancement Started\n');

      this.stats = { 
        totalAnalyzed: 0, 
        enhanced: { level1: 0, level2: 0, level3: 0 },
        enhancedToBuying: 0, 
        enhancedToSelling: 0, 
        remainedUnknown: 0, 
        errors: 0,
        circularDetections: 0
      };

      const unknowns = this.db.getUnknownWallets();
      console.log(`📊 Found ${unknowns.buys.length} unknown buying, ${unknowns.sells.length} unknown selling\n`);

      const maxDepth = FLUX_CONFIG.ENHANCEMENT.MULTI_HOP.DEFAULT_DEPTH;
      console.log(`🎯 Multi-hop depth: ${maxDepth} (max: ${FLUX_CONFIG.ENHANCEMENT.MULTI_HOP.MAX_DEPTH})\n`);

      if (unknowns.buys.length > 0) {
        console.log('🔵 Analyzing BUYING events...');
        for (const event of unknowns.buys) {
          await this.analyzeBuyingEventMultiHop(event, maxDepth);
          this.stats.totalAnalyzed++;
        }
      }

      if (unknowns.sells.length > 0) {
        console.log('\n🔴 Analyzing SELLING events...');
        for (const event of unknowns.sells) {
          await this.analyzeSellingEventMultiHop(event, maxDepth);
          this.stats.totalAnalyzed++;
        }
      }

      console.log('\n✅ Enhancement Complete');
      console.log(`📊 Total: ${this.stats.totalAnalyzed}`);
      console.log(`   L1 (1-hop): ${this.stats.enhanced.level1}`);
      console.log(`   L2 (2-hop): ${this.stats.enhanced.level2}`);
      console.log(`   L3 (3-hop): ${this.stats.enhanced.level3}`);
      console.log(`   Unknown: ${this.stats.remainedUnknown}`);
      console.log(`   Circular detections: ${this.stats.circularDetections}\n`);

      return { success: true, stats: this.stats };

    } catch (error) {
      console.error('❌ Enhancement error:', error);
      return { success: false, message: error.message, stats: this.stats };
    } finally {
      this.isEnhancing = false;
    }
  }

  /**
   * PHASE 3: Multi-hop buying event analysis (BFS)
   * Exchange → Wallet A → [Wallet B] → [Wallet C] → Node Operator
   */
  async analyzeBuyingEventMultiHop(event, maxDepth = 2) {
    try {
      const startWallet = event.to_address;
      console.log(`\n  🔎 BUYING: ${startWallet.substring(0, 15)}... (tx: ${event.txid.substring(0, 10)}...)`);
      console.log(`     📍 Event at block: ${event.block_height}, timestamp: ${event.block_time}`);
      console.log(`     🎯 Max depth: ${maxDepth} hops`);

      const result = await this.analyzeMultiHop({
        startWallet,
        direction: 'outbound',  // Follow outgoing transactions
        startBlockHeight: event.block_height,
        startTimestamp: event.block_time,
        maxDepth,
        visitedWallets: new Set([startWallet])  // Track visited wallets for circular detection
      });

      if (!result) {
        console.log(`     ⚪ No node operator found in ${maxDepth}-hop chain`);
        this.stats.remainedUnknown++;
        return;
      }

      console.log(`     ✅ FOUND: ${result.level}-hop chain to node operator!`);
      console.log(`     📋 Chain: ${result.chain.map(w => w.substring(0, 10)).join(' → ')} → ${result.nodeWallet.substring(0, 10)}`);

      this.updateFlowEventToMultiHop({
        id: event.id,
        flowType: 'buying',
        newType: 'node_operator',
        level: result.level,
        hopChain: result.chain,
        nodeWallet: result.nodeWallet,
        intermediaryTxids: result.txids
      });

      this.stats.enhanced[`level${result.level}`]++;
      this.stats.enhancedToBuying++;

    } catch (error) {
      console.error(`     ❌ Error:`, error.message);
      this.stats.errors++;
    }
  }

  /**
   * PHASE 3: Multi-hop selling event analysis (BFS)
   * Node Operator → [Wallet C] → [Wallet B] → Wallet A → Exchange
   */
  async analyzeSellingEventMultiHop(event, maxDepth = 2) {
    try {
      const startWallet = event.from_address;
      console.log(`\n  🔎 SELLING: ${startWallet.substring(0, 15)}... (tx: ${event.txid.substring(0, 10)}...)`);
      console.log(`     📍 Event at block: ${event.block_height}, timestamp: ${event.block_time}`);
      console.log(`     🎯 Max depth: ${maxDepth} hops`);

      const result = await this.analyzeMultiHop({
        startWallet,
        direction: 'inbound',  // Follow incoming transactions (look backwards)
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

      console.log(`     ✅ FOUND: ${result.level}-hop chain from node operator!`);
      console.log(`     📋 Chain: ${result.nodeWallet.substring(0, 10)} → ${result.chain.map(w => w.substring(0, 10)).join(' → ')}`);

      this.updateFlowEventToMultiHop({
        id: event.id,
        flowType: 'selling',
        newType: 'node_operator',
        level: result.level,
        hopChain: result.chain,
        nodeWallet: result.nodeWallet,
        intermediaryTxids: result.txids
      });

      this.stats.enhanced[`level${result.level}`]++;
      this.stats.enhancedToSelling++;

    } catch (error) {
      console.error(`     ❌ Error:`, error.message);
      this.stats.errors++;
    }
  }

  /**
   * PHASE 3: Core BFS multi-hop algorithm
   * Traverses transaction graph to find node operators
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
    let nodesExplored = 0;

    while (queue.length > 0) {
      const current = queue.shift();
      nodesExplored++;

      // Reached max depth - stop exploring this path
      if (current.depth >= maxDepth) {
        continue;
      }

      // Get next transactions
      const nextTxs = direction === 'outbound'
        ? await this.getNextTransactionFromWallet(current.wallet, startBlockHeight, startTimestamp)
        : await this.getPreviousTransactionToWallet(current.wallet, startBlockHeight, startTimestamp);

      if (!nextTxs) continue;

      // Limit branches to prevent explosion
      const txsToExplore = Array.isArray(nextTxs) 
        ? nextTxs.slice(0, maxBranches) 
        : [nextTxs];

      for (const tx of txsToExplore) {
        const nextWallet = direction === 'outbound' ? tx.toAddress : tx.fromAddress;
        
        // Circular detection
        if (visitedWallets.has(nextWallet)) {
          console.log(`     🔄 Circular: ${nextWallet.substring(0, 10)} already visited`);
          this.stats.circularDetections++;
          continue;
        }

        // Check if we found a node operator!
        if (this.isNodeOperator(nextWallet)) {
          return {
            level: current.depth + 1,
            chain: [...current.chain, current.wallet],
            nodeWallet: nextWallet,
            txids: [...current.txids, tx.txid]
          };
        }

        // Not a node operator - add to queue for deeper exploration
        if (current.depth + 1 < maxDepth) {
          visitedWallets.add(nextWallet);
          queue.push({
            wallet: nextWallet,
            depth: current.depth + 1,
            chain: [...current.chain, current.wallet],
            txids: [...current.txids, tx.txid]
          });
        }
      }
    }

    console.log(`     📊 Explored ${nodesExplored} nodes, no node operator found`);
    return null;
  }

  /**
   * Get next transaction from wallet (for buying/outbound analysis)
   */
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

        // Fetch full transaction details
        const txUrl = `${FLUX_CONFIG.DATA_SOURCES.FLUX_INDEXER.baseUrl}/api/v1/transactions/${tx.txid}`;
        const txResponse = await fetch(txUrl, { timeout: 10000 });
        
        if (!txResponse.ok) continue;
        
        const fullTx = await txResponse.json();
        
        // Find receiving address from vout
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

  /**
   * Get previous transaction to wallet (for selling/inbound analysis)
   */
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

        // Fetch full transaction details
        const txUrl = `${FLUX_CONFIG.DATA_SOURCES.FLUX_INDEXER.baseUrl}/api/v1/transactions/${tx.txid}`;
        const txResponse = await fetch(txUrl, { timeout: 10000 });
        
        if (!txResponse.ok) continue;
        
        const fullTx = await txResponse.json();
        
        // Find sending address from vin
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
   * PHASE 3: Update flow event with multi-hop detection results
   */
  updateFlowEventToMultiHop(params) {
    const { id, flowType, newType, level, hopChain, nodeWallet, intermediaryTxids } = params;

    try {
      // Fetch node details from classification service
      const nodeDetails = this.getNodeDetails(nodeWallet);
      
      const details = {
        nodeWallet: nodeWallet,
        detectedAt: Math.floor(Date.now() / 1000),
        hopCount: level,
        intermediaryTxids: intermediaryTxids,
        ...(nodeDetails && {
          nodeCount: nodeDetails.nodeCount,
          tiers: nodeDetails.tiers
        })
      };

      const updates = {
        classificationLevel: level,
        hopChain: hopChain,  // Store the chain of intermediary wallets
        intermediaryWallet: hopChain[0],  // First wallet in chain for backward compatibility
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

      console.log(`     💾 Updated flow event #${id} to Level ${level} (${flowType})${nodeDetails ? ` - ${nodeDetails.nodeCount} nodes` : ''}`);

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