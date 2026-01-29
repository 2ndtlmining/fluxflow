<script>
  import { Info } from 'lucide-svelte';
  
  export let transactions = [];
  export let title = 'Flow Event Details';
  export let type = 'selling';
  
  $: events = transactions;
  
  function shortenTxid(txid) {
    if (!txid) return '';
    return `${txid.substring(0, 8)}...${txid.substring(txid.length - 6)}`;
  }
  
  function shortenAddress(address) {
    if (!address) return '';
    return `${address.substring(0, 8)}...${address.substring(address.length - 6)}`;
  }
  
  function getExchangeName(event) {
    if (type === 'selling') {
      return event.toDetails?.name || 'Unknown Exchange';
    } else if (type === 'buying') {
      return event.fromDetails?.name || 'Unknown Exchange';
    }
    return 'N/A';
  }
  
  function getExchangeLogo(exchangeName) {
    if (!exchangeName || exchangeName === 'Unknown Exchange' || exchangeName === 'N/A') {
      return null;
    }
    const filename = exchangeName.toLowerCase() + '.png';
    return `/logos/${filename}`;
  }
  
  function getWalletAddress(event) {
    return type === 'selling' ? event.fromAddress : event.toAddress;
  }
  
  function getWalletType(event) {
    const walletType = type === 'selling' ? event.fromType : event.toType;
    return walletType === 'node' ? 'node_operator' : walletType;
  }
  
  function getWalletDetails(event) {
    return type === 'selling' ? event.fromDetails : event.toDetails;
  }
  
  function getWalletTypeDisplay(walletType) {
    const typeMap = {
      'node_operator': 'Node Operator',
      'node': 'Node Operator',
      'exchange': 'Exchange',
      'foundation': 'Foundation',
      'unknown': 'Unknown Wallet'
    };
    return typeMap[walletType] || walletType;
  }
  
  function getNodeCount(event) {
    const details = getWalletDetails(event);
    return details?.nodeCount || 0;
  }
  
  function getNodeTiers(event) {
    const details = getWalletDetails(event);
    return details?.tiers || { CUMULUS: 0, NIMBUS: 0, STRATUS: 0 };
  }
  
  // PHASE 3+: Get classification level (0, 1, 2, 3)
  function getClassificationLevel(event) {
    return event.classificationLevel || event.classification_level || 0;
  }
  
  // PHASE 3+: Check if enhanced (any level > 0)
  function isEnhanced(event) {
    return getClassificationLevel(event) > 0 || 
           event.dataSource === 'enhanced' ||
           event.data_source === 'enhanced';
  }
  
  // PHASE 3+: Get hop chain (array of intermediary wallets)
  function getHopChain(event) {
    const chain = event.hopChain || event.hop_chain;
    if (!chain) return null;
    
    // Parse if string
    if (typeof chain === 'string') {
      try {
        return JSON.parse(chain);
      } catch {
        return null;
      }
    }
    
    return Array.isArray(chain) ? chain : null;
  }
  
  // PHASE 3+: Get actual node wallet from details
  function getActualNodeWallet(event) {
    const details = getWalletDetails(event);
    return details?.nodeWallet || details?.node_wallet;
  }
  
  // PHASE 5+: Get detection method
  function getDetectionMethod(event) {
    const details = getWalletDetails(event);
    return details?.detectionMethod || details?.detection_method || 'current_api';
  }
  
  // PHASE 5+: Get detection status
  function getDetectionStatus(event) {
    const details = getWalletDetails(event);
    return details?.status || 'active';
  }
  
  // PHASE 5.1: Get historical connection info
  function getHistoricalConnectionInfo(event) {
    const details = getWalletDetails(event);
    const method = getDetectionMethod(event);
    
    if (method === 'historical_connection') {
      return {
        nodeWallet: details?.nodeWallet,
        txid: details?.connectionTxid,
        daysAgo: details?.daysAgo,
        status: details?.status
      };
    }
    
    if (method === 'historical_coinbase') {
      return {
        nodeWallet: details?.nodeWallet,
        coinbaseCount: details?.coinbaseCount,
        daysInactive: details?.daysInactive
      };
    }
    
    return null;
  }
  
  // PHASE 3+: Build wallet display hierarchy
  function buildWalletHierarchy(event) {
    const level = getClassificationLevel(event);
    const chain = getHopChain(event);
    const nodeWallet = getActualNodeWallet(event);
    const directWallet = getWalletAddress(event);
    const method = getDetectionMethod(event);
    const historicalInfo = getHistoricalConnectionInfo(event);
    
    // Level 0 with historical connection or coinbase
    if (level === 0 && (method === 'historical_connection' || method === 'historical_coinbase')) {
      return {
        type: 'historical',
        directWallet: directWallet,
        nodeWallet: historicalInfo?.nodeWallet || nodeWallet,
        method: method,
        info: historicalInfo
      };
    }
    
    // Multi-hop (Level 1, 2, 3)
    if (level > 0 && chain && chain.length > 0) {
      return {
        type: 'multi-hop',
        chain: chain,
        nodeWallet: nodeWallet || directWallet,
        level: level,
        method: method
      };
    }
    
    // Direct (Level 0, no enhancement)
    return {
      type: 'direct',
      wallet: directWallet
    };
  }
  
  // PHASE 3+: Get badge info
  function getBadgeInfo(event) {
    const level = getClassificationLevel(event);
    const method = getDetectionMethod(event);
    const status = getDetectionStatus(event);
    
    if (!isEnhanced(event)) return null;
    
    const badges = {
      level: level,
      method: method,
      status: status,
      label: `L${level}`,
      title: `Level ${level} Detection`,
      description: ''
    };
    
    // Build description
    if (method === 'historical_coinbase') {
      badges.description = `Historical node operator (coinbase detected)`;
    } else if (method === 'historical_connection') {
      badges.description = `Historical connection to node operator`;
    } else if (method === 'current_api') {
      badges.description = `Active node operator`;
    }
    
    if (level === 0) {
      badges.description = badges.description + ' (direct)';
    } else {
      badges.description = badges.description + ` (${level}-hop)`;
    }
    
    return badges;
  }
  
  // Debug helper
  $: if (events.length > 0 && events[0]) {
    console.log('📊 Transaction Table - First Event:', {
      classificationLevel: getClassificationLevel(events[0]),
      hopChain: getHopChain(events[0]),
      detectionMethod: getDetectionMethod(events[0]),
      hierarchy: buildWalletHierarchy(events[0]),
      badge: getBadgeInfo(events[0])
    });
  }
