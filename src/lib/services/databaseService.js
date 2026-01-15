// Database Service - UTXO-Aware Flow Tracking with Automatic Cleanup
// Tracks individual outputs (vout) and maintains rolling 1-year window
// UPDATED: Added batch insert methods to prevent DB locks

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { FLUX_CONFIG } from '../config.js';

class DatabaseService {
  constructor() {
    // Use the SAME pattern as your working Flux Performance Dashboard
    const dataDir = path.join(process.cwd(), 'data');
    
    // Ensure data directory exists BEFORE creating database
    if (!fs.existsSync(dataDir)) {
      console.log(`📁 Creating data directory: ${dataDir}`);
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    this.dbPath = path.join(dataDir, 'flux-flow.db');
    this.db = null;
    this.lastCleanupBlock = 0;
    
    console.log(`📂 DatabaseService: Using database path: ${this.dbPath}`);
    console.log(`📂 Current working directory: ${process.cwd()}`);
    
    this.initializeDatabase();
  }

  /**
   * Initialize database connection and schema
   */
  initializeDatabase() {
    console.log('📊 Initializing database connection...');
    
    try {
      // Open database - directory is already guaranteed to exist
      this.db = new Database(this.dbPath, {
        verbose: process.env.NODE_ENV !== 'production' ? console.log : null,
        timeout: 30000  // 30 second timeout like your working project
      });
      
      console.log('✅ Database connection established');
      
      // Use the SAME pragma settings as your working project
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('cache_size = 32768');
      this.db.pragma('busy_timeout = 30000');
      this.db.pragma('wal_autocheckpoint = 1000');
      this.db.pragma('locking_mode = NORMAL');
      
      console.log('✅ WAL mode and pragmas configured');
      
      // Create schema
      this.createSchema();
      
      console.log('✅ Database initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize database:', error.message);
      console.error('   Path:', this.dbPath);
      console.error('   CWD:', process.cwd());
      throw error;
    }
  }

  /**
   * Create database schema
   */
  createSchema() {
    console.log('📋 Creating database schema...');
    
    // Blocks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        height INTEGER PRIMARY KEY,
        hash TEXT NOT NULL,
        time INTEGER NOT NULL,
        tx_count INTEGER NOT NULL,
        size INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_time ON blocks(time)`);
    
    // Transactions table (stores raw transaction data)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        txid TEXT PRIMARY KEY,
        block_height INTEGER NOT NULL,
        block_time INTEGER NOT NULL,
        input_count INTEGER NOT NULL,
        output_count INTEGER NOT NULL,
        total_input_value REAL NOT NULL,
        total_output_value REAL NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (block_height) REFERENCES blocks(height)
      )
    `);
    
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tx_block ON transactions(block_height)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tx_time ON transactions(block_time)`);
    
    // Flow events table (one row per output involving an exchange)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS flow_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        txid TEXT NOT NULL,
        vout INTEGER NOT NULL,
        block_height INTEGER NOT NULL,
        block_time INTEGER NOT NULL,
        
        from_address TEXT NOT NULL,
        from_type TEXT NOT NULL,
        from_details TEXT,
        
        to_address TEXT NOT NULL,
        to_type TEXT NOT NULL,
        to_details TEXT,
        
        flow_type TEXT NOT NULL,
        amount REAL NOT NULL,
        
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        
        FOREIGN KEY (txid) REFERENCES transactions(txid),
        UNIQUE(txid, vout)
      )
    `);
    
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_block ON flow_events(block_height)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_time ON flow_events(block_time)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_type ON flow_events(flow_type)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_from_type ON flow_events(from_type)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_to_type ON flow_events(to_type)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_from_addr ON flow_events(from_address)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_to_addr ON flow_events(to_address)`);
    
    // Sync state table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    
    console.log('✅ Database schema created/verified');
  }

  /**
   * Insert a block
   */
  saveBlock(block) {
    const stmt = this.db.prepare(`
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

  /**
   * Insert a transaction
   */
  saveTransaction(tx) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO transactions (
        txid, block_height, block_time, 
        input_count, output_count, 
        total_input_value, total_output_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    const totalInputValue = tx.vin?.reduce((sum, input) => sum + (parseFloat(input.value) || 0), 0) || 0;
    const totalOutputValue = tx.vout?.reduce((sum, output) => sum + (parseFloat(output.value) || 0), 0) || 0;
    
    stmt.run(
      tx.txid,
      tx.blockHeight,
      tx.blockTime,
      tx.vin?.length || 0,
      tx.vout?.length || 0,
      totalInputValue / 100000000, // Convert from satoshis
      totalOutputValue / 100000000
    );
  }

