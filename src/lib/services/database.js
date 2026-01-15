/**
 * DATABASE LAYER - Pure SQL Operations
 * 
 * Low-level database access - no business logic
 * Similar structure to Fluxtracker's database.js
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

let db = null;

/**
 * Initialize database connection
 */
export function initDatabase(dbPath = './data/flux-flow.db') {
  // Ensure directory exists
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  // Open database
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  
  // Create schema
  createSchema();
  
  return db;
}

/**
 * Get database instance
 */
export function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Close database connection
 */
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Create database schema
 */
function createSchema() {
  db.exec(`
    -- Blocks table
    CREATE TABLE IF NOT EXISTS blocks (
      height INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      time INTEGER NOT NULL,
      tx_count INTEGER NOT NULL,
      size INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
    
    CREATE INDEX IF NOT EXISTS idx_blocks_time ON blocks(time);
    
    -- Transactions table
    CREATE TABLE IF NOT EXISTS transactions (
      txid TEXT PRIMARY KEY,
      block_height INTEGER NOT NULL,
      block_time INTEGER NOT NULL,
      total_value REAL NOT NULL,
      from_addresses TEXT,  -- JSON array
      to_addresses TEXT,    -- JSON array
      flow_type TEXT,       -- 'buy', 'sell', 'transfer', or NULL
      flow_direction TEXT,  -- 'to_exchange', 'from_exchange', 'exchange_to_exchange', or NULL
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (block_height) REFERENCES blocks(height)
    );
    
    CREATE INDEX IF NOT EXISTS idx_tx_block ON transactions(block_height);
    CREATE INDEX IF NOT EXISTS idx_tx_time ON transactions(block_time);
    CREATE INDEX IF NOT EXISTS idx_tx_flow_type ON transactions(flow_type);
    
    -- Transaction classifications (many-to-many: transaction -> classifications)
    CREATE TABLE IF NOT EXISTS tx_classifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      txid TEXT NOT NULL,
      classification_type TEXT NOT NULL,  -- 'exchange', 'foundation', 'node_operator', 'unknown'
      address TEXT NOT NULL,
      direction TEXT NOT NULL,            -- 'from' or 'to'
      details TEXT,                       -- JSON with additional info (exchange name, node tier, etc)
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (txid) REFERENCES transactions(txid)
    );
    
    CREATE INDEX IF NOT EXISTS idx_class_txid ON tx_classifications(txid);
    CREATE INDEX IF NOT EXISTS idx_class_type ON tx_classifications(classification_type);
    CREATE INDEX IF NOT EXISTS idx_class_direction ON tx_classifications(direction);
    
    -- Sync state table
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
  `);
}

// ============================================================================
// BLOCKS
// ============================================================================

export function insertBlock(block) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO blocks (height, hash, time, tx_count, size)
    VALUES (?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    block.height,
    block.hash,
    block.time,
    block.txCount || block.txs?.length || 0,
    block.size || null
  );
}

export function getBlock(height) {
  return db.prepare('SELECT * FROM blocks WHERE height = ?').get(height);
}

export function getBlockCount() {
  return db.prepare('SELECT COUNT(*) as count FROM blocks').get().count;
}

export function getBlockRange() {
  return db.prepare(`
    SELECT 
      MIN(height) as min_height,
      MAX(height) as max_height,
      COUNT(*) as count
    FROM blocks
  `).get();
}

export function getLatestBlock() {
  return db.prepare('SELECT * FROM blocks ORDER BY height DESC LIMIT 1').get();
}

// ============================================================================
// TRANSACTIONS
// ============================================================================

export function insertTransaction(tx) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO transactions (
      txid, block_height, block_time, total_value,
      from_addresses, to_addresses, flow_type, flow_direction
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    tx.txid,
    tx.blockHeight,
    tx.blockTime,
    tx.value,
    JSON.stringify(tx.from?.map(c => c.address) || []),
    JSON.stringify(tx.to?.map(c => c.address) || []),
    tx.flowType || null,
    tx.flowDirection || null
  );
}

