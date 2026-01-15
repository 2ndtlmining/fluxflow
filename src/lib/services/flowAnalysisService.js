// Flow Analysis Service - UTXO-Aware
// Analyzes flow events (not transactions)

import { getPeriodBlocks } from '../config.js';

class FlowAnalysisService {
  constructor(databaseService) {
    this.db = databaseService;
  }

  /**
   * Get flow events for a specific period
   */
  getFlowEventsForPeriod(period) {
    if (!this.db || !this.db.db) {
      console.error('Database not initialized');
      return [];
    }
    
    const currentHeight = this.db.getLatestBlockHeight();
    if (currentHeight === 0) return [];
    
    const blocksInPeriod = getPeriodBlocks(period);
    const cutoffBlock = currentHeight - blocksInPeriod;
    
    return this.db.getFlowEvents(cutoffBlock, currentHeight);
  }

  /**
   * Analyze flow for a period
   */
  analyzeFlow(period) {
    const flowEvents = this.getFlowEventsForPeriod(period);
    
    const analysis = {
      period: period,
      blockRange: {
        newest: flowEvents[0]?.blockHeight || 0,
        oldest: flowEvents[flowEvents.length - 1]?.blockHeight || 0,
        count: flowEvents.length
      },
      buying: {
        total: 0,
        breakdown: {
          toNodeOperators: 0,
          toUnknown: 0,
          toFoundation: 0
        },
        events: [],
        byExchange: {}
      },
      selling: {
        total: 0,
        breakdown: {
          fromNodeOperators: 0,
          fromUnknown: 0,
          fromFoundation: 0
        },
        events: [],
        byExchange: {}
      },
      p2p: {
        total: 0,
        events: []
      },
      stats: {
        totalEvents: flowEvents.length,
        buyingEvents: 0,
        sellingEvents: 0,
        p2pEvents: 0
      }
    };
    
    // Process each flow event
    for (const event of flowEvents) {
      if (event.flowType === 'buying') {
        analysis.buying.total += event.amount;
        analysis.buying.events.push(event);
        analysis.stats.buyingEvents++;
        
        // Breakdown by destination
        if (event.toType === 'node_operator') {
          analysis.buying.breakdown.toNodeOperators += event.amount;
        } else if (event.toType === 'unknown') {
          analysis.buying.breakdown.toUnknown += event.amount;
        } else if (event.toType === 'foundation') {
          analysis.buying.breakdown.toFoundation += event.amount;
        }
        
        // By exchange
        if (event.fromDetails?.name) {
          const exchangeName = event.fromDetails.name;
          if (!analysis.buying.byExchange[exchangeName]) {
            analysis.buying.byExchange[exchangeName] = {
              name: exchangeName,
              total: 0,
              count: 0
            };
          }
          analysis.buying.byExchange[exchangeName].total += event.amount;
          analysis.buying.byExchange[exchangeName].count++;
        }
        
      } else if (event.flowType === 'selling') {
        analysis.selling.total += event.amount;
        analysis.selling.events.push(event);
        analysis.stats.sellingEvents++;
        
        // Breakdown by source
        if (event.fromType === 'node_operator') {
          analysis.selling.breakdown.fromNodeOperators += event.amount;
        } else if (event.fromType === 'unknown') {
          analysis.selling.breakdown.fromUnknown += event.amount;
        } else if (event.fromType === 'foundation') {
          analysis.selling.breakdown.fromFoundation += event.amount;
        }
        
        // By exchange
        if (event.toDetails?.name) {
          const exchangeName = event.toDetails.name;
          if (!analysis.selling.byExchange[exchangeName]) {
            analysis.selling.byExchange[exchangeName] = {
              name: exchangeName,
              total: 0,
              count: 0
            };
          }
          analysis.selling.byExchange[exchangeName].total += event.amount;
          analysis.selling.byExchange[exchangeName].count++;
        }
        
      } else if (event.flowType === 'p2p') {
        analysis.p2p.total += event.amount;
        analysis.p2p.events.push(event);
        analysis.stats.p2pEvents++;
      }
    }
    
    // Calculate net flow (buying - selling)
    analysis.netFlow = analysis.buying.total - analysis.selling.total;
    
    return analysis;
  }

  /**
   * Get top buyers (addresses receiving from exchanges)
   */
  getTopBuyers(period, limit = 10) {
    const flowEvents = this.getFlowEventsForPeriod(period)
      .filter(e => e.flowType === 'buying');
    
    // Aggregate by destination address
    const buyers = new Map();
    
    for (const event of flowEvents) {
      const key = event.toAddress;
      if (!buyers.has(key)) {
        buyers.set(key, {
          address: key,
          type: event.toType,
          totalBought: 0,
          eventCount: 0,
          exchanges: new Set()
        });
      }
      
      const buyer = buyers.get(key);
      buyer.totalBought += event.amount;
      buyer.eventCount++;
      
      if (event.fromDetails?.name) {
        buyer.exchanges.add(event.fromDetails.name);
      }
    }
    
    // Convert to array and sort
    return Array.from(buyers.values())
      .sort((a, b) => b.totalBought - a.totalBought)
      .slice(0, limit)
      .map(b => ({
        ...b,
        exchanges: Array.from(b.exchanges)
      }));
  }

  /**
   * Get top sellers (addresses sending to exchanges)
   */
  getTopSellers(period, limit = 10) {
    const flowEvents = this.getFlowEventsForPeriod(period)
      .filter(e => e.flowType === 'selling');
    
    // Aggregate by source address
    const sellers = new Map();
    
    for (const event of flowEvents) {
      const key = event.fromAddress;
      if (!sellers.has(key)) {
        sellers.set(key, {
          address: key,
          type: event.fromType,
          totalSold: 0,
          eventCount: 0,
          exchanges: new Set()
        });
      }
      
      const seller = sellers.get(key);
      seller.totalSold += event.amount;
      seller.eventCount++;
      
      if (event.toDetails?.name) {
        seller.exchanges.add(event.toDetails.name);
      }
    }
    
    // Convert to array and sort
    return Array.from(sellers.values())
      .sort((a, b) => b.totalSold - a.totalSold)
      .slice(0, limit)
      .map(s => ({
        ...s,
        exchanges: Array.from(s.exchanges)
      }));
  }

  /**
   * Get current state summary
   */
  getState() {
    if (!this.db || !this.db.db) {
      return {
        eventCount: 0,
        blockRange: { newest: 0, oldest: 0 }
      };
    }
    
    const stats = this.db.getStats();
    
    return {
      eventCount: stats.flowEvents,
      blockRange: {
        newest: this.db.getLatestBlockHeight(),
        oldest: 0
      }
    };
  }
}

export default FlowAnalysisService;