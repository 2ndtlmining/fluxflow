// Wallet classification service
// Classifies addresses as Exchanges, Foundation, Node Operators, or Unknown

import { FLUX_CONFIG } from '../config.js';
import { readFileSync } from 'fs';

class ClassificationService {
  constructor() {
    this.exchanges = new Map();  // address -> {name, logo}
    this.foundation = new Set();
    this.nodeOperators = new Map();  // address -> {nodeCount, tiers, totalCollateral}
    this.lastNodeRefresh = 0;
    
    this.loadExchangeConfig();
  }

  /**
   * Load exchange and foundation addresses from config file
   */
  loadExchangeConfig() {
    try {
      const config = JSON.parse(
        readFileSync(FLUX_CONFIG.EXCHANGES_CONFIG_PATH, 'utf-8')
      );
      
      // Load exchanges
      if (config.exchanges) {
        for (const exchange of config.exchanges) {
          for (const address of exchange.addresses) {
            this.exchanges.set(address, {
              name: exchange.name,
              logo: exchange.logo
            });
          }
        }
        console.log(`Loaded ${this.exchanges.size} exchange addresses from ${config.exchanges.length} exchanges`);
      }
      
      // Load foundation
      if (config.foundation && config.foundation.addresses) {
        for (const address of config.foundation.addresses) {
          this.foundation.add(address);
        }
        console.log(`Loaded ${this.foundation.size} foundation addresses`);
      }
      
    } catch (error) {
      console.error('Error loading exchange config:', error.message);
    }
  }

  /**
   * Fetch and update node operator data from Flux API
   */
  async refreshNodeOperators() {
    try {
      console.log('Refreshing node operator data...');
      
      const response = await fetch(FLUX_CONFIG.FLUX_NODES_API);
      
      if (!response.ok) {
        throw new Error(`API returned status ${response.status}`);
      }
      
      const text = await response.text();
      let data;
      
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error('Failed to parse node operator API response as JSON');
        return 0;
      }
      
      // Handle different possible response formats
      let nodes = null;
      
      // Check for FluxNodes (uppercase F) or fluxNodes (lowercase f)
      if (data && (data.FluxNodes || data.fluxNodes)) {
        nodes = data.FluxNodes || data.fluxNodes;
        console.log('✓ Found node array with', Array.isArray(nodes) ? nodes.length : 'invalid', 'nodes');
      }
      // Check if response is directly an array
      else if (Array.isArray(data)) {
        nodes = data;
        console.log('✓ Response is direct array with', nodes.length, 'nodes');
      }
      
      if (!nodes || !Array.isArray(nodes) || nodes.length === 0) {
        console.warn('❌ Could not find valid node array in API response');
        return 0;
      }
      
      // Clear existing data
      this.nodeOperators.clear();
      
      // Aggregate by payment address
      for (const node of nodes) {
        const addr = node.payment_address;
        
        if (!addr) continue; // Skip nodes without payment address
        
        if (!this.nodeOperators.has(addr)) {
          this.nodeOperators.set(addr, {
            address: addr,
            nodes: [],
            tiers: { CUMULUS: 0, NIMBUS: 0, STRATUS: 0 },
            totalCollateral: 0
          });
        }
        
        const operator = this.nodeOperators.get(addr);
        operator.nodes.push(node);
        
        // Count tier
        const tier = node.tier || 'CUMULUS';
        operator.tiers[tier] = (operator.tiers[tier] || 0) + 1;
        
        // Add collateral
        const collateral = parseFloat(node.collateral) || 0;
        operator.totalCollateral += collateral;
      }
      
      this.lastNodeRefresh = Date.now();
      
      console.log(`✓ Refreshed node operators: ${this.nodeOperators.size} unique operators with ${nodes.length} total nodes`);
      
      // Log tier distribution
      const tierStats = { CUMULUS: 0, NIMBUS: 0, STRATUS: 0 };
      for (const op of this.nodeOperators.values()) {
        tierStats.CUMULUS += op.tiers.CUMULUS || 0;
        tierStats.NIMBUS += op.tiers.NIMBUS || 0;
        tierStats.STRATUS += op.tiers.STRATUS || 0;
      }
      console.log(`  Tier distribution: ${tierStats.CUMULUS} Cumulus, ${tierStats.NIMBUS} Nimbus, ${tierStats.STRATUS} Stratus`);
      
      return this.nodeOperators.size;
      
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error('Node operator API request timed out');
      } else {
        console.error('Error refreshing node operators:', error.message);
      }
      