export function getTransaction(txid) {
  return db.prepare('SELECT * FROM transactions WHERE txid = ?').get(txid);
}

export function getTransactionCount() {
  return db.prepare('SELECT COUNT(*) as count FROM transactions').get().count;
}

export function getTransactionsInBlock(blockHeight) {
  return db.prepare('SELECT * FROM transactions WHERE block_height = ?').all(blockHeight);
}

export function getTransactionsInPeriod(startBlock, endBlock) {
  return db.prepare(`
    SELECT * FROM transactions 
    WHERE block_height BETWEEN ? AND ?
    ORDER BY block_height DESC
  `).all(startBlock, endBlock);
}

export function getTransactionsByFlowType(flowType, limit = 100) {
  return db.prepare(`
    SELECT * FROM transactions 
    WHERE flow_type = ?
    ORDER BY block_time DESC
    LIMIT ?
  `).all(flowType, limit);
}

// ============================================================================
// CLASSIFICATIONS
// ============================================================================

export function insertClassification(classification) {
  const stmt = db.prepare(`
    INSERT INTO tx_classifications (
      txid, classification_type, address, direction, details
    ) VALUES (?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    classification.txid,
    classification.type,
    classification.address,
    classification.direction,
    classification.details ? JSON.stringify(classification.details) : null
  );
}

export function insertTransactionClassifications(txid, fromClassifications, toClassifications) {
  const stmt = db.prepare(`
    INSERT INTO tx_classifications (txid, classification_type, address, direction, details)
    VALUES (?, ?, ?, ?, ?)
  `);
  
  // Insert from classifications
  for (const c of fromClassifications) {
    const details = { ...c };
    delete details.type;
    delete details.address;
    
    stmt.run(txid, c.type, c.address, 'from', JSON.stringify(details));
  }
  
  // Insert to classifications
  for (const c of toClassifications) {
    const details = { ...c };
    delete details.type;
    delete details.address;
    
    stmt.run(txid, c.type, c.address, 'to', JSON.stringify(details));
  }
}

export function getClassificationsForTransaction(txid) {
  return db.prepare(`
    SELECT * FROM tx_classifications 
    WHERE txid = ?
    ORDER BY direction, classification_type
  `).all(txid);
}

export function getClassificationStats() {
  return db.prepare(`
    SELECT 
      classification_type,
      COUNT(*) as count
    FROM tx_classifications
    GROUP BY classification_type
  `).all();
}

// ============================================================================
// SYNC STATE
// ============================================================================

export function setSyncState(key, value) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sync_state (key, value, updated_at)
    VALUES (?, ?, strftime('%s', 'now'))
  `);
  
  stmt.run(key, typeof value === 'string' ? value : JSON.stringify(value));
}

export function getSyncState(key) {
  const result = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
  
  if (!result) return null;
  
  try {
    return JSON.parse(result.value);
  } catch {
    return result.value;
  }
}

// ============================================================================
// STATS
// ============================================================================

export function getDatabaseStats() {
  const blocks = db.prepare('SELECT COUNT(*) as count FROM blocks').get().count;
  const transactions = db.prepare('SELECT COUNT(*) as count FROM transactions').get().count;
  const classifications = db.prepare('SELECT COUNT(*) as count FROM tx_classifications').get().count;
  
  const flowStats = db.prepare(`
    SELECT 
      flow_type,
      COUNT(*) as count,
      SUM(total_value) as total_value
    FROM transactions
    WHERE flow_type IS NOT NULL
    GROUP BY flow_type
  `).all();
  
  return {
    blocks,
    transactions,
    classifications,
    flowStats: flowStats.reduce((acc, stat) => {
      acc[stat.flow_type] = {
        count: stat.count,
        totalValue: parseFloat(stat.total_value)
      };
      return acc;
    }, {})
  };
}

// ============================================================================
// MAINTENANCE
// ============================================================================

export function vacuum() {
  db.exec('VACUUM');
}

export function analyze() {
  db.exec('ANALYZE');
}

export function getDatabaseSize() {
  const result = db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get();
  const bytes = result.size;
  
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}