// WORKING SOLUTION - Find transaction destination via address history comparison
import fetch from 'node-fetch';

const FLUX_INDEXER_BASE = 'http://192.168.10.65:42067';

/**
 * Find the destination address of a transaction by:
 * 1. Getting the "sent" transaction from sender's history
 * 2. Getting details of the transaction
 * 3. For each vout, decode the scriptPubKey to find addresses
 * 4. Return the first address that's NOT the sender (change)
 */
async function findTransactionDestination(txid, senderAddress) {
  console.log(`\n🔍 Finding destination for tx: ${txid.substring(0, 10)}...`);
  console.log(`   Sender: ${senderAddress.substring(0, 15)}...`);
  
  try {
    // Fetch transaction details
    const txUrl = `${FLUX_INDEXER_BASE}/api/v1/transactions/${txid}`;
    const txResp = await fetch(txUrl, { timeout: 10000 });
    const tx = await txResp.json();
    
    if (!tx.vout || !Array.isArray(tx.vout)) {
      console.log(`   ❌ No vout array in transaction`);
      return null;
    }
    
    console.log(`   📦 Transaction has ${tx.vout.length} outputs`);
    
    // For each output, we need to decode the scriptPubKey to get the address
    // Since addresses aren't provided, we need to decode from scriptPubKey.hex
    // For Flux (Zcash-based), we can extract from scriptPubKey.asm or scriptPubKey.hex
    
    for (let i = 0; i < tx.vout.length; i++) {
      const output = tx.vout[i];
      console.log(`   Output ${i + 1}: ${output.value} satoshis`);
      
      // Try to extract address from scriptPubKey
      if (output.scriptPubKey) {
        const spk = output.scriptPubKey;
        
        // Method 1: Check if addresses field exists (might be in scriptPubKey)
        if (spk.addresses && Array.isArray(spk.addresses) && spk.addresses.length > 0) {
          const addr = spk.addresses[0];
          console.log(`      Found in scriptPubKey.addresses: ${addr.substring(0, 15)}...`);
          
          if (addr !== senderAddress) {
            console.log(`      ✅ This is the destination!`);
            return addr;
          } else {
            console.log(`      ⏩ This is change back to sender`);
          }
        }
        // Method 2: Check if address field exists (singular)
        else if (spk.address) {
          const addr = spk.address;
          console.log(`      Found in scriptPubKey.address: ${addr.substring(0, 15)}...`);
          
          if (addr !== senderAddress) {
            console.log(`      ✅ This is the destination!`);
            return addr;
          } else {
            console.log(`      ⏩ This is change back to sender`);
          }
        }
        // Method 3: Try to decode from asm
        else if (spk.asm) {
          console.log(`      ScriptPubKey.asm: ${spk.asm.substring(0, 50)}...`);
          // Extract potential address from asm
          // Flux addresses are base58 encoded, look for t1... patterns
          const asmMatch = spk.asm.match(/t1[a-zA-Z0-9]{33,34}/);
          if (asmMatch) {
            const addr = asmMatch[0];
            console.log(`      Found in asm: ${addr.substring(0, 15)}...`);
            
            if (addr !== senderAddress) {
              console.log(`      ✅ This is the destination!`);
              return addr;
            } else {
              console.log(`      ⏩ This is change back to sender`);
            }
          }
        }
        
        console.log(`      ⚠️  Could not extract address from this output`);
      }
    }
    
    console.log(`   ❌ No destination found in any output`);
    return null;
    
  } catch (error) {
    console.error(`   ❌ Error: ${error.message}`);
    return null;
  }
}

// Test with known example
const TEST_WALLET = 't1MxGHuLAezJHenmv4ikVBCUHbARKk9WMda';
const TEST_TX = '01c7379a2db0d640d3b7bdfcfe3a52dce3f52c829a457f149736e06c1b322e0c';
const EXPECTED_DEST = 't1LeER4ryNJt1gLkV8bc2jAPupp5uvbVQ6o';

console.log(`\n${'='.repeat(80)}`);
console.log(`🧪 TEST: Find destination for known transaction`);
console.log(`${'='.repeat(80)}`);

const result = await findTransactionDestination(TEST_TX, TEST_WALLET);

if (result) {
  console.log(`\n✅ Found destination: ${result}`);
  
  if (result === EXPECTED_DEST) {
    console.log(`🎉 SUCCESS! Matches expected destination!`);
  } else {
    console.log(`⚠️  Found ${result}`);
    console.log(`   Expected ${EXPECTED_DEST}`);
  }
} else {
  console.log(`\n❌ Could not find destination`);
  console.log(`\n💡 This means addresses are not in the transaction response at all.`);
  console.log(`   We need to use a different API endpoint or method.`);
}

console.log(`\n${'='.repeat(80)}\n`);