      // Don't throw - just log the error and continue without node operator data
      console.warn('⚠ Continuing without node operator data. Classification will work for exchanges and foundation only.');
      return 0;
    }
  }

  /**
   * Check if node operator data needs refresh (time-based, every 10 minutes)
   */
  async checkNodeRefresh() {
    const TEN_MINUTES_MS = 10 * 60 * 1000;
    const needsRefresh = this.nodeOperators.size === 0 || (Date.now() - this.lastNodeRefresh) >= TEN_MINUTES_MS;

    if (needsRefresh) {
      try {
        await this.refreshNodeOperators();
      } catch (error) {
        console.warn('Failed to refresh node operators, will retry later');
      }
    }
  }

  /**
   * Classify a single address
   */
  classifyAddress(address) {
    // Check exchanges first (most specific)
    if (this.exchanges.has(address)) {
      const exchange = this.exchanges.get(address);
      return {
        type: 'exchange',
        name: exchange.name,
        logo: exchange.logo,
        address: address
      };
    }
    
    // Check foundation
    if (this.foundation.has(address)) {
      return {
        type: 'foundation',
        name: 'Flux Foundation',
        address: address
      };
    }
    
    // Check node operators
    if (this.nodeOperators.has(address)) {
      const operator = this.nodeOperators.get(address);
      return {
        type: 'node_operator',
        address: address,
        nodeCount: operator.nodes.length,
        tiers: operator.tiers,
        totalCollateral: operator.totalCollateral
      };
    }
    
    // Unknown
    return {
      type: 'unknown',
      address: address
    };
  }

  /**
   * Classify a transaction (determines flow direction)
   */
  classifyTransaction(transaction) {
    // Classify all from addresses
    const fromClassifications = transaction.from.map(addr => this.classifyAddress(addr));
    
    // Classify all to addresses  
    const toClassifications = transaction.to.map(addr => this.classifyAddress(addr));
    
    // Determine primary flow
    const hasExchangeFrom = fromClassifications.some(c => c.type === 'exchange');
    const hasExchangeTo = toClassifications.some(c => c.type === 'exchange');
    
    let flowDirection = null;
    let flowType = null;
    
    if (hasExchangeTo && !hasExchangeFrom) {
      // Moving TO exchange = SELLING
      flowDirection = 'to_exchange';
      flowType = 'sell';
    } else if (hasExchangeFrom && !hasExchangeTo) {
      // Moving FROM exchange = BUYING
      flowDirection = 'from_exchange';
      flowType = 'buy';
    } else if (hasExchangeFrom && hasExchangeTo) {
      // Exchange to exchange = transfer
      flowDirection = 'exchange_to_exchange';
      flowType = 'transfer';
    }
    
    return {
      txid: transaction.txid,
      blockHeight: transaction.blockHeight,
      blockTime: transaction.blockTime,
      value: transaction.totalValue,
      from: fromClassifications,
      to: toClassifications,
      flowDirection: flowDirection,
      flowType: flowType
    };
  }

  /**
   * Get classification statistics
   */
  getStats() {
    return {
      exchanges: {
        count: this.exchanges.size,
        list: Array.from(this.exchanges.values()).map(e => e.name)
      },
      foundation: {
        count: this.foundation.size
      },
      nodeOperators: {
        count: this.nodeOperators.size,
        totalNodes: Array.from(this.nodeOperators.values()).reduce((sum, op) => sum + op.nodes.length, 0),
        lastRefresh: this.lastNodeRefresh
      }
    };
  }

  /**
   * Get top node operators by node count
   */
  getTopNodeOperators(limit = 10) {
    const operators = Array.from(this.nodeOperators.values());
    operators.sort((a, b) => b.nodes.length - a.nodes.length);
    return operators.slice(0, limit);
  }
}

export default ClassificationService;