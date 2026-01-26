// Wallet Enhancement Service - PHASE 2 - v2.5
// Keep v2's working logic + add detailed logging

import fetch from 'node-fetch';
import { FLUX_CONFIG } from '../config.js';

class WalletEnhancementService {
  constructor(databaseService, classificationService) {
    this.db = databaseService;
    this.classifier = classificationService;
    this.isEnhancing = false;
    
    this.stats = {
      totalAnalyzed: 0,
      enhancedToBuying: 0,
      enhancedToSelling: 0,
      remainedUnknown: 0,
      errors: 0
    };
    
    console.log('🔍 WalletEnhancementService initialized (v2.5 - debug logging)');
  }

  isNodeOperator(address) {
    return this.classifier.nodeOperators.has(address);
  }

  // Get node details (count and tiers) from classification service
// Get node details (count and tiers) from classification service
  getNodeDetails(address) {
    if (!this.classifier.nodeOperators.has(address)) {
      return null;
    }
    
    const nodeData = this.classifier.nodeOperators.get(address);
    
    // Debug: log what we got
    console.log(`     🔍 Node data for ${address.substring(0, 15)}:`, nodeData);
    
    // Try multiple possible field names
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
      console.log('\n🔍 PHASE 2: Wallet Enhancement Started (v2.5)\n');

      this.stats = { totalAnalyzed: 0, enhancedToBuying: 0, enhancedToSelling: 0, remainedUnknown: 0, errors: 0 };

      const unknowns = this.db.getUnknownWallets();
      console.log(`📊 Found ${unknowns.buys.length} unknown buying, ${unknowns.sells.length} unknown selling\n`);

      if (unknowns.buys.length > 0) {
        console.log('🔵 Analyzing BUYING events...');
        for (const event of unknowns.buys) {
          await this.analyzeBuyingEvent(event);
          this.stats.totalAnalyzed++;
        }
      }

      if (unknowns.sells.length > 0) {
        console.log('\n🔴 Analyzing SELLING events...');
        for (const event of unknowns.sells) {
          await this.analyzeSellingEvent(event);
          this.stats.totalAnalyzed++;
        }
      }

      console.log('\n✅ Enhancement Complete');
      console.log(`📊 Total: ${this.stats.totalAnalyzed}, Enhanced Buys: ${this.stats.enhancedToBuying}, Enhanced Sells: ${this.stats.enhancedToSelling}, Unknown: ${this.stats.remainedUnknown}\n`);

      return { success: true, stats: this.stats };

    } catch (error) {
      console.error('❌ Enhancement error:', error);
      return { success: false, message: error.message, stats: this.stats };
    } finally {
      this.isEnhancing = false;
    }
  }

  async analyzeBuyingEvent(event) {
    try {
      const unknownWallet = event.to_address;
      console.log(`\n  🔎 BUYING: ${unknownWallet.substring(0, 15)}... (tx: ${event.txid.substring(0, 10)}...)`);
      console.log(`     📍 Event at block: ${event.block_height}, timestamp: ${event.block_time}`);

      const nextTx = await this.getNextTransactionFromWallet(unknownWallet, event.block_height, event.block_time);

      if (!nextTx) {
        console.log(`     ⚪ No next transaction found`);
        this.stats.remainedUnknown++;
        return;
      }

      console.log(`     📤 Found next tx to: ${nextTx.toAddress.substring(0, 15)}...`);
      
      if (this.isNodeOperator(nextTx.toAddress)) {
        console.log(`     ✅ IS NODE OPERATOR!`);
        
        this.updateFlowEventToLevel1({
          id: event.id,
          flowType: 'buying',
          newType: 'node_operator',
          intermediaryWallet: unknownWallet,
          actualNodeWallet: nextTx.toAddress,
          intermediaryTxid: nextTx.txid
        });

        this.stats.enhancedToBuying++;
      } else {
        console.log(`     ⚪ Not a node operator`);
        this.stats.remainedUnknown++;
      }

    } catch (error) {
      console.error(`     ❌ Error:`, error.message);
      this.stats.errors++;
    }
  }

  async analyzeSellingEvent(event) {
    try {
      const unknownWallet = event.from_address;
      console.log(`\n  🔎 SELLING: ${unknownWallet.substring(0, 15)}... (tx: ${event.txid.substring(0, 10)}...)`);
      console.log(`     📍 Event at block: ${event.block_height}, timestamp: ${event.block_time}`);

      const prevTx = await this.getPreviousTransactionToWallet(unknownWallet, event.block_height, event.block_time);

      if (!prevTx) {
        console.log(`     ⚪ No previous transaction found`);
        this.stats.remainedUnknown++;
        return;
      }

      console.log(`     📥 Found prev tx from: ${prevTx.fromAddress.substring(0, 15)}...`);

      if (this.isNodeOperator(prevTx.fromAddress)) {
        console.log(`     ✅ IS NODE OPERATOR!`);
        
        this.updateFlowEventToLevel1({
          id: event.id,
          flowType: 'selling',
          newType: 'node_operator',
          intermediaryWallet: unknownWallet,
          actualNodeWallet: prevTx.fromAddress,
          intermediaryTxid: prevTx.txid
        });

        this.stats.enhancedToSelling++;
      } else {
        console.log(`     ⚪ Not a node operator`);
        this.stats.remainedUnknown++;
      }

    } catch (error) {
      console.error(`     ❌ Error:`, error.message);
      this.stats.errors++;
    }
  }

  // KEEP v2 LOGIC - it works!
  async getNextTransactionFromWallet(walletAddress, afterBlockHeight, afterTimestamp) {
    try {
      const addressUrl = `${FLUX_CONFIG.DATA_SOURCES.FLUX_INDEXER.baseUrl}/api/v1/addresses/${walletAddress}/transactions`;
      console.log(`     🌐 Fetching: ${addressUrl.substring(0, 80)}...`);
      
      const response = await fetch(addressUrl, { timeout: 10000 });

      if (!response.ok) throw new Error(`Indexer returned ${response.status}`);

      const data = await response.json();
      const transactions = data.transactions || [];
      
      console.log(`     📊 Found ${transactions.length} total transactions for wallet`);
      console.log(`     🎯 Criteria: block > ${afterBlockHeight}, timestamp > ${afterTimestamp}, direction = 'sent'`);
      
      let checkedCount = 0;
      
      for (const tx of transactions) {
        checkedCount++;
        
        // Log first few transactions
        if (checkedCount <= 3) {
          console.log(`     🔍 TX ${checkedCount}: ${tx.txid.substring(0,10)}... block:${tx.blockHeight} time:${tx.timestamp} dir:${tx.direction}`);
        }
        
        // Apply filters
        if (tx.blockHeight <= afterBlockHeight) {
          if (checkedCount <= 3) console.log(`        ⏩ Skip: block ${tx.blockHeight} <= ${afterBlockHeight}`);
          continue;
        }
        if (tx.timestamp <= afterTimestamp) {
          if (checkedCount <= 3) console.log(`        ⏩ Skip: timestamp ${tx.timestamp} <= ${afterTimestamp}`);
          continue;
        }
        if (tx.direction !== 'sent') {
          if (checkedCount <= 3) console.log(`        ⏩ Skip: direction '${tx.direction}' !== 'sent'`);
          continue;
        }

        console.log(`     ✅ MATCH FOUND: ${tx.txid.substring(0, 10)}...`);
        
        // Fetch full transaction details
        const txUrl = `${FLUX_CONFIG.DATA_SOURCES.FLUX_INDEXER.baseUrl}/api/v1/transactions/${tx.txid}`;
        const txResponse = await fetch(txUrl, { timeout: 10000 });
        
        if (!txResponse.ok) {
          console.error(`     ⚠️  Failed to fetch full tx details`);
          continue;
        }
        
        const fullTx = await txResponse.json();
        
        // Find receiving address from vout
        if (fullTx.vout && Array.isArray(fullTx.vout)) {
          console.log(`     📦 Transaction has ${fullTx.vout.length} outputs`);
          
          for (const output of fullTx.vout) {
            const addresses = output.scriptPubKey?.addresses;
            if (addresses && Array.isArray(addresses) && addresses.length > 0) {
              const outputAddr = addresses[0];
              
              if (outputAddr !== walletAddress) {
                console.log(`     ✅ Found destination: ${outputAddr}`);
                return {
                  txid: tx.txid,
                  fromAddress: walletAddress,
                  toAddress: outputAddr,
                  blockHeight: tx.blockHeight
                };
              }
            }
          }
        }
        
        console.log(`     ⚠️  No valid output address found`);
      }
      
      console.log(`     ⚪ Checked ${checkedCount} transactions, none matched`);
      return null;

    } catch (error) {
      console.error(`     ❌ Error:`, error.message);
      return null;
    }
  }

  async getPreviousTransactionToWallet(walletAddress, beforeBlockHeight, beforeTimestamp) {
    try {
      const addressUrl = `${FLUX_CONFIG.DATA_SOURCES.FLUX_INDEXER.baseUrl}/api/v1/addresses/${walletAddress}/transactions`;
      console.log(`     🌐 Fetching: ${addressUrl.substring(0, 80)}...`);
      
      const response = await fetch(addressUrl, { timeout: 10000 });

      if (!response.ok) throw new Error(`Indexer returned ${response.status}`);

      const data = await response.json();
      const transactions = data.transactions || [];
      
      console.log(`     📊 Found ${transactions.length} total transactions for wallet`);
      console.log(`     🎯 Criteria: block < ${beforeBlockHeight}, timestamp < ${beforeTimestamp}, direction = 'received'`);
      
      const relevantTxs = transactions
        .filter(tx => tx.blockHeight < beforeBlockHeight && tx.timestamp < beforeTimestamp)
        .sort((a, b) => b.blockHeight - a.blockHeight);

      console.log(`     📊 ${relevantTxs.length} transactions match time criteria`);
      
      let checkedCount = 0;
      for (const tx of relevantTxs) {
        checkedCount++;
        
        if (tx.direction !== 'received') {
          if (checkedCount <= 3) {
            console.log(`     🔍 TX ${checkedCount}: ${tx.txid.substring(0,10)}... dir:${tx.direction} (skip)`);
          }
          continue;
        }

        console.log(`     ✅ MATCH FOUND: ${tx.txid.substring(0, 10)}...`);
        
        // Fetch full transaction details
        const txUrl = `${FLUX_CONFIG.DATA_SOURCES.FLUX_INDEXER.baseUrl}/api/v1/transactions/${tx.txid}`;
        const txResponse = await fetch(txUrl, { timeout: 10000 });
        
        if (!txResponse.ok) {
          console.error(`     ⚠️  Failed to fetch full tx details`);
          continue;
        }
        
        const fullTx = await txResponse.json();
        
        // Find sending address from vin
        if (fullTx.vin && Array.isArray(fullTx.vin)) {
          console.log(`     📦 Transaction has ${fullTx.vin.length} inputs`);
          
          for (const input of fullTx.vin) {
            if (input.addresses && input.addresses.length > 0) {
              const inputAddr = input.addresses[0];
              console.log(`        💸 Input: ${inputAddr.substring(0,15)}... (${input.value || 0} FLUX)`);
              
              if (inputAddr !== walletAddress) {
                console.log(`     ✅ Found source: ${inputAddr}`);
                return {
                  txid: tx.txid,
                  fromAddress: inputAddr,
                  toAddress: walletAddress,
                  blockHeight: tx.blockHeight
                };
              }
            }
          }
        }
        
        console.log(`     ⚠️  No valid input address found`);
      }
      
      console.log(`     ⚪ No matching received transactions found`);
      return null;

    } catch (error) {
      console.error(`     ❌ Error:`, error.message);
      return null;
    }
  }

  updateFlowEventToLevel1(params) {
    const { id, flowType, newType, intermediaryWallet, actualNodeWallet, intermediaryTxid } = params;

    try {
      // Fetch node details from classification service
      const nodeDetails = this.getNodeDetails(actualNodeWallet);
      
      const details = {
        nodeWallet: actualNodeWallet,
        intermediaryTxid: intermediaryTxid,
        detectedAt: Math.floor(Date.now() / 1000),
        // Include node count and tiers if available
        ...(nodeDetails && {
          nodeCount: nodeDetails.nodeCount,
          tiers: nodeDetails.tiers
        })
      };

      const updates = {
        classificationLevel: 1,
        intermediaryWallet: intermediaryWallet,
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

      console.log(`     💾 Updated flow event #${id} to Level 1 (${flowType})${nodeDetails ? ` - ${nodeDetails.nodeCount} nodes` : ''}`);

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