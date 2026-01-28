// Phase 3 Multi-Hop Detection Test Script
// Run this after deploying to verify multi-hop detection works

import DatabaseService from './src/lib/services/databaseService.js';
import ClassificationService from './src/lib/services/classificationService.js';
import WalletEnhancementService from './src/lib/services/walletEnhancementService.js';

async function testMultiHopDetection() {
  console.log('🧪 Phase 3: Multi-Hop Detection Test\n');
  console.log('=' .repeat(70));
  
  try {
    // Initialize services
    console.log('\n1️⃣ Initializing services...');
    const db = new DatabaseService();
    const classifier = new ClassificationService();
    await classifier.refreshNodeOperators();
    
    const enhancer = new WalletEnhancementService(db, classifier);
    
    console.log('   ✅ Services initialized');
    console.log(`   📊 Node operators loaded: ${classifier.nodeOperators.size}`);
    
    // Check database stats
    console.log('\n2️⃣ Database stats:');
    const stats = db.getStats();
    console.log(`   Blocks: ${stats.blocks.toLocaleString()}`);
    console.log(`   Flow Events: ${stats.flowEvents.toLocaleString()}`);
    
    // Check for unknown wallets
    console.log('\n3️⃣ Unknown wallets to enhance:');
    const unknowns = db.getUnknownWallets();
    console.log(`   Unknown buys: ${unknowns.buys.length}`);
    console.log(`   Unknown sells: ${unknowns.sells.length}`);
    console.log(`   Total: ${unknowns.total}`);
    
    if (unknowns.total === 0) {
      console.log('\n   ℹ️  No unknown wallets found. This is normal if:');
      console.log('      - Database was just created (no data yet)');
      console.log('      - All wallets already enhanced');
      console.log('      - Only direct exchange↔node transactions exist');
      console.log('\n   💡 Sync some blocks first, then run enhancement!');
      db.close();
      return;
    }
    
    // Show sample unknowns
    if (unknowns.buys.length > 0) {
      console.log('\n   📋 Sample unknown buying event:');
      const sample = unknowns.buys[0];
      console.log(`      TX: ${sample.txid}`);
      console.log(`      To: ${sample.to_address.substring(0, 20)}...`);
      console.log(`      Block: ${sample.block_height}`);
      console.log(`      Amount: ${sample.amount.toFixed(2)} FLUX`);
    }
    
    // Run enhancement
    console.log('\n4️⃣ Running multi-hop enhancement...');
    console.log('   ⏳ This may take a few minutes...\n');
    
    const result = await enhancer.enhanceUnknownWallets();
    
    if (result.success) {
      console.log('\n✅ Enhancement completed successfully!\n');
      console.log('📊 Results:');
      console.log(`   Total analyzed: ${result.stats.totalAnalyzed}`);
      console.log(`   Level 1 (1-hop): ${result.stats.enhanced.level1}`);
      console.log(`   Level 2 (2-hop): ${result.stats.enhanced.level2}`);
      console.log(`   Level 3 (3-hop): ${result.stats.enhanced.level3}`);
      console.log(`   Remained unknown: ${result.stats.remainedUnknown}`);
      console.log(`   Circular detections: ${result.stats.circularDetections}`);
      console.log(`   Errors: ${result.stats.errors}`);
      
      // Show updated stats
      console.log('\n5️⃣ Updated database stats:');
      const newStats = db.getStats();
      if (newStats.enhancementStats && newStats.enhancementStats.length > 0) {
        console.log('   Enhancement breakdown:');
        newStats.enhancementStats.forEach(stat => {
          console.log(`      Level ${stat.classification_level}: ${stat.count} events (${stat.data_source})`);
        });
      }
      
      // Verify hop chains were stored
      const enhanced = db.getFlowEvents(
        newStats.blockRange.minHeight,
        newStats.blockRange.maxHeight
      ).filter(e => e.classificationLevel > 0);
      
      if (enhanced.length > 0) {
        console.log(`\n   ✅ ${enhanced.length} events enhanced with hop chains`);
        
        // Show sample
        const sample = enhanced.find(e => e.hopChain && e.hopChain.length > 0);
        if (sample) {
          console.log('\n   📋 Sample multi-hop chain:');
          console.log(`      Level: ${sample.classificationLevel}`);
          console.log(`      Chain: ${sample.hopChain.map(w => w.substring(0, 10)).join(' → ')}`);
          console.log(`      → Node: ${sample.toDetails?.nodeWallet?.substring(0, 10) || sample.fromDetails?.nodeWallet?.substring(0, 10)}`);
        }
      }
      
    } else {
      console.log('\n❌ Enhancement failed:', result.message);
    }
    
    console.log('\n' + '='.repeat(70));
    console.log('✅ Test complete!');
    console.log('='.repeat(70) + '\n');
    
    db.close();
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

// Run the test
testMultiHopDetection();