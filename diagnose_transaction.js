// Diagnostic Script - Analyze specific buying transaction
// Example: t1MxGHuLAezJHenmv4ikVBCUHbARKk9WMda -> t1LeER4ryNJt1gLkV8bc2jAPupp5uvbVQ6o

import fetch from 'node-fetch';

const FLUX_INDEXER_BASE = 'http://192.168.10.65:42067';

// The example from Dennis
const EXAMPLE = {
  buyerWallet: 't1MxGHuLAezJHenmv4ikVBCUHbARKk9WMda',
  buyTxid: '6f77d377a6de2628ffac746d3d9f1e4e15705009648ac2490885ae940a274e42',
  expectedDestination: 't1LeER4ryNJt1gLkV8bc2jAPupp5uvbVQ6o'
};

async function analyzeTransaction(txid) {
  console.log(`\n📋 Analyzing transaction: ${txid}\n`);
  
  try {
    const url = `${FLUX_INDEXER_BASE}/api/v1/transactions/${txid}`;
    console.log(`🌐 Fetching: ${url}`);
    
    const response = await fetch(url, { timeout: 10000 });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const tx = await response.json();
    
    console.log(`\n✅ Transaction fetched successfully\n`);
    console.log(`📦 Block Height: ${tx.blockHeight || 'N/A'}`);
    console.log(`⏰ Timestamp: ${tx.time || tx.timestamp || 'N/A'}`);
    console.log(`💰 Total Value: ${tx.value || tx.valueOut || 'N/A'}\n`);
    
    // Analyze inputs
    console.log(`📥 INPUTS (vin):`);
    if (tx.vin && Array.isArray(tx.vin)) {
      console.log(`   Count: ${tx.vin.length}`);
      tx.vin.forEach((input, i) => {
        console.log(`   Input ${i + 1}:`);
        console.log(`      Addresses: ${JSON.stringify(input.addresses || 'none')}`);
        console.log(`      Value: ${input.value || 'N/A'}`);
        console.log(`      From txid: ${input.txid?.substring(0, 10) || 'N/A'}...`);
      });
    } else {
      console.log(`   ⚠️  No vin array found`);
    }
    
    // Analyze outputs
    console.log(`\n📤 OUTPUTS (vout):`);
    if (tx.vout && Array.isArray(tx.vout)) {
      console.log(`   Count: ${tx.vout.length}`);
      tx.vout.forEach((output, i) => {
        console.log(`   Output ${i + 1}:`);
        console.log(`      Addresses: ${JSON.stringify(output.addresses || 'none')}`);
        console.log(`      Value: ${output.value || 'N/A'}`);
        console.log(`      ScriptPubKey type: ${output.scriptPubKey?.type || 'N/A'}`);
        
        // Check if this matches our expected destination
        if (output.addresses && output.addresses.includes(EXAMPLE.expectedDestination)) {
          console.log(`      🎯 THIS IS THE EXPECTED DESTINATION!`);
        }
        
        // Check if this is the sender (change)
        if (output.addresses && output.addresses.includes(EXAMPLE.buyerWallet)) {
          console.log(`      🔄 This is change back to sender`);
        }
      });
    } else {
      console.log(`   ⚠️  No vout array found`);
    }
    
    // Show full JSON structure for debugging
    console.log(`\n📄 RAW TRANSACTION STRUCTURE:`);
    console.log(`   Keys: ${Object.keys(tx).join(', ')}`);
    
    // Show what our current code logic would extract
    console.log(`\n🔍 EXTRACTION TEST (current logic):`);
    if (tx.vout && Array.isArray(tx.vout)) {
      for (const output of tx.vout) {
        if (output.addresses && output.addresses.length > 0) {
          const outputAddr = output.addresses[0];
          console.log(`   Found address: ${outputAddr}`);
          
          if (outputAddr !== EXAMPLE.buyerWallet) {
            console.log(`   ✅ This is NOT the sender, would return: ${outputAddr}`);
          } else {
            console.log(`   ⏩ This IS the sender (skip)`);
          }
        }
      }
    }
    
  } catch (error) {
    console.error(`❌ Error:`, error.message);
  }
}

async function analyzeWalletTransactions(walletAddress, afterBlock, afterTime) {
  console.log(`\n\n═══════════════════════════════════════════════════════════\n`);
  console.log(`📊 Analyzing wallet: ${walletAddress}`);
  console.log(`🎯 Looking for transactions after block ${afterBlock}, time ${afterTime}\n`);
  
  try {
    const url = `${FLUX_INDEXER_BASE}/api/v1/addresses/${walletAddress}/transactions`;
    console.log(`🌐 Fetching: ${url}`);
    
    const response = await fetch(url, { timeout: 10000 });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    const transactions = data.transactions || [];
    
    console.log(`\n📊 Found ${transactions.length} total transactions\n`);
    
    // Filter to sent transactions after the event
    const sentTxs = transactions.filter(tx => 
      tx.direction === 'sent' && 
      tx.blockHeight > afterBlock &&
      tx.timestamp > afterTime
    );
    
    console.log(`📤 ${sentTxs.length} sent transactions after event:`);
    sentTxs.forEach((tx, i) => {
      console.log(`   ${i + 1}. ${tx.txid} (block: ${tx.blockHeight}, time: ${tx.timestamp})`);
    });
    
    if (sentTxs.length > 0) {
      console.log(`\n🔍 Analyzing the first sent transaction...`);
      await analyzeTransaction(sentTxs[0].txid);
    }
    
  } catch (error) {
    console.error(`❌ Error:`, error.message);
  }
}

// Run diagnostics
console.log(`\n${'='.repeat(80)}`);
console.log(`🔬 DIAGNOSTIC SCRIPT - Wallet Enhancement Issue`);
console.log(`${'='.repeat(80)}\n`);

console.log(`📝 Test Case:`);
console.log(`   Buyer wallet: ${EXAMPLE.buyerWallet}`);
console.log(`   Buy transaction: ${EXAMPLE.buyTxid}`);
console.log(`   Expected next destination: ${EXAMPLE.expectedDestination}`);

// First, find what transactions the wallet has after the buy
// (we need to get the buy tx details first to know the block/time)
await analyzeTransaction(EXAMPLE.buyTxid);

// Then analyze what transactions happened after
// Using approximate block/time from the buy event (block 2270703, time 1768981174)
await analyzeWalletTransactions(EXAMPLE.buyerWallet, 2270703, 1768981174);

console.log(`\n${'='.repeat(80)}`);
console.log(`✅ Diagnostic complete`);
console.log(`${'='.repeat(80)}\n`);