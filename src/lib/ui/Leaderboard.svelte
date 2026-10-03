<!--
  Who moved the most FLUX onto exchanges (selling) or off them (buying) (#28).
  A ranking, so the rows are numbered.
-->
<script lang="ts">
  import {
    formatCount,
    formatFlux,
    formatFluxFull,
    kindLabel,
    shortAddress
  } from '$lib/client/format';
  import type { Counterparty } from '$lib/client/types';

  interface Props {
    side: 'selling' | 'buying';
    rows: Counterparty[] | undefined;
    error?: string | null;
  }

  let { side, rows, error = null }: Props = $props();

  const title = $derived(side === 'selling' ? "Who's selling" : "Who's buying");
  const explain = $derived(
    side === 'selling'
      ? 'Wallets that deposited the most FLUX to exchanges.'
      : 'Wallets that withdrew the most FLUX from exchanges.'
  );
  const scale = $derived(Math.max(1, ...(rows ?? []).map((row) => row.total)));
</script>

<section class="board" aria-labelledby="board-{side}">
  <header>
    <h2 id="board-{side}" class={side === 'selling' ? 'sell' : 'buy'}>{title}</h2>
    <p class="muted">{explain}</p>
  </header>

  {#if error}
    <p class="error">{error}</p>
  {:else if !rows}
    <ol class="list">
      {#each Array.from({ length: 5 }, (_, i) => i) as i (i)}
        <li class="row"><span class="skeleton">t1xxxxxx…xxxxx 000K</span></li>
      {/each}
    </ol>
  {:else if rows.length === 0}
    <p class="muted empty">
      No transfers {side === 'selling' ? 'to' : 'from'} exchanges in this period.
    </p>
  {:else}
    <ol class="list">
      {#each rows as row, index (row.address)}
        <li class="row">
          <span class="rank muted" aria-hidden="true">{index + 1}</span>
          <span class="who">
            <a class="mono" href="/wallet/{row.address}" title={row.address}>
              {shortAddress(row.address)}
            </a>
            <span class="meta muted">
              {kindLabel(row.kind)}{#if row.exchanges.length}, via {row.exchanges.join(', ')}{/if}
            </span>
          </span>
          <span
            class="amount"
            title="{formatFluxFull(row.total)} FLUX in {formatCount(row.count)} transfers"
          >
            {formatFlux(row.total)}
            <span class="track" aria-hidden="true">
              <span
                class="bar {side === 'selling' ? 'sell-bar' : 'buy-bar'}"
                style:width="{(row.total / scale) * 100}%"
              ></span>
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
    grid-template-columns: 1.5rem minmax(0, 1fr) 6.5rem;
    gap: 0.5rem;
    align-items: center;
    padding: 0.55rem 0;
    border-top: 1px solid var(--line);
  }

  .rank {
    font-size: var(--step--1);
  }

  .who {
    display: grid;
    min-width: 0;
  }

  .meta {
    font-size: var(--step--1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .amount {
    display: grid;
    gap: 0.25rem;
    text-align: right;
    font-weight: 600;
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
