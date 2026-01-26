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
    // Normalize 'node' to 'node_operator'
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
  
  // PHASE 2: Level 1 detection - check ALL possible field name variations
  function isLevel1(event) {
    return event.classificationLevel === 1 || 
           event.classification_level === 1 ||
           event.dataSource === 'enhanced' ||
           event.data_source === 'enhanced';
  }
  
  function getIntermediaryWallet(event) {
    return event.intermediaryWallet || event.intermediary_wallet;
  }
  
  function getActualNodeWallet(event) {
    const details = getWalletDetails(event);
    return details?.nodeWallet || details?.node_wallet;
  }
  
  // Debug helper - log event structure for first event
  $: if (events.length > 0 && events[0]) {
    console.log('📊 Transaction Table - First Event Structure:', {
      classificationLevel: events[0].classificationLevel,
      intermediaryWallet: events[0].intermediaryWallet,
      dataSource: events[0].dataSource,
      fromType: events[0].fromType,
      toType: events[0].toType,
      isLevel1: isLevel1(events[0])
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
            <tr class:level-1-row={isLevel1(event)}>
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
                {#if isLevel1(event) && getIntermediaryWallet(event)}
                  <!-- PHASE 2: Show intermediary wallet for Level 1 -->
                  <div class="wallet-hierarchy">
                    <a 
                      href="https://flux.beer/address/{getIntermediaryWallet(event)}" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      class="address-link intermediary"
                      title="{getIntermediaryWallet(event)} (Intermediary)"
                    >
                      {shortenAddress(getIntermediaryWallet(event))}
                    </a>
                    <span class="arrow">→</span>
                    <a 
                      href="https://flux.beer/address/{getActualNodeWallet(event) || getWalletAddress(event)}" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      class="address-link node-wallet"
                      title="{getActualNodeWallet(event) || getWalletAddress(event)} (Node Wallet)"
                    >
                      {shortenAddress(getActualNodeWallet(event) || getWalletAddress(event))}
                    </a>
                  </div>
                {:else}
                  <!-- Level 0: Direct transaction -->
                  <a 
                    href="https://flux.beer/address/{getWalletAddress(event)}" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    class="address-link"
                    title={getWalletAddress(event)}
                  >
                    {shortenAddress(getWalletAddress(event))}
                  </a>
                {/if}
              </td>
              <td>
                {#if getWalletType(event) === 'node_operator'}
                  <div class="node-operator-cell">
                    <a 
                      href="https://fluxnode.app.runonflux.io/#/nodes?wallet={getActualNodeWallet(event) || getWalletAddress(event)}"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="wallet-type-link node_operator"
                    >
                      Node Operator
                    </a>
                    
                    <!-- PHASE 2: Level 1 Badge -->
                    {#if isLevel1(event)}
                      <span class="level-badge level-1" title="1-Hop Analysis: Detected through intermediary wallet">
                        L1
                        <div class="level-tooltip">
                          <div class="tooltip-header">
                            <Info size={14} />
                            <span>Level 1 Detection</span>
                          </div>
                          <div class="tooltip-content">
                            <p>Detected via 1-hop analysis</p>
                            <div class="flow-diagram">
                              {#if type === 'buying'}
                                <div class="flow-step">Exchange</div>
                                <div class="flow-arrow">↓</div>
                                <div class="flow-step highlight">Intermediary</div>
                                <div class="flow-arrow">↓</div>
                                <div class="flow-step">Node Wallet</div>
                              {:else}
                                <div class="flow-step">Node Wallet</div>
                                <div class="flow-arrow">↓</div>
                                <div class="flow-step highlight">Intermediary</div>
                                <div class="flow-arrow">↓</div>
                                <div class="flow-step">Exchange</div>
                              {/if}
                            </div>
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

  /* PHASE 2: Subtle highlight for Level 1 rows */
  tbody tr.level-1-row {
    background: rgba(245, 158, 11, 0.02);
  }

  tbody tr.level-1-row:hover {
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

  /* PHASE 2: Wallet hierarchy styling */
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
    font-weight: 600;
  }

  .arrow {
    color: #64748b;
    font-size: 1rem;
  }

  .amount {
    font-weight: 600;
    color: #10b981;
  }

  .exchange-name {
    font-weight: 500;
  }

  .exchange-cell {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .exchange-logo {
    width: 24px;
    height: 24px;
    border-radius: 4px;
    object-fit: contain;
    flex-shrink: 0;
  }

  .wallet-type {
    display: inline-block;
    padding: 0.25rem 0.75rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .wallet-type.exchange {
    background: rgba(239, 68, 68, 0.1);
    color: #f87171;
  }

  .wallet-type.node_operator {
    background: rgba(59, 130, 246, 0.1);
    color: #60a5fa;
  }

  .wallet-type.foundation {
    background: rgba(168, 85, 247, 0.1);
    color: #a78bfa;
  }

  .wallet-type.unknown {
    background: rgba(148, 163, 184, 0.1);
    color: #94a3b8;
  }

  /* Node Operator Cell Styling */
  .node-operator-cell {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .wallet-type-link {
    display: inline-block;
    padding: 0.25rem 0.75rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    text-decoration: none;
    transition: all 0.2s;
  }

  .wallet-type-link.node_operator {
    background: rgba(59, 130, 246, 0.1);
    color: #60a5fa;
  }

  .wallet-type-link.node_operator:hover {
    background: rgba(59, 130, 246, 0.2);
    color: #93c5fd;
  }

  /* PHASE 2: Level 1 Badge */
  .level-badge {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 32px;
    height: 24px;
    padding: 0 0.5rem;
    border-radius: 12px;
    font-size: 0.7rem;
    font-weight: 700;
    cursor: help;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .level-badge.level-1 {
    background: rgba(245, 158, 11, 0.2);
    color: #fbbf24;
    border: 1px solid rgba(245, 158, 11, 0.4);
  }

  .level-tooltip {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    background: rgba(15, 23, 42, 0.98);
    border: 1px solid rgba(245, 158, 11, 0.4);
    border-radius: 8px;
    padding: 0.75rem;
    min-width: 200px;
    opacity: 0;
    visibility: hidden;
    transition: all 0.2s;
    pointer-events: none;
    z-index: 1001;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
  }

  .level-badge:hover .level-tooltip {
    opacity: 1;
    visibility: visible;
  }

  .flow-diagram {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    margin-top: 0.5rem;
    font-size: 0.75rem;
  }

  .flow-step {
    background: rgba(100, 116, 139, 0.2);
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    color: #94a3b8;
    font-size: 0.7rem;
  }

  .flow-step.highlight {
    background: rgba(245, 158, 11, 0.2);
    color: #fbbf24;
    font-weight: 600;
  }

  .flow-arrow {
    color: #64748b;
    font-size: 1rem;
  }

  .node-count-badge {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    height: 24px;
    padding: 0 0.5rem;
    background: rgba(6, 182, 212, 0.2);
    color: #06b6d4;
    border-radius: 12px;
    font-size: 0.75rem;
    font-weight: 600;
    cursor: help;
  }

  .node-tooltip {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    background: rgba(15, 23, 42, 0.98);
    border: 1px solid rgba(6, 182, 212, 0.3);
    border-radius: 8px;
    padding: 0.75rem;
    min-width: 180px;
    opacity: 0;
    visibility: hidden;
    transition: all 0.2s;
    pointer-events: none;
    z-index: 1000;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
  }

  .node-count-badge:hover .node-tooltip {
    opacity: 1;
    visibility: visible;
  }

  .tooltip-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid rgba(148, 163, 184, 0.2);
    color: #06b6d4;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .tooltip-content {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .tooltip-content p {
    margin: 0;
    color: #94a3b8;
    font-size: 0.75rem;
    line-height: 1.4;
  }

  .tier-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
  }

  .tier-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .tier-row.cumulus .tier-dot {
    background: #f87171;
  }

  .tier-row.nimbus .tier-dot {
    background: #a78bfa;
  }

  .tier-row.stratus .tier-dot {
    background: #60a5fa;
  }

  .tier-name {
    color: #94a3b8;
    flex: 1;
  }

  .tier-count {
    color: #e2e8f0;
    font-weight: 600;
  }

  .block-height a {
    color: #94a3b8;
    text-decoration: none;
    transition: color 0.2s;
  }

  .block-height a:hover {
    color: #06b6d4;
    text-decoration: underline;
  }

  /* Responsive */
  @media (max-width: 768px) {
    .transaction-table-container {
      padding: 1rem;
    }

    th, td {
      padding: 0.5rem;
      font-size: 0.75rem;
    }

    .node-operator-cell {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.25rem;
    }

    .wallet-hierarchy {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>