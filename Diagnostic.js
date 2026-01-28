// Diagnostic Script - Check Buying Events Breakdown
import Database from 'better-sqlite3';

const db = new Database('./data/flux-flow.db');

console.log('\n' + '='.repeat(70));
console.log('📊 BUYING EVENTS BREAKDOWN');
console.log('='.repeat(70) + '\n');

// 1. Breakdown by classification level
console.log('1️⃣ Buying Events by Classification Level:\n');

const breakdown = db.prepare(`
  SELECT 
    to_type,
    classification_level,
    COUNT(*) as count,
    SUM(amount) as total_flux
  FROM flow_events
  WHERE flow_type = 'buying'
  GROUP BY to_type, classification_level
  ORDER BY classification_level, to_type
`).all();

console.table(breakdown);

// 2. Total buying
console.log('\n2️⃣ Total Buying:\n');

const totalBuying = db.prepare(`
  SELECT 
    COUNT(*) as total_events,
    SUM(amount) as total_flux
  FROM flow_events
  WHERE flow_type = 'buying'
`).get();

console.log(`   Total Events: ${totalBuying.total_events}`);
console.log(`   Total FLUX: ${totalBuying.total_flux.toFixed(2)}\n`);

// 3. Enhanced events only
console.log('3️⃣ Enhanced Events (Level 1+):\n');

const enhanced = db.prepare(`
  SELECT 
    flow_type,
    classification_level,
    COUNT(*) as count,
    SUM(amount) as total_flux
  FROM flow_events
  WHERE classification_level > 0
  GROUP BY flow_type, classification_level
  ORDER BY classification_level
`).all();

if (enhanced.length > 0) {
  console.table(enhanced);
} else {
  console.log('   No enhanced events found.\n');
}

// 4. Sample enhanced event
console.log('4️⃣ Sample Enhanced Event:\n');

const sample = db.prepare(`
  SELECT 
    id, txid, 
    to_type, 
    classification_level,
    intermediary_wallet,
    hop_chain,
    amount
  FROM flow_events
  WHERE classification_level > 0
  LIMIT 1
`).get();

if (sample) {
  console.log(`   ID: ${sample.id}`);
  console.log(`   TX: ${sample.txid}`);
  console.log(`   To Type: ${sample.to_type}`);
  console.log(`   Level: ${sample.classification_level}`);
  console.log(`   Intermediary: ${sample.intermediary_wallet}`);
  console.log(`   Hop Chain: ${sample.hop_chain || 'null'}`);
  console.log(`   Amount: ${sample.amount} FLUX\n`);
} else {
  console.log('   No enhanced events found.\n');
}

// 5. Check for remaining unknowns
console.log('5️⃣ Remaining Unknown Wallets:\n');

const unknowns = db.prepare(`
  SELECT 
    flow_type,
    COUNT(*) as count
  FROM flow_events
  WHERE (to_type = 'unknown' OR from_type = 'unknown')
    AND classification_level = 0
  GROUP BY flow_type
`).all();

if (unknowns.length > 0) {
  console.table(unknowns);
} else {
  console.log('   All unknowns have been enhanced! ✅\n');
}

console.log('='.repeat(70));
console.log('✅ Diagnostic Complete');
console.log('='.repeat(70) + '\n');

db.close();