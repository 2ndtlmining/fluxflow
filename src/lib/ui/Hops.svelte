<!--
  Exchange-to-exchange hops (#20): a wallet withdraws from one exchange and re-deposits
  nearly all of it to another shortly after. Usually arbitrage or moving funds between
  accounts, not a decision to buy or sell, which is why the headline can leave them out.
-->
<script lang="ts">
  import {
    formatCount,
    formatFlux,
    formatFluxFull,
    shortAddress,
    timeAgo
  } from '$lib/client/format';
  import type { HopsResponse } from '$lib/client/types';

  interface Props {
    data: HopsResponse;
  }

  let { data }: Props = $props();

  /** A compact section: the largest hops; the rest are a click away in the table below. */
  const SHOWN = 8;
  let expanded = $state(false);

  const sorted = $derived([...data.hops].sort((a, b) => b.amount - a.amount));
  // One wallet can hop more than once, so hops and wallets are counted separately.
  const wallets = $derived(new Set(data.hops.map((hop) => hop.address)).size);
  const shown = $derived(expanded ? sorted : sorted.slice(0, SHOWN));
  const now = Date.now();
</script>

<section aria-labelledby="hops-heading" class="hops">
  <header>
    <h2 id="hops-heading">Exchange hops</h2>
    <p class="muted">
      {formatCount(data.summary.count)}
      {data.summary.count === 1 ? 'time' : 'times'}, a wallet withdrew FLUX from one exchange and
      deposited it to another within a few blocks{wallets < data.summary.count
        ? ` (${formatCount(wallets)} ${wallets === 1 ? 'wallet' : 'different wallets'})`
        : ''}: {formatFlux(data.summary.sellingExcluded)} FLUX in all. Each hop counts as both a withdrawal
      and a deposit.
    </p>
  </header>

  <table>
    <caption class="visually-hidden">Exchange-to-exchange hops, largest first</caption>
    <thead>
      <tr>
        <th scope="col">Wallet</th>
        <th scope="col">From, to</th>
        <th scope="col" class="num">FLUX</th>
        <th scope="col" class="num">Blocks apart</th>
      </tr>
    </thead>
    <tbody>
      {#each shown as hop (hop.sellTxid)}
        <tr>
          <td>
            <a class="mono" href="/wallet/{hop.address}" title={hop.address}>
              {shortAddress(hop.address)}
            </a>
            <span class="muted small">{timeAgo(hop.sellTime, now)}</span>
          </td>
          <td class="route">
            <span class="buy">{hop.fromExchange}</span>
            <span aria-hidden="true" class="arrow">→</span><span class="visually-hidden">to</span>
            <span class="sell">{hop.toExchange}</span>
          </td>
          <td
            class="num"
            title="{formatFluxFull(hop.withdrawn)} withdrawn, {formatFluxFull(
              hop.amount
            )} deposited"
          >
            {formatFlux(hop.amount)}
          </td>
          <td class="num">
            <a
              class="muted"
              href="https://explorer.runonflux.io/tx/{hop.sellTxid}"
              rel="noopener noreferrer"
              target="_blank"
              title="Deposit transaction at block {hop.sellHeight}"
              >{formatCount(hop.blocksApart)}</a
            >
          </td>
        </tr>
      {/each}
    </tbody>
  </table>

  {#if sorted.length > SHOWN}
    <button
      type="button"
      class="link"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
    >
      {expanded ? 'Show the largest only' : `Show all ${formatCount(sorted.length)} hops`}
    </button>
  {/if}
</section>

<style>
  .hops {
    display: grid;
    gap: 0.75rem;
  }

  header {
    display: grid;
    gap: 0.15rem;
  }

  header p {
    font-size: var(--step--1);
    max-width: 75ch;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th {
    text-align: left;
    font-size: var(--step--1);
    font-weight: 500;
    color: var(--text-muted);
    padding: 0.35rem 0.5rem 0.35rem 0;
    border-bottom: 1px solid var(--line);
  }

  td {
    padding: 0.5rem 0.5rem 0.5rem 0;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }

  td:first-child > * {
    display: block;
  }

  .route {
    font-weight: 500;
    white-space: nowrap;
  }

  .arrow {
    margin: 0 0.3rem;
    color: var(--text-muted);
  }

  .num {
    text-align: right;
    padding-right: 0;
    white-space: nowrap;
  }

  td.num {
    font-weight: 600;
  }

  .small {
    font-size: var(--step--1);
  }

  .link {
    justify-self: start;
    padding: 0;
    border: 0;
    background: none;
    color: var(--brand);
    text-decoration: underline;
    cursor: pointer;
  }

  @media (max-width: 640px) {
    thead {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }

    tbody tr {
      display: grid;
      grid-template-columns: 1fr auto;
      grid-template-areas:
        'route amount'
        'wallet blocks';
      gap: 0.1rem 0.75rem;
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--line);
    }

    td {
      padding: 0;
      border: 0;
    }

    td:nth-child(1) {
      grid-area: wallet;
    }
    td:nth-child(2) {
      grid-area: route;
    }
    td:nth-child(3) {
      grid-area: amount;
    }
    td:nth-child(4) {
      grid-area: blocks;
      font-weight: 400;
      font-size: var(--step--1);
    }
    td:nth-child(4)::after {
      content: ' blocks apart';
      color: var(--text-muted);
    }
  }
</style>
