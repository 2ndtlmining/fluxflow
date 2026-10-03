<!--
  Who moved the most FLUX onto exchanges (selling) or off them (buying) (#28).
  A ranking, so the rows are numbered. Each row says how much of the period's total the
  wallet accounts for, which exchanges it used, and how that compares with the period before.
-->
<script lang="ts">
  import {
    formatCount,
    formatFlux,
    formatFluxFull,
    formatSigned,
    kindLabel,
    shortAddress,
    timeAgo
  } from '$lib/client/format';
  import type { Counterparty, ExchangeHop } from '$lib/client/types';
  import ConfidenceBadge from './ConfidenceBadge.svelte';

  interface Props {
    side: 'selling' | 'buying';
    rows: Counterparty[] | undefined;
    /** The direction's total for the period, for the "share" figure. */
    total?: number;
    error?: string | null;
    /** Wallets that moved FLUX from one exchange to another in this period (#20). */
    hops?: ReadonlyMap<string, ExchangeHop>;
  }

  let { side, rows, total = 0, error = null, hops }: Props = $props();

  const title = $derived(side === 'selling' ? "Who's selling" : "Who's buying");
  const explain = $derived(
    side === 'selling'
      ? 'Wallets that deposited the most FLUX to exchanges.'
      : 'Wallets that withdrew the most FLUX from exchanges.'
  );
  const scale = $derived(Math.max(1, ...(rows ?? []).map((row) => row.total)));
  const topShare = $derived((rows ?? []).reduce((sum, row) => sum + row.share, 0));
  const now = Date.now();

  function exchangesText(row: Counterparty): string {
    if (row.exchanges.length === 0) return '';
    if (row.exchanges.length === 1) return `via ${row.exchanges[0]!.name}`;
    // Amounts per exchange only when the server sent them.
    return `${row.exchanges
      .map((entry) =>
        Number.isFinite(entry.total) ? `${entry.name} ${formatFlux(entry.total)}` : entry.name
      )
      .join(', ')}`;
  }
</script>

<section class="board" aria-labelledby="board-{side}">
  <header>
    <h2 id="board-{side}" class={side === 'selling' ? 'sell' : 'buy'}>{title}</h2>
    <p class="muted">
      {explain}
      {#if rows && rows.length > 0 && total > 0}
        These {rows.length} account for {Math.round(topShare * 100)}% of the
        {formatFlux(total)} FLUX.
      {/if}
    </p>
  </header>

  {#if error}
    <p class="error">{error}</p>
  {:else if !rows}
    <ol class="list">
      {#each Array.from({ length: 5 }, (_, i) => i) as i (i)}
        <li class="row"><span class="skeleton placeholder">t1xxxxxx…xxxxx 000K</span></li>
      {/each}
    </ol>
  {:else if rows.length === 0}
    <p class="muted empty">
      No transfers {side === 'selling' ? 'to' : 'from'} exchanges by this kind of wallet in this period.
    </p>
  {:else}
    <ol class="list">
      {#each rows as row (row.address)}
        <li class="row">
          <span class="rank muted" aria-hidden="true">{row.rank}</span>
          <span class="who">
            <a href="/wallet/{row.address}" title={row.address} class:mono={!row.name}>
              {row.name ?? shortAddress(row.address)}
            </a>
            <span class="meta muted">
              <span class="kind"
                >{kindLabel(row.kind)}<ConfidenceBadge
                  level={row.level}
                  source={row.labelSource}
                  confidence={row.confidence}
                /></span
              >
              {#if hops?.has(row.address)}
                {@const hop = hops.get(row.address)!}
                <span
                  class="hop"
                  title="Withdrew {formatFlux(
                    hop.withdrawn
                  )} from {hop.fromExchange} and deposited {formatFlux(
                    hop.amount
                  )} to {hop.toExchange} {hop.blocksApart} blocks later"
                  >hop {hop.fromExchange} to {hop.toExchange}</span
                >
              {/if}
              <span class="rest"
                >{exchangesText(row)}{#if row.lastSeen}, last {timeAgo(
                    row.lastSeen,
                    now
                  )}{/if}</span
              >
            </span>
          </span>
          <span
            class="amount"
            title="{formatFluxFull(row.total)} FLUX in {formatCount(row.count)} transfers, {(
              row.share * 100
            ).toFixed(1)}% of the period"
          >
            {formatFlux(row.total)}
            <span class="track" aria-hidden="true">
              <span
                class="bar {side === 'selling' ? 'sell-bar' : 'buy-bar'}"
                style:width="{(row.total / scale) * 100}%"
              ></span>
            </span>
            <span class="change muted">
              {#if !Number.isFinite(row.change)}
                <!-- No comparison from this server. -->
              {:else if row.previousTotal === 0}
                new this period
              {:else if row.change === 0}
                same as before
              {:else}
                {formatSigned(row.change)} vs before
              {/if}
            </span>
          </span>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .board {
    display: grid;
    gap: 0.75rem;
    align-content: start;
    min-width: 0;
  }

  header {
    display: grid;
    gap: 0.15rem;
  }

  header p {
    font-size: var(--step--1);
  }

  .list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .row {
    display: grid;
    grid-template-columns: 1.5rem minmax(0, 1fr) 7rem;
    gap: 0.5rem;
    align-items: center;
    padding: 0.55rem 0;
    border-top: 1px solid var(--line);
  }

  .rank {
    font-size: var(--step--1);
  }

  .placeholder {
    grid-column: 1 / -1;
  }

  .who {
    display: grid;
    min-width: 0;
  }

  .who a {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Only the trailing details truncate; the kind and its badge must stay whole, and the
     badge's popover must not be clipped by an overflow box. */
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 0.4rem;
    min-width: 0;
    font-size: var(--step--1);
  }

  .kind {
    white-space: nowrap;
  }

  .rest {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Shrinks with an ellipsis rather than pushing into the amount column on a phone; the
     full route is in its title. */
  .hop {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0 0.4rem;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text);
    font-size: 0.7rem;
    white-space: nowrap;
  }

  .amount {
    display: grid;
    gap: 0.2rem;
    text-align: right;
    font-weight: 600;
  }

  .change {
    font-size: 0.75rem;
    font-weight: 400;
  }

  .track {
    display: flex;
    justify-content: flex-end;
    height: 0.3rem;
    background: var(--surface-2);
    border-radius: 2px;
  }

  .bar {
    display: block;
    height: 100%;
    border-radius: 2px;
  }

  .sell-bar {
    background: var(--sell);
  }

  .buy-bar {
    background: var(--buy);
  }

  .error {
    color: var(--bad);
  }

  .empty {
    padding: 0.75rem 0;
    border-top: 1px solid var(--line);
  }
</style>
