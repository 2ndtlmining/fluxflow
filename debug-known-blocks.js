/**
 * Debug Script v2: Test Specific Blocks with Fixed Logic
 * 
 * Tests blocks 2269369 and 2270119 with:
 * - All non-coinbase transactions fetched
 * - All outputs checked (not just first one)
 * - NonKYC exchange address included
 */

import fetch from 'node-fetch';
import { FLUX_CONFIG, getIndexerUrl } from './src/lib/config.js';
import ClassificationService from './src/lib/services/classificationService.js';

console.log('🔍 Debug v2: Testing Fixed Logic\n');
console.log('━'.repeat(70));

const TEST_BLOCKS = [
  { height: 2269369, expected: 'buying (Coinex)' },
  { height: 2270119, expected: 'selling (NonKYC)' }
];

async function testBlock(height, expected) {
  console.log(`\n📦 Testing Block ${height.toLocaleString()}`);
  console.log(`   Expected: ${expected}`);
  console.log('   ' + '─'.repeat(60));
  
  try {
    // Fetch block
    const url = getIndexerUrl('block', height.toString());
    const response = await fetch(url, { timeout: 10000 });
    
    if (!response.ok) {
      console.log(`   ❌ Failed to fetch block: ${response.status}`);
      return;
    }
    
    const blockData = await response.json();
    console.log(`   ✅ Block fetched: ${blockData.tx?.length || 0} transactions`);
    
    // Load classifier with exchanges
    const classifier = new ClassificationService();
    await classifier.refreshNodeOperators();
    
    const stats = classifier.getStats();
    console.log(`   📊 Loaded ${stats.exchanges.count} exchanges`);
    
    // CRITICAL FIX: Fetch ALL non-coinbase transactions
    const nonCoinbaseTxids = blockData.tx.slice(1);
    console.log(`\n   🔍 Analyzing ${nonCoinbaseTxids.length} non-coinbase transactions...\n`);
    
    let relevantCount = 0;
    
    for (const txid of nonCoinbaseTxids) {
      console.log(`   🔎 Transaction: ${txid.substring(0, 16)}...`);
      
      // Fetch full transaction
      const txUrl = getIndexerUrl('transaction', txid);
      const txResponse = await fetch(txUrl, { timeout: 10000 });
      
      if (!txResponse.ok) {
        console.log(`      ❌ Failed to fetch\n`);
        continue;
      }
      
      const tx = await txResponse.json();
      
      // Get vin/vout (normalize Flux Indexer format)
      let vin = tx.vin || [];
      let vout = tx.vout || [];
      
      // CRITICAL FIX: Flux Indexer uses vout[].scriptPubKey.addresses
      if (vout.length > 0) {
        for (const output of vout) {
          if (!output.addresses && output.scriptPubKey && output.scriptPubKey.addresses) {
            output.addresses = output.scriptPubKey.addresses;
          }
        }
      }
      
      console.log(`      📊 ${vin.length} inputs, ${vout.length} outputs`);
      
      // Classify all addresses
      let foundExchange = false;
      let foundOther = false;
      
      // Check inputs
      for (const input of vin) {
        if (input.addresses && input.addresses.length > 0) {
          const addr = input.addresses[0];
          const classification = classifier.classifyAddress(addr);
          
          if (classification.type === 'exchange') {
            console.log(`      ✅ INPUT: ${addr.substring(0, 20)}... → ${classification.name}`);
            foundExchange = true;
          } else if (classification.type !== 'unknown') {
            foundOther = true;
          }
        }
      }
      
      // CRITICAL: Check ALL outputs!
      for (let i = 0; i < vout.length; i++) {
        const output = vout[i];
        if (output.addresses && output.addresses.length > 0) {
          const addr = output.addresses[0];
          const classification = classifier.classifyAddress(addr);
          
          if (classification.type === 'exchange') {
            console.log(`      ✅ OUTPUT #${i}: ${addr.substring(0, 20)}... → ${classification.name} ⭐⭐⭐`);
            foundExchange = true;
          } else if (classification.type !== 'unknown') {
            console.log(`      ℹ️  OUTPUT #${i}: ${addr.substring(0, 20)}... → ${classification.type}`);
            foundOther = true;
          }
        }
      }
      
      if (foundExchange || foundOther) {
        relevantCount++;
        console.log(`      ✅ RELEVANT!\n`);
      } else {
        console.log(`      ⚪ Not relevant\n`);
      }
    }
    
    console.log(`\n   📊 Summary: ${relevantCount} relevant transactions found`);
    
    if (relevantCount > 0) {
      console.log(`   ✅ This block SHOULD create flow events!`);
    } else {
      console.log(`   ❌ No flow events would be created`);
    }
    
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
  }
}

async function runTests() {
  for (const test of TEST_BLOCKS) {
    await testBlock(test.height, test.expected);
    console.log('\n' + '━'.repeat(70));
  }
  
  console.log('\n✅ Debug test complete!\n');
}

runTests();