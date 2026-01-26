// Test script to verify wallet t1MxGHuLAezJHenmv4ikVBCUHbARKk9WMda flow
// Run with: node test_wallet_flow.js

import fetch from 'node-fetch';

const FLUX_INDEXER = 'http://192.168.10.65:42067';
const TEST_WALLET = 't1MxGHuLAezJHenmv4ikVBCUHbARKk9WMda';
const EXPECTED_NODE_WALLET = 't1LeER4ryNJt1gLkV8bc2jAPupp5uvbVQ6o';

async function testWalletFlow() {
  console.log('🧪 Testing wallet flow detection\n');
  console.log(`Test Wallet: ${TEST_WALLET}`);
  console.log(`Expected Node Wallet: ${EXPECTED_NODE_WALLET}\n`);

  try {
    // Get transactions for the wallet
    const url = `${FLUX_INDEXER}/api/v1/addresses/${TEST_WALLET}/transactions`;
    console.log(`📡 Fetching: ${url}\n`);
    
    const response = await fetch(url);
    const data = await response.json();
    
    const transactions = data.transactions || [];
    console.log(`📊 Found ${transactions.length} total transactions\n`);
    
    // Find the buying transaction from GateIO
    const buyTx = transactions.find(tx => 
      tx.direction === 'received' && 
      tx.txid === '1c47c115b24a38406f3cefc31cd4b501590128208d31417c8f25f5b845ddfa0c'
    );
    
    if (buyTx) {
      console.log('✅ Found GateIO buy transaction:');
      console.log(`   TXID: ${buyTx.txid}`);
      console.log(`   Block: ${buyTx.blockHeight}`);
      console.log(`   Time: ${buyTx.timestamp}`);
      console.log(`   Direction: ${buyTx.direction}\n`);
      
      // Find sent transactions AFTER this one
      const sentTxs = transactions.filter(tx => 
        tx.direction === 'sent' &&
        tx.blockHeight > buyTx.blockHeight &&
        tx.timestamp > buyTx.timestamp
      );
      
      console.log(`📤 Found ${sentTxs.length} sent transactions after the buy:\n`);
      
      for (const sentTx of sentTxs) {
        console.log(`   TXID: ${sentTx.txid.substring(0, 10)}...`);
        console.log(`   Block: ${sentTx.blockHeight}`);
        console.log(`   Time: ${sentTx.timestamp}`);
        
        // Fetch full transaction to get destination
        const txUrl = `${FLUX_INDEXER}/api/v1/transactions/${sentTx.txid}`;
        const txResponse = await fetch(txUrl);
        const fullTx = await txResponse.json();
        
        console.log(`   Outputs: ${fullTx.vout?.length || 0}`);
        
        if (fullTx.vout) {
          for (const output of fullTx.vout) {
            const addresses = output.scriptPubKey?.addresses;
            if (addresses && addresses[0] !== TEST_WALLET) {
              console.log(`   → Destination: ${addresses[0]}`);
              
              if (addresses[0] === EXPECTED_NODE_WALLET) {
                console.log(`   ✅ ✅ ✅ THIS IS THE NODE WALLET! ✅ ✅ ✅`);
              }
            }
          }
        }
        console.log('');
      }
    } else {
      console.log('❌ Could not find the GateIO buy transaction');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testWalletFlow();