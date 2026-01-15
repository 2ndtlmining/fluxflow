/**
 * FLOW QUERIES - Business-specific database queries
 * 
 * Similar to Fluxtracker's snapshot.js - domain-specific queries
 */

import { getDatabase } from './database.js';

/**
 * Get all transactions for a period with classifications
 */
export function getFlowTransactionsForPeriod(startBlock, endBlock) {
  const db = getDatabase();
  
  const transactions = db.prepare(`
    SELECT 
      t.txid,
      t.block_height as blockHeight,
      t.block_time as blockTime,
      t.total_value as value,
      t.flow_type as flowType,
      t.flow_direction as flowDirection
    FROM transactions t
    WHERE t.block_height BETWEEN ? AND ?
      AND t.flow_type IS NOT NULL
    ORDER BY t.block_height DESC
  `).all(startBlock, endBlock);
  
  // Load classifications for each transaction
  const classStmt = db.prepare(`
    SELECT 
      classification_type,
      address,
      direction,
      details
    FROM tx_classifications
    WHERE txid = ?
  `);
  
  return transactions.map(tx => {
    const classifications = classStmt.all(tx.txid);
    
    const from = classifications
      .filter(c => c.direction === 'from')
      .map(c => ({
        type: c.classification_type,
        address: c.address,
        ...(c.details ? JSON.parse(c.details) : {})
      }));
      
    const to = classifications
      .filter(c => c.direction === 'to')
      .map(c => ({
        type: c.classification_type,
        address: c.address,
        ...(c.details ? JSON.parse(c.details) : {})
      }));
    
    return {
      ...tx,
      value: parseFloat(tx.value),
      from,
      to
    };
  });
}

/**
 * Get buying transactions (from exchanges)
 */
export function getBuyingTransactions(startBlock, endBlock, limit = 100) {
  return getFlowTransactionsForPeriod(startBlock, endBlock)
    .filter(tx => tx.flowType === 'buy')
    .slice(0, limit);
}

/**
 * Get selling transactions (to exchanges)
 */
export function getSellingTransactions(startBlock, endBlock, limit = 100) {
  return getFlowTransactionsForPeriod(startBlock, endBlock)
    .filter(tx => tx.flowType === 'sell')
    .slice(0, limit);
}

/**
 * Get flow summary for period
 */
export function getFlowSummary(startBlock, endBlock) {
  const db = getDatabase();
  
  const summary = db.prepare(`
    SELECT 
      flow_type,
      COUNT(*) as count,
      SUM(total_value) as total_value
    FROM transactions
    WHERE block_height BETWEEN ? AND ?
      AND flow_type IS NOT NULL
    GROUP BY flow_type
  `).all(startBlock, endBlock);
  
  const result = {
    buy: { count: 0, value: 0 },
    sell: { count: 0, value: 0 },
    transfer: { count: 0, value: 0 }
  };
  
  for (const row of summary) {
    result[row.flow_type] = {
      count: row.count,
      value: parseFloat(row.total_value)
    };
  }
  
  return result;
}

/**
 * Get top buyers (addresses receiving from exchanges)
 */
export function getTopBuyers(startBlock, endBlock, limit = 10) {
  const db = getDatabase();
  
  return db.prepare(`
    SELECT 
      tc.address,
      tc.classification_type as type,
      COUNT(DISTINCT t.txid) as transaction_count,
      SUM(t.total_value) as total_bought
    FROM transactions t
    JOIN tx_classifications tc ON t.txid = tc.txid
    WHERE t.block_height BETWEEN ? AND ?
      AND t.flow_type = 'buy'
      AND tc.direction = 'to'
      AND tc.classification_type != 'exchange'
    GROUP BY tc.address
    ORDER BY total_bought DESC
    LIMIT ?
  `).all(startBlock, endBlock, limit);
}

/**
 * Get top sellers (addresses sending to exchanges)
 */
export function getTopSellers(startBlock, endBlock, limit = 10) {
  const db = getDatabase();
  
  return db.prepare(`
    SELECT 
      tc.address,
      tc.classification_type as type,
      COUNT(DISTINCT t.txid) as transaction_count,
      SUM(t.total_value) as total_sold
    FROM transactions t
    JOIN tx_classifications tc ON t.txid = tc.txid
    WHERE t.block_height BETWEEN ? AND ?
      AND t.flow_type = 'sell'
      AND tc.direction = 'from'
      AND tc.classification_type != 'exchange'
    GROUP BY tc.address
    ORDER BY total_sold DESC
    LIMIT ?
  `).all(startBlock, endBlock, limit);
}

/**
 * Get exchange activity summary
 */
export function getExchangeActivity(startBlock, endBlock) {
  const db = getDatabase();
  
  return db.prepare(`
    SELECT 
      tc.address as exchange_address,
      JSON_EXTRACT(tc.details, '$.name') as exchange_name,
      SUM(CASE WHEN tc.direction = 'to' AND t.flow_type = 'sell' THEN t.total_value ELSE 0 END) as total_inflow,
      SUM(CASE WHEN tc.direction = 'from' AND t.flow_type = 'buy' THEN t.total_value ELSE 0 END) as total_outflow,
      COUNT(DISTINCT CASE WHEN tc.direction = 'to' THEN t.txid END) as sell_transactions,
      COUNT(DISTINCT CASE WHEN tc.direction = 'from' THEN t.txid END) as buy_transactions
    FROM transactions t
    JOIN tx_classifications tc ON t.txid = tc.txid
    WHERE t.block_height BETWEEN ? AND ?
      AND tc.classification_type = 'exchange'
      AND t.flow_type IN ('buy', 'sell')
    GROUP BY tc.address
    ORDER BY (total_inflow + total_outflow) DESC
  `).all(startBlock, endBlock);
}