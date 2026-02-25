// Database Service - UTXO-Aware Flow Tracking with Automatic Cleanup
// PHASE 3: Added hop_chain column and multi-hop query methods

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { FLUX_CONFIG } from '../config.js';

class DatabaseService {
  constructor() {
    const dataDir = path.join(process.cwd(), 'data');
    
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

  initializeDatabase() {
    console.log('📊 Initializing database connection...');
    
    try {
      this.db = new Database(this.dbPath, {
        verbose: process.env.NODE_ENV !== 'production' ? console.log : null,
        timeout: 30000
      });
      
      console.log('✅ Database connection established');
      
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('cache_size = 32768');
      this.db.pragma('busy_timeout = 30000');
      this.db.pragma('wal_autocheckpoint = 1000');
      this.db.pragma('locking_mode = NORMAL');
      
      console.log('✅ WAL mode and pragmas configured');
      
      this.createSchema();
      
      console.log('✅ Database initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize database:', error.message);
      console.error('   Path:', this.dbPath);
      console.error('   CWD:', process.cwd());
      throw error;
    }
  }

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
    
    // Transactions table
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
    
    // Flow events table - PHASE 3: Added hop_chain column
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
        
        -- PHASE 2: Enhancement tracking columns
        classification_level INTEGER DEFAULT 0,
        intermediary_wallet TEXT DEFAULT NULL,
        analysis_timestamp INTEGER DEFAULT NULL,
        data_source TEXT DEFAULT 'sync',
        
        -- PHASE 3: Multi-hop chain tracking
        hop_chain TEXT DEFAULT NULL,
        
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
    
    // PHASE 2/3: Indexes for enhancement and multi-hop
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_classification_level ON flow_events(classification_level)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_data_source ON flow_events(data_source)`);
    
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
      totalInputValue / 100000000,
      totalOutputValue / 100000000
    );
  }

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

  saveFlowEventsBatch(flowEvents) {
    if (!flowEvents || flowEvents.length === 0) return;
    
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO flow_events (
        txid, vout, block_height, block_time,
        from_address, from_type, from_details,
        to_address, to_type, to_details,
        flow_type, amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const batchInsert = this.db.transaction((events) => {
      for (const event of events) {
        insert.run(
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
    
    batchInsert(flowEvents);
  }

  getFlowEvents(startBlock, endBlock) {
    const stmt = this.db.prepare(`
      SELECT 
        id, txid, vout, block_height as blockHeight, block_time as blockTime,
        from_address as fromAddress, from_type as fromType, from_details as fromDetails,
        to_address as toAddress, to_type as toType, to_details as toDetails,
        flow_type as flowType, amount,
        classification_level as classificationLevel,
        intermediary_wallet as intermediaryWallet,
        hop_chain as hopChain,
        analysis_timestamp as analysisTimestamp,
        data_source as dataSource
      FROM flow_events
      WHERE block_height BETWEEN ? AND ?
      ORDER BY block_height DESC, id DESC
    `);
    
    const events = stmt.all(startBlock, endBlock);
    
    return events.map(event => ({
      ...event,
      fromDetails: event.fromDetails ? JSON.parse(event.fromDetails) : null,
      toDetails: event.toDetails ? JSON.parse(event.toDetails) : null,
      hopChain: event.hopChain ? JSON.parse(event.hopChain) : null
    }));
  }

  getFlowEventById(id) {
    const stmt = this.db.prepare(`
      SELECT 
        id, txid, vout, block_height as blockHeight, block_time as blockTime,
        from_address as fromAddress, from_type as fromType, from_details as fromDetails,
        to_address as toAddress, to_type as toType, to_details as toDetails,
        flow_type as flowType, amount,
        classification_level as classificationLevel,
        intermediary_wallet as intermediaryWallet,
        hop_chain as hopChain,
        analysis_timestamp as analysisTimestamp,
        data_source as dataSource
      FROM flow_events
      WHERE id = ?
    `).get(id);
    
    if (!stmt) return null;
    
    return {
      ...stmt,
      fromDetails: stmt.fromDetails ? JSON.parse(stmt.fromDetails) : null,
      toDetails: stmt.toDetails ? JSON.parse(stmt.toDetails) : null,
      hopChain: stmt.hopChain ? JSON.parse(stmt.hopChain) : null
    };
  }

  // PHASE 2: Get unknown wallets to enhance
  // Skips events recently attempted but unresolvable (cooldown from config)
  getUnknownWallets() {
    const retryAfterSeconds = (FLUX_CONFIG.ENHANCEMENT.FAILED_RETRY_HOURS || 24) * 3600;
    const cutoff = Math.floor(Date.now() / 1000) - retryAfterSeconds;

    const buys = this.db.prepare(`
      SELECT
        id, txid, vout,
        block_height, block_time,
        from_address, to_address,
        amount,
        classification_level
      FROM flow_events
      WHERE flow_type = 'buying'
        AND to_type = 'unknown'
        AND classification_level = 0
        AND (analysis_timestamp IS NULL OR analysis_timestamp < ?)
      ORDER BY block_height DESC
      LIMIT 1000
    `).all(cutoff);

    const sells = this.db.prepare(`
      SELECT
        id, txid, vout,
        block_height, block_time,
        from_address, to_address,
        amount,
        classification_level
      FROM flow_events
      WHERE flow_type = 'selling'
        AND from_type = 'unknown'
        AND classification_level = 0
        AND (analysis_timestamp IS NULL OR analysis_timestamp < ?)
      ORDER BY block_height DESC
      LIMIT 1000
    `).all(cutoff);

    return {
      buys,
      sells,
      total: buys.length + sells.length
    };
  }

  // PHASE 2/3: Update flow event classification (supports both 1-hop and multi-hop)
  updateFlowEventClassification(id, updates) {
    const setParts = [];
    const values = [];
    
    if (updates.classificationLevel !== undefined) {
      setParts.push('classification_level = ?');
      values.push(updates.classificationLevel);
    }
    
    if (updates.intermediaryWallet !== undefined) {
      setParts.push('intermediary_wallet = ?');
      values.push(updates.intermediaryWallet);
    }
    
    // PHASE 3: Add hop_chain support
    if (updates.hopChain !== undefined) {
      setParts.push('hop_chain = ?');
      values.push(updates.hopChain ? JSON.stringify(updates.hopChain) : null);
    }
    
    if (updates.analysisTimestamp !== undefined) {
      setParts.push('analysis_timestamp = ?');
      values.push(updates.analysisTimestamp);
    }
    
    if (updates.dataSource !== undefined) {
      setParts.push('data_source = ?');
      values.push(updates.dataSource);
    }
    
    if (updates.fromType !== undefined) {
      setParts.push('from_type = ?');
      values.push(updates.fromType);
    }
    
    if (updates.fromDetails !== undefined) {
      setParts.push('from_details = ?');
      values.push(updates.fromDetails ? JSON.stringify(updates.fromDetails) : null);
    }
    
    if (updates.toType !== undefined) {
      setParts.push('to_type = ?');
      values.push(updates.toType);
    }
    
    if (updates.toDetails !== undefined) {
      setParts.push('to_details = ?');
      values.push(updates.toDetails ? JSON.stringify(updates.toDetails) : null);
    }
    
    if (setParts.length === 0) {
      throw new Error('No updates provided');
    }
    
    values.push(id);
    
    const sql = `UPDATE flow_events SET ${setParts.join(', ')} WHERE id = ?`;
    const stmt = this.db.prepare(sql);
    
    return stmt.run(...values);
  }

  getLatestBlockHeight() {
    const result = this.db.prepare('SELECT MAX(height) as maxHeight FROM blocks').get();
    return result?.maxHeight || 0;
  }

  getBlockCount() {
    return this.db.prepare('SELECT COUNT(*) as count FROM blocks').get().count;
  }

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
    
    // PHASE 2/3: Enhancement statistics
    const enhancementStats = this.db.prepare(`
      SELECT 
        classification_level,
        data_source,
        COUNT(*) as count
      FROM flow_events
      WHERE classification_level > 0
      GROUP BY classification_level, data_source
    `).all();
    
    const result = this.db.prepare(
      "SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()"
    ).get();
    const bytes = result?.size || 0;
    
    let dbSize;
    if (bytes < 1024) dbSize = `${bytes} B`;
    else if (bytes < 1024 * 1024) dbSize = `${(bytes / 1024).toFixed(2)} KB`;
    else if (bytes < 1024 * 1024 * 1024) dbSize = `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    else dbSize = `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    
    const blockRange = this.db.prepare(`
      SELECT MIN(height) as minHeight, MAX(height) as maxHeight
      FROM blocks
    `).get();
    
    return {
      blocks,
      transactions,
      flowEvents,
      flowStats,
      enhancementStats,
      dbSize,
      dbSizeBytes: bytes,
      blockRange: blockRange || { minHeight: 0, maxHeight: 0 }
    };
  }

  cleanupOldData(currentBlock, oneYearBlocks) {
    const targetBlock = Math.max(currentBlock - oneYearBlocks, 1);
    
    console.log(`🧹 Cleaning up data older than block ${targetBlock.toLocaleString()}...`);
    
    const oldBlockCount = this.db.prepare(
      'SELECT COUNT(*) as count FROM blocks WHERE height < ?'
    ).get(targetBlock).count;
    
    if (oldBlockCount === 0) {
      console.log('✓ No old data to clean');
      return { deleted: 0 };
    }
    
    console.log(`  Found ${oldBlockCount.toLocaleString()} old blocks to remove`);
    
    const deleteOldData = this.db.transaction(() => {
      const flowDeleted = this.db.prepare(
        'DELETE FROM flow_events WHERE block_height < ?'
      ).run(targetBlock);
      
      const txDeleted = this.db.prepare(
        'DELETE FROM transactions WHERE block_height < ?'
      ).run(targetBlock);
      
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
    
    console.log('🗜️  Vacuuming database to reclaim space...');
    this.db.exec('VACUUM');
    console.log('✓ Database optimized');
    
    return result;
  }

  checkAndCleanup(currentBlock) {
    const sixMonthBlocks = FLUX_CONFIG.PERIODS['6M'];

    if (currentBlock - this.lastCleanupBlock < 1000) {
      return;
    }

    const stats = this.getStats();
    const blockRange = stats.blockRange;
    const dataSpan = blockRange.maxHeight - blockRange.minHeight;

    if (dataSpan > sixMonthBlocks * 1.1) {
      console.log(`\n⚠️  Database has ${(dataSpan / sixMonthBlocks).toFixed(2)} × 6-months of data (> 1.1 threshold)`);
      this.cleanupOldData(currentBlock, sixMonthBlocks);
      this.lastCleanupBlock = currentBlock;
    }
  }

  optimize() {
    console.log('⚡ Optimizing database...');
    this.db.exec('ANALYZE');
    this.db.exec('VACUUM');
    console.log('✓ Database optimized');
  }

  getTransactionCount() {
    return this.db.prepare('SELECT COUNT(*) as count FROM transactions').get().count;
  }

  setSyncState(key, value) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sync_state (key, value, updated_at)
      VALUES (?, ?, strftime('%s', 'now'))
    `);
    
    stmt.run(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  getSyncState(key) {
    const result = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
    
    if (!result) return null;
    
    try {
      return JSON.parse(result.value);
    } catch {
      return result.value;
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export default DatabaseService;