</script>

<div class="transaction-table-container">
  <div class="table-header">
    <h3>{title}</h3>
    <span class="event-count">{events.length} event{events.length !== 1 ? 's' : ''}</span>
  </div>
  
  {#if events.length === 0}
    <div class="no-data">
      <p>No transactions found for this period</p>
    </div>
  {:else}
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>Transaction</th>
            <th>Amount</th>
            <th>Exchange</th>
            <th>Wallet</th>
            <th>Type</th>
            <th>Block</th>
          </tr>
        </thead>
        <tbody>
          {#each events as event}
            {@const hierarchy = buildWalletHierarchy(event)}
            {@const badgeInfo = getBadgeInfo(event)}
            <tr class:enhanced-row={isEnhanced(event)}>
              <td>
                <a 
                  href="https://flux.beer/tx/{event.txid}" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  class="txid-link"
                >
                  {shortenTxid(event.txid)}
                </a>
              </td>
              <td class="amount">
                {(event.amount || 0).toLocaleString(undefined, { 
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2 
                })} FLUX
              </td>
              <td class="exchange-name">
                <div class="exchange-cell">
                  {#if getExchangeLogo(getExchangeName(event))}
                    <img 
                      src={getExchangeLogo(getExchangeName(event))} 
                      alt={getExchangeName(event)}
                      class="exchange-logo"
                      on:error={(e) => e.target.style.display = 'none'}
                    />
                  {/if}
                  <span>{getExchangeName(event)}</span>
                </div>
              </td>
              <td>
                <!-- PHASE 5+: Multi-hop chain -->
                {#if hierarchy.type === 'multi-hop'}
                  <div class="wallet-hierarchy">
                    {#each hierarchy.chain as intermediary, idx}
                      <a 
                        href="https://flux.beer/address/{intermediary}" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        class="address-link intermediary"
                        title="{intermediary} (Hop {idx + 1})"
                      >
                        {shortenAddress(intermediary)}
                      </a>
                      <span class="arrow">→</span>
                    {/each}
                    <a 
                      href="https://flux.beer/address/{hierarchy.nodeWallet}" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      class="address-link node-wallet"
                      title="{hierarchy.nodeWallet} (Node Wallet)"
                    >
                      {shortenAddress(hierarchy.nodeWallet)}
                    </a>
                  </div>
                
                <!-- PHASE 5.1: Historical connection -->
                {:else if hierarchy.type === 'historical'}
                  <div class="wallet-hierarchy">
                    <a 
                      href="https://flux.beer/address/{hierarchy.directWallet}" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      class="address-link"
                      title="{hierarchy.directWallet} (Direct Wallet)"
                    >
                      {shortenAddress(hierarchy.directWallet)}
                    </a>
                    <span class="arrow historical-arrow" title="{hierarchy.method === 'historical_connection' ? 'Historical connection' : 'Historical coinbase'}">⟿</span>
                    <a 
                      href="https://flux.beer/address/{hierarchy.nodeWallet}" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      class="address-link node-wallet"
                      title="{hierarchy.nodeWallet} (Node Wallet)"
                    >
                      {shortenAddress(hierarchy.nodeWallet)}
                    </a>
                  </div>
                
                <!-- Direct wallet (Level 0, no enhancement) -->
                {:else}
                  <a 
                    href="https://flux.beer/address/{hierarchy.wallet}" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    class="address-link"
                    title={hierarchy.wallet}
                  >
                    {shortenAddress(hierarchy.wallet)}
                  </a>
                {/if}
              </td>
              <td>
                {#if getWalletType(event) === 'node_operator'}
                  <div class="node-operator-cell">
                    <a 
                      href="https://fluxnode.app.runonflux.io/#/nodes?wallet={hierarchy.nodeWallet || hierarchy.wallet}"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="wallet-type-link node_operator"
                    >
                      Node Operator
                    </a>
                    
                    <!-- PHASE 3+: Level Badge -->
                    {#if badgeInfo}
                      <span 
                        class="level-badge level-{badgeInfo.level} {badgeInfo.method}" 
                        title="{badgeInfo.title}: {badgeInfo.description}"
                      >
                        {badgeInfo.label}
                        <div class="level-tooltip">
                          <div class="tooltip-header">
                            <Info size={14} />
                            <span>{badgeInfo.title}</span>
                          </div>
                          <div class="tooltip-content">
                            <p><strong>Method:</strong> {badgeInfo.method.replace('_', ' ')}</p>
                            <p><strong>Status:</strong> {badgeInfo.status}</p>
                            {#if hierarchy.type === 'multi-hop'}
                              <p><strong>Hops:</strong> {hierarchy.chain.length}</p>
                            {/if}
                            {#if hierarchy.info}
                              {#if hierarchy.info.daysAgo !== undefined}
                                <p><strong>Last seen:</strong> {hierarchy.info.daysAgo} days ago</p>
                              {/if}
                              {#if hierarchy.info.coinbaseCount !== undefined}
                                <p><strong>Coinbase txs:</strong> {hierarchy.info.coinbaseCount}</p>
                              {/if}
                            {/if}
                          </div>
                        </div>
                      </span>
                    {/if}
                    
                    {#if getNodeCount(event) > 0}
                      <span class="node-count-badge" title="Node tier breakdown">
                        {getNodeCount(event)}
                        <div class="node-tooltip">
                          <div class="tooltip-header">
                            <Info size={14} />
                            <span>Node Breakdown</span>
                          </div>
                          <div class="tooltip-content">
                            {#if getNodeTiers(event).CUMULUS > 0}
                              <div class="tier-row cumulus">
                                <span class="tier-dot"></span>
                                <span class="tier-name">Cumulus:</span>
                                <span class="tier-count">{getNodeTiers(event).CUMULUS}</span>
                              </div>
                            {/if}
                            {#if getNodeTiers(event).NIMBUS > 0}
                              <div class="tier-row nimbus">
                                <span class="tier-dot"></span>
                                <span class="tier-name">Nimbus:</span>
                                <span class="tier-count">{getNodeTiers(event).NIMBUS}</span>
                              </div>
                            {/if}
                            {#if getNodeTiers(event).STRATUS > 0}
                              <div class="tier-row stratus">
                                <span class="tier-dot"></span>
                                <span class="tier-name">Stratus:</span>
                                <span class="tier-count">{getNodeTiers(event).STRATUS}</span>
                              </div>
                            {/if}
                          </div>
                        </div>
                      </span>
                    {/if}
                  </div>
                {:else}
                  <span class="wallet-type {getWalletType(event)}">
                    {getWalletTypeDisplay(getWalletType(event))}
                  </span>
                {/if}
              </td>
              <td class="block-height">
                <a 
                  href="https://flux.beer/block/{event.blockHeight}" 
                  target="_blank" 
                  rel="noopener noreferrer"
                >
                  {(event.blockHeight || 0).toLocaleString()}
                </a>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .transaction-table-container {
    background: rgba(15, 23, 42, 0.6);
    border-radius: 12px;
    padding: 1.5rem;
    margin-top: 2rem;
  }

  .table-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid rgba(148, 163, 184, 0.1);
  }

  .table-header h3 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    color: #06b6d4;
  }

  .event-count {
    font-size: 0.875rem;
    color: #94a3b8;
  }

  .no-data {
    padding: 3rem;
    text-align: center;
    color: #94a3b8;
  }

  .table-wrapper {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  thead {
    background: rgba(15, 23, 42, 0.4);
  }

  th {
    padding: 0.75rem 1rem;
    text-align: left;
    font-size: 0.875rem;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  tbody tr {
    border-bottom: 1px solid rgba(148, 163, 184, 0.1);
    transition: background-color 0.2s;
  }

  tbody tr:hover {
    background: rgba(6, 182, 212, 0.05);
  }

  /* PHASE 3+: Subtle highlight for enhanced rows */
  tbody tr.enhanced-row {
    background: rgba(245, 158, 11, 0.02);
  }

  tbody tr.enhanced-row:hover {
    background: rgba(245, 158, 11, 0.08);
  }

  td {
    padding: 1rem;
    font-size: 0.875rem;
    color: #e2e8f0;
  }

  .txid-link,
  .address-link {
    color: #06b6d4;
    text-decoration: none;
    font-family: 'Courier New', monospace;
    transition: color 0.2s;
  }

  .txid-link:hover,
  .address-link:hover {
    color: #0891b2;
    text-decoration: underline;
  }

  /* PHASE 3+: Wallet hierarchy styling */
  .wallet-hierarchy {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .address-link.intermediary {
    color: #f59e0b;
  }

  .address-link.node-wallet {
    color: #10b981;
    font-weight: 500;
  }

  .arrow {
    color: #64748b;
    font-size: 0.875rem;
  }

  .arrow.historical-arrow {
    color: #8b5cf6;
    font-size: 1rem;
  }

  .amount {
    font-weight: 500;
    font-family: 'Courier New', monospace;
    color: #10b981;
  }

  .exchange-cell {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .exchange-logo {
    width: 20px;
    height: 20px;
    border-radius: 4px;
  }

  .exchange-name {
    color: #94a3b8;
  }

  .node-operator-cell {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .wallet-type-link {
    color: #10b981;
    text-decoration: none;
    font-weight: 500;
    transition: all 0.2s;
  }

  .wallet-type-link:hover {
    color: #059669;
    text-decoration: underline;
  }

  .wallet-type {
    padding: 0.25rem 0.75rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .wallet-type.node_operator {
    background: rgba(16, 185, 129, 0.1);
    color: #10b981;
  }

  .wallet-type.exchange {
    background: rgba(6, 182, 212, 0.1);
    color: #06b6d4;
  }

  .wallet-type.foundation {
    background: rgba(245, 158, 11, 0.1);
    color: #f59e0b;
  }

  .wallet-type.unknown {
    background: rgba(148, 163, 184, 0.1);
    color: #94a3b8;
  }

  /* PHASE 3+: Level badges */
  .level-badge {
    position: relative;
    display: inline-flex;
    align-items: center;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    cursor: help;
  }

  .level-badge.level-0 {
    background: rgba(139, 92, 246, 0.1);
    color: #8b5cf6;
  }

  .level-badge.level-1 {
    background: rgba(245, 158, 11, 0.1);
    color: #f59e0b;
  }

  .level-badge.level-2 {
    background: rgba(239, 68, 68, 0.1);
    color: #ef4444;
  }

  .level-badge.level-3 {
    background: rgba(236, 72, 153, 0.1);
    color: #ec4899;
  }

  .level-badge.historical_coinbase,
  .level-badge.historical_connection {
    border: 1px solid currentColor;
  }

  .level-badge:hover .level-tooltip {
    opacity: 1;
    visibility: visible;
  }

  .level-tooltip {
    position: absolute;
    bottom: calc(100% + 0.5rem);
    left: 50%;
    transform: translateX(-50%);
    background: rgba(15, 23, 42, 0.95);
    border: 1px solid rgba(148, 163, 184, 0.2);
    border-radius: 8px;
    padding: 0.75rem;
    min-width: 200px;
    opacity: 0;
    visibility: hidden;
    transition: all 0.2s;
    z-index: 100;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
  }

  .tooltip-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid rgba(148, 163, 184, 0.1);
    font-weight: 600;
    color: #06b6d4;
  }

  .tooltip-content {
    font-size: 0.75rem;
    color: #cbd5e1;
  }

  .tooltip-content p {
    margin: 0.25rem 0;
  }

  .node-count-badge {
    position: relative;
    display: inline-flex;
    align-items: center;
    padding: 0.25rem 0.5rem;
    background: rgba(6, 182, 212, 0.1);
    color: #06b6d4;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    cursor: help;
  }

  .node-count-badge:hover .node-tooltip {
    opacity: 1;
    visibility: visible;
  }

  .node-tooltip {
    position: absolute;
    bottom: calc(100% + 0.5rem);
    left: 50%;
    transform: translateX(-50%);
    background: rgba(15, 23, 42, 0.95);
    border: 1px solid rgba(148, 163, 184, 0.2);
    border-radius: 8px;
    padding: 0.75rem;
    min-width: 180px;
    opacity: 0;
    visibility: hidden;
    transition: all 0.2s;
    z-index: 100;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
  }

  .tier-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.25rem 0;
    font-size: 0.75rem;
  }

  .tier-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }

  .tier-row.cumulus .tier-dot {
    background: #10b981;
  }

  .tier-row.nimbus .tier-dot {
    background: #06b6d4;
  }

  .tier-row.stratus .tier-dot {
    background: #8b5cf6;
  }

  .tier-name {
    color: #94a3b8;
  }

  .tier-count {
    color: #e2e8f0;
    font-weight: 600;
    margin-left: auto;
  }

  .block-height a {
    color: #64748b;
    text-decoration: none;
    font-family: 'Courier New', monospace;
    transition: color 0.2s;
  }

  .block-height a:hover {
    color: #94a3b8;
    text-decoration: underline;
  }

  @media (max-width: 768px) {
    .transaction-table-container {
      padding: 1rem;
    }

    .table-wrapper {
      overflow-x: scroll;
    }

    table {
      min-width: 800px;
    }

    th, td {
      padding: 0.5rem;
      font-size: 0.75rem;
    }

    .wallet-hierarchy {
      font-size: 0.75rem;
    }
  }
</style>