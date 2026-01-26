// Enhanced Diagnostic - Find where addresses are stored in vout
import fetch from 'node-fetch';

const FLUX_INDEXER_BASE = 'http://192.168.10.65:42067';
const TEST_TXID = '01c7379a2db0d640d3b7bdfcfe3a52dce3f52c829a457f149736e06c1b322e0c';

async function deepInspectTransaction(txid) {
  console.log(`\n📋 Deep inspection of transaction: ${txid}\n`);
  
  try {
    const url = `${FLUX_INDEXER_BASE}/api/v1/transactions/${txid}`;
    const response = await fetch(url, { timeout: 10000 });
    const tx = await response.json();
    
    console.log(`📤 VOUT DEEP INSPECTION:\n`);
    
    if (tx.vout && Array.isArray(tx.vout)) {
      tx.vout.forEach((output, i) => {
        console.log(`Output ${i + 1}:`);
        console.log(`  Full object keys: ${Object.keys(output).join(', ')}`);
        console.log(`  Value: ${output.value}`);
        console.log(`  Addresses field: ${JSON.stringify(output.addresses)}`);
        console.log(`  Addresses type: ${typeof output.addresses}`);
        
        if (output.scriptPubKey) {
          console.log(`  ScriptPubKey keys: ${Object.keys(output.scriptPubKey).join(', ')}`);
          console.log(`  ScriptPubKey.type: ${output.scriptPubKey.type}`);
          console.log(`  ScriptPubKey.hex: ${output.scriptPubKey.hex?.substring(0, 40)}...`);
          console.log(`  ScriptPubKey.addresses: ${JSON.stringify(output.scriptPubKey.addresses)}`);
          
          // Check other possible fields
          console.log(`  ScriptPubKey.address: ${output.scriptPubKey.address || 'N/A'}`);
          console.log(`  ScriptPubKey full: ${JSON.stringify(output.scriptPubKey, null, 2)}`);
        }
        
        console.log('');
      });
    }
    
    // Try to find addresses anywhere in the response
    console.log(`\n🔍 Searching for address strings in entire response...\n`);
    const txString = JSON.stringify(tx);
    
    // Look for t1 addresses (Flux testnet/mainnet addresses start with t1)
    const addressPattern = /t1[a-zA-Z0-9]{33,34}/g;
    const foundAddresses = txString.match(addressPattern) || [];
    
    console.log(`Found ${foundAddresses.length} addresses in response:`);
    const uniqueAddresses = [...new Set(foundAddresses)];
    uniqueAddresses.forEach(addr => {
      console.log(`  - ${addr}`);
    });
    
  } catch (error) {
    console.error(`❌ Error:`, error.message);
  }
}

// Test with the known transaction
await deepInspectTransaction(TEST_TXID);

console.log(`\n${'='.repeat(80)}\n`);
console.log(`Now testing with the buy transaction to see if it has addresses...\n`);

const BUY_TX = '6f77d377a6de2628ffac746d3d9f1e4e15705009648ac2490885ae940a274e42';
await deepInspectTransaction(BUY_TX);