  /**
   * Insert a flow event (single)
   * NOTE: For batch processing, use saveFlowEventsBatch() instead
   */
  saveFlowEvent(flowEvent) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO flow_events (
        txid, vout, block_height, block_time,
        from_address, from_type, from_details,
        to_address, to_type, to_details,
        flow_type, amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      flowEvent.txid,
      flowEvent.vout,
      flowEvent.blockHeight,
      flowEvent.blockTime,
      flowEvent.fromAddress,
      flowEvent.fromType,
      flowEvent.fromDetails ? JSON.stringify(flowEvent.fromDetails) : null,
      flowEvent.toAddress,
      flowEvent.toType,
      flowEvent.toDetails ? JSON.stringify(flowEvent.toDetails) : null,
      flowEvent.flowType,
      flowEvent.amount
    );
  }

  /**
   * NEW: Batch insert flow events - PREVENTS DB LOCKS
   * 
   * This is the KEY optimization that prevents database locks.
   * Instead of 100 separate transactions (one per event), this does
   * ONE transaction for all events = 100x faster and no lock contention.
   */
  saveFlowEventsBatch(flowEvents) {
    if (!flowEvents || flowEvents.length === 0) {
      return;
    }
    
    // Use a transaction wrapper - ALL inserts happen in ONE transaction
    const insertMany = this.db.transaction((events) => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO flow_events (
          txid, vout, block_height, block_time,
          from_address, from_type, from_details,
          to_address, to_type, to_details,
          flow_type, amount
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      for (const event of events) {
        stmt.run(
          event.txid,
          event.vout,
          event.blockHeight,
          event.blockTime,
          event.fromAddress,
          event.fromType,
          event.fromDetails ? JSON.stringify(event.fromDetails) : null,
          event.toAddress,
          event.toType,
          event.toDetails ? JSON.stringify(event.toDetails) : null,
          event.flowType,
          event.amount
        );
      }
    });
    
    // Execute the transaction
    insertMany(flowEvents);
  }

  /**
   * Get flow events for a period
   */
  getFlowEvents(startBlock, endBlock) {
    const stmt = this.db.prepare(`
      SELECT 
        id,
        txid,
        vout,
        block_height as blockHeight,
        block_time as blockTime,
        from_address as fromAddress,
        from_type as fromType,
        from_details as fromDetails,
        to_address as toAddress,
        to_type as toType,
        to_details as toDetails,
        flow_type as flowType,
        amount
      FROM flow_events
      WHERE block_height BETWEEN ? AND ?
      ORDER BY block_time DESC
    `);
    
    return stmt.all(startBlock, endBlock).map(event => ({
      ...event,
      fromDetails: event.fromDetails ? JSON.parse(event.fromDetails) : null,
      toDetails: event.toDetails ? JSON.parse(event.toDetails) : null
    }));
  }

  /**
   * Get latest block height
   */
  getLatestBlockHeight() {
    const result = this.db.prepare('SELECT MAX(height) as height FROM blocks').get();
    return result?.height || 0;
  }

  /**
   * Get database stats
   */
  getStats() {
    const blocks = this.db.prepare('SELECT COUNT(*) as count FROM blocks').get().count;
    const transactions = this.db.prepare('SELECT COUNT(*) as count FROM transactions').get().count;
    const flowEvents = this.db.prepare('SELECT COUNT(*) as count FROM flow_events').get().count;
    
    const flowStats = this.db.prepare(`
      SELECT 
        flow_type,
        COUNT(*) as count,
        SUM(amount) as total_amount
      FROM flow_events
      GROUP BY flow_type
    `).all();
    
    // Get database size
    const sizeResult = this.db.prepare(`
      SELECT page_count * page_size as size 
      FROM pragma_page_count(), pragma_page_size()
    `).get();
    
    const bytes = sizeResult.size;
    let dbSize;
    if (bytes < 1024) dbSize = `${bytes} B`;
    else if (bytes < 1024 * 1024) dbSize = `${(bytes / 1024).toFixed(2)} KB`;
    else if (bytes < 1024 * 1024 * 1024) dbSize = `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    else dbSize = `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    
    // Get block range for age calculation
    const blockRange = this.db.prepare(`
      SELECT MIN(height) as minHeight, MAX(height) as maxHeight
      FROM blocks
    `).get();
    
    return {
      blocks,
      transactions,
      flowEvents,
      flowStats,
      dbSize,
      dbSizeBytes: bytes,
      blockRange: blockRange || { minHeight: 0, maxHeight: 0 }
    };
  }

  /**
   * Clean up old data beyond 1 year
   * Maintains rolling 1-year window
   */
  cleanupOldData(currentBlock, oneYearBlocks) {
    const targetBlock = Math.max(currentBlock - oneYearBlocks, 1);
    
    console.log(`🧹 Cleaning up data older than block ${targetBlock.toLocaleString()}...`);
    
    // Get count of blocks to delete
    const oldBlockCount = this.db.prepare(
      'SELECT COUNT(*) as count FROM blocks WHERE height < ?'
    ).get(targetBlock).count;
    
    if (oldBlockCount === 0) {
      console.log('✓ No old data to clean');
      return { deleted: 0 };
    }
    
    console.log(`  Found ${oldBlockCount.toLocaleString()} old blocks to remove`);
    
    // Delete in a transaction for atomicity
    const deleteOldData = this.db.transaction(() => {
      // Delete old flow events
      const flowDeleted = this.db.prepare(
        'DELETE FROM flow_events WHERE block_height < ?'
      ).run(targetBlock);
      
      // Delete old transactions
      const txDeleted = this.db.prepare(
        'DELETE FROM transactions WHERE block_height < ?'
      ).run(targetBlock);
      
      // Delete old blocks
      const blocksDeleted = this.db.prepare(
        'DELETE FROM blocks WHERE height < ?'
      ).run(targetBlock);
      
      return {
        blocks: blocksDeleted.changes,
        transactions: txDeleted.changes,
        flowEvents: flowDeleted.changes
      };
    });
    
    const result = deleteOldData();
    
    console.log(`✓ Cleanup complete:`);
    console.log(`  - Blocks: ${result.blocks.toLocaleString()}`);
    console.log(`  - Transactions: ${result.transactions.toLocaleString()}`);
    console.log(`  - Flow Events: ${result.flowEvents.toLocaleString()}`);
    
    // Run VACUUM to reclaim space
    console.log('🗜️  Vacuuming database to reclaim space...');
    this.db.exec('VACUUM');
    console.log('✓ Database optimized');
    
    return result;
  }

  /**
   * Check if cleanup is needed and run it
   * Call this periodically (e.g., after syncing blocks)
   */
  checkAndCleanup(currentBlock) {
    const oneYearBlocks = FLUX_CONFIG.PERIODS['1Y'];
    
    // Only cleanup every 1000 blocks (avoid too frequent cleanups)
    if (currentBlock - this.lastCleanupBlock < 1000) {
      return;
    }
    
    // Check if we have more than 1.1 years of data (add 10% buffer)
    const stats = this.getStats();
    const blockRange = stats.blockRange;
    const dataSpan = blockRange.maxHeight - blockRange.minHeight;
    
    if (dataSpan > oneYearBlocks * 1.1) {
      console.log(`\n⚠️  Database has ${(dataSpan / oneYearBlocks).toFixed(2)} years of data (> 1.1 year threshold)`);
      this.cleanupOldData(currentBlock, oneYearBlocks);
      this.lastCleanupBlock = currentBlock;
    }
  }

  /**
   * Optimize database (run ANALYZE and VACUUM)
   */
  optimize() {
    console.log('⚡ Optimizing database...');
    this.db.exec('ANALYZE');
    this.db.exec('VACUUM');
    console.log('✓ Database optimized');
  }

  /**
   * Get transaction count
   */
  getTransactionCount() {
    return this.db.prepare('SELECT COUNT(*) as count FROM transactions').get().count;
  }

  /**
   * Set sync state
   */
  setSyncState(key, value) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sync_state (key, value, updated_at)
      VALUES (?, ?, strftime('%s', 'now'))
    `);
    
    stmt.run(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  /**
   * Get sync state
   */
  getSyncState(key) {
    const result = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
    
    if (!result) return null;
    
    try {
      return JSON.parse(result.value);
    } catch {
      return result.value;
    }
  }

  /**
   * Close database
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export default DatabaseService;