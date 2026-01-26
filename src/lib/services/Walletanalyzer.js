/**
 * PHASE 2: Wallet Analyzer Service
 * 
 * Analyzes unknown wallets to detect if they're intermediary wallets
 * used by node operators to move funds to/from exchanges.
 * 
 * Strategy:
 * - For buying events (Exchange → Unknown): Look at unknown wallet's next SEND
 *   If it goes to a node operator, mark as "Node Operator (L1)"
 * 
 * - For selling events (Unknown → Exchange): Look at unknown wallet's last RECEIVE
 *   If it came from a node operator, mark as "Node Operator (L1)"
 */

import fetch from 'node-fetch';
import { FLUX_CONFIG, getIndexerUrl, getBlockbookUrl, getActiveDataSource } from '../config.js';

class WalletAnalyzer {
  constructor(databaseService, classificationService) {
    this.db = databaseService;
    this.classifier = classificationService;
    this.activeSource = getActiveDataSource();
    
    console.log('🔍 WalletAnalyzer initialized');
    console.log(`   - Data source: ${this.activeSource}`);
  }

  /**
   * Fetch transaction history for a wallet address
   */
  async fetchAddressTransactions(address, limit = 10) {
    try {
      let url, response, data;
      
      if (this.activeSource === 'FLUX_INDEXER') {
        // Flux Indexer format
        url = `${getIndexerUrl('address', address)}/transactions?limit=${limit}`;
        response = await fetch(url, { timeout: 10000 });
        
        if (!response.ok) {
          throw new Error(`Indexer returned ${response.status}`);
        }
        
        data = await response.json();
        
        // Indexer response: { address, transactions: [...], total, ... }
        return data.transactions || [];
        
      } else {
        // Blockbook format
        url = `${getBlockbookUrl('address', address)}?details=txs&pageSize=${limit}`;
        response = await fetch(url, { timeout: 10000 });
        
        if (!response.ok) {
          throw new Error(`Blockbook returned ${response.status}`);
        }
        
        data = await response.json();
        
        // Blockbook response: { address, txs: [...], ... }
        return data.txs || [];
      }
    } catch (error) {
      console.error(`Failed to fetch transactions for ${address}: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch full transaction details
   */
  async fetchTransaction(txid) {
    try {
      let url, response;
      
      if (this.activeSource === 'FLUX_INDEXER') {
        url = getIndexerUrl('transaction', txid);
      } else {
        url = `${FLUX_CONFIG.BLOCKBOOK_API}/tx/${txid}`;
      }
      
      response = await fetch(url, { timeout: 10000 });
      
      if (!response.ok) {
        return null;
      }
      
      return await response.json();
    } catch (error) {
      console.error(`Failed to fetch tx ${txid}: ${error.message}`);
      return null;
    }
  }

  /**
   * Analyze a buying event (Exchange → Unknown wallet)
   * Look for: Unknown wallet → Node Operator wallet (next send)
   */
  async analyzeBuyingEvent(flowEvent) {
    const unknownWallet = flowEvent.to_address;
    
    console.log(`  🔍 Analyzing buying event: Exchange → ${unknownWallet.substring(0, 10)}...`);
    
    // Fetch transaction history for this wallet
    const transactions = await this.fetchAddressTransactions(unknownWallet, 20);
    
    if (!transactions || transactions.length === 0) {
      console.log(`     ⚠️  No transaction history found`);
      return null;
    }
    
    // Find transactions AFTER this flow event
    const afterThisEvent = transactions.filter(tx => 
      tx.blockHeight > flowEvent.block_height ||
      (tx.blockHeight === flowEvent.block_height && tx.txid !== flowEvent.txid)
    );
    
    // Look for the next SEND transaction (where wallet is in inputs)
    for (const tx of afterThisEvent) {
      // Determine if this is a send (wallet appears in fromAddresses or vin)
      const isSend = this.isWalletSending(tx, unknownWallet);
      
      if (!isSend) continue;
      
      // Fetch full transaction details to see where funds went
      const fullTx = await this.fetchTransaction(tx.txid);
      
      if (!fullTx || !fullTx.vout) continue;
      
      // Check each output to see if it goes to a node operator
      for (const output of fullTx.vout) {
        if (!output.addresses || output.addresses.length === 0) continue;
        
        const toAddress = output.addresses[0];
        const classification = this.classifier.classifyAddress(toAddress);
        
        if (classification.type === 'node_operator') {
          console.log(`     ✅ Found node operator: ${toAddress.substring(0, 10)}... (${classification.nodeCount} nodes)`);
          
          return {
            toType: 'node_operator',
            toDetails: {
              nodeCount: classification.nodeCount,
              tiers: classification.tiers
            },
            intermediaryWallet: unknownWallet,
            classificationLevel: 1,
            confidence: 1.0
          };
        }
      }
    }
    
    console.log(`     ❌ No node operator found in next transactions`);
    return null;
  }

  /**
   * Analyze a selling event (Unknown wallet → Exchange)
   * Look for: Node Operator wallet → Unknown wallet (previous receive)
   */
  async analyzeSellingEvent(flowEvent) {
    const unknownWallet = flowEvent.from_address;
    
    console.log(`  🔍 Analyzing selling event: ${unknownWallet.substring(0, 10)}... → Exchange`);
    
    // Fetch transaction history for this wallet
    const transactions = await this.fetchAddressTransactions(unknownWallet, 20);
    
    if (!transactions || transactions.length === 0) {
      console.log(`     ⚠️  No transaction history found`);
      return null;
    }
    
    // Find transactions BEFORE this flow event
    const beforeThisEvent = transactions.filter(tx => 
      tx.blockHeight < flowEvent.block_height ||
      (tx.blockHeight === flowEvent.block_height && tx.txid !== flowEvent.txid)
    );
    
    // Look for the last RECEIVE transaction (where wallet is in outputs)
    for (const tx of beforeThisEvent.reverse()) {
      // Determine if this is a receive (wallet appears in toAddresses or vout)
      const isReceive = this.isWalletReceiving(tx, unknownWallet);
      
      if (!isReceive) continue;
      
      // Fetch full transaction details to see where funds came from
      const fullTx = await this.fetchTransaction(tx.txid);
      
      if (!fullTx || !fullTx.vin) continue;
      
      // Check each input to see if it came from a node operator
      for (const input of fullTx.vin) {
        if (!input.addresses || input.addresses.length === 0) continue;
        
        const fromAddress = input.addresses[0];
        const classification = this.classifier.classifyAddress(fromAddress);
        
        if (classification.type === 'node_operator') {
          console.log(`     ✅ Found node operator: ${fromAddress.substring(0, 10)}... (${classification.nodeCount} nodes)`);
          
          return {
            fromType: 'node_operator',
            fromDetails: {
              nodeCount: classification.nodeCount,
              tiers: classification.tiers
            },
            intermediaryWallet: unknownWallet,
            classificationLevel: 1,
            confidence: 1.0
          };
        }
      }
    }
    
    console.log(`     ❌ No node operator found in previous transactions`);
    return null;
  }

  /**
   * Helper: Check if wallet is sending in this transaction
   */
  isWalletSending(tx, wallet) {
    // Flux Indexer format: fromAddresses array
    if (tx.fromAddresses && Array.isArray(tx.fromAddresses)) {
      return tx.fromAddresses.includes(wallet);
    }
    
    // Blockbook format: vin with addresses
    if (tx.vin && Array.isArray(tx.vin)) {
      for (const input of tx.vin) {
        if (input.addresses && input.addresses.includes(wallet)) {
          return true;
        }
      }
    }
    
    // Check direction field (Flux Indexer)
    if (tx.direction === 'sent') {
      return true;
    }
    
    return false;
  }

  /**
   * Helper: Check if wallet is receiving in this transaction
   */
  isWalletReceiving(tx, wallet) {
    // Flux Indexer format: toAddresses array
    if (tx.toAddresses && Array.isArray(tx.toAddresses)) {
      return tx.toAddresses.includes(wallet);
    }
    
    // Blockbook format: vout with addresses
    if (tx.vout && Array.isArray(tx.vout)) {
      for (const output of tx.vout) {
        if (output.addresses && output.addresses.includes(wallet)) {
          return true;
        }
      }
    }
    
    // Check direction field (Flux Indexer)
    if (tx.direction === 'received') {
      return true;
    }
    
    return false;
  }

  /**
   * Enhance unknown wallets in database
   */
  async enhanceUnknownWallets(batchSize = 100) {
    console.log('\n🔍 Starting wallet enhancement process...\n');
    
    const startTime = Date.now();
    
    // Get unknown wallets from database
    const unknowns = this.db.getUnknownWallets();
    
    console.log(`📊 Found ${unknowns.total} unknown wallets:`);
    console.log(`   - Buying events: ${unknowns.buys.length}`);
    console.log(`   - Selling events: ${unknowns.sells.length}\n`);
    
    if (unknowns.total === 0) {
      console.log('✅ No unknown wallets to enhance\n');
      return {
        processed: 0,
        enhanced: 0,
        stillUnknown: 0,
        duration: 0
      };
    }
    
    let processed = 0;
    let enhanced = 0;
    let stillUnknown = 0;
    
    // Process buying events
    console.log('🔍 Processing buying events (Exchange → Unknown)...\n');
    for (const flowEvent of unknowns.buys.slice(0, batchSize)) {
      processed++;
      
      const result = await this.analyzeBuyingEvent(flowEvent);
      
      if (result) {
        // Update database with enhanced classification
        this.db.updateFlowEventClassification(flowEvent.id, {
          toType: result.toType,
          toDetails: result.toDetails,
          classificationLevel: result.classificationLevel,
          intermediaryWallet: result.intermediaryWallet,
          analysisTimestamp: Date.now(),
          dataSource: 'enhanced'
        });
        
        enhanced++;
      } else {
        stillUnknown++;
      }
      
      // Small delay to avoid overwhelming API
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // Process selling events
    console.log('\n🔍 Processing selling events (Unknown → Exchange)...\n');
    for (const flowEvent of unknowns.sells.slice(0, batchSize)) {
      processed++;
      
      const result = await this.analyzeSellingEvent(flowEvent);
      
      if (result) {
        // Update database with enhanced classification
        this.db.updateFlowEventClassification(flowEvent.id, {
          fromType: result.fromType,
          fromDetails: result.fromDetails,
          classificationLevel: result.classificationLevel,
          intermediaryWallet: result.intermediaryWallet,
          analysisTimestamp: Date.now(),
          dataSource: 'enhanced'
        });
        
        enhanced++;
      } else {
        stillUnknown++;
      }
      
      // Small delay to avoid overwhelming API
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    const duration = Date.now() - startTime;
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Enhancement Complete!\n');
    console.log(`📊 Results:`);
    console.log(`   - Processed: ${processed}`);
    console.log(`   - Enhanced to node operators: ${enhanced}`);
    console.log(`   - Still unknown: ${stillUnknown}`);
    console.log(`   - Success rate: ${((enhanced / processed) * 100).toFixed(1)}%`);
    console.log(`   - Duration: ${(duration / 1000).toFixed(1)}s\n`);
    
    return {
      processed,
      enhanced,
      stillUnknown,
      duration
    };
  }
}

export default WalletAnalyzer;