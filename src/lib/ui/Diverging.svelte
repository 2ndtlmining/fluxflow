<!--
  The balance axis, per row: deposits to exchanges grow left in amber, withdrawals grow right
  in cyan, on one shared scale so rows compare with each other. Used for exchanges and for
  participant types.
-->
<script lang="ts">
  import { formatFlux, formatFluxFull } from '$lib/client/format';
  import type { DivergingRow } from './types';

  interface Props {
    rows: DivergingRow[];
    caption: string;
  }

  let { rows, caption }: Props = $props();

  const scale = $derived(Math.max(1, ...rows.flatMap((row) => [row.sell, row.buy])));
</script>

<table>
  <caption class="visually-hidden">{caption}</caption>
  <thead class="visually-hidden">
    <tr>
      <th scope="col">Name</th>
      <th scope="col">Deposited to exchanges (FLUX)</th>
      <th scope="col">Withdrawn from exchanges (FLUX)</th>
      <th scope="col">Net (FLUX)</th>
    </tr>
  </thead>
  <tbody>
    {#each rows as row (row.key)}
      {@const net = row.buy - row.sell}
      <tr>
        <th scope="row">{row.label}</th>
        <td class="side left" title="{formatFluxFull(row.sell)} FLUX deposited">
          <span class="value sell">{row.sell > 0 ? formatFlux(row.sell) : ''}</span>
          <span class="track">
            <span class="bar sell-bar" style:width="{(row.sell / scale) * 100}%"></span>
          </span>
        </td>
        <td class="side right" title="{formatFluxFull(row.buy)} FLUX withdrawn">
          <span class="track">
            <span class="bar buy-bar" style:width="{(row.buy / scale) * 100}%"></span>
          </span>
          <span class="value buy">{row.buy > 0 ? formatFlux(row.buy) : ''}</span>
        </td>
        <td class="net {net < 0 ? 'sell' : net > 0 ? 'buy' : 'muted'}">
          {net === 0 ? '0' : `${net > 0 ? '+' : '−'}${formatFlux(Math.abs(net))}`}
        </td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }

  th[scope='row'] {
    text-align: left;
    font-weight: 500;
    width: 9rem;
    padding: 0.5rem 0.75rem 0.5rem 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  td {
    padding: 0.5rem 0;
  }

  .side {
    width: auto;
  }

  .side > * {
    vertical-align: middle;
  }

  .left {
    text-align: right;
    border-right: 2px solid var(--text);
    padding-right: 0;
  }

  .right {
    padding-left: 0;
  }

  .track {
    display: inline-flex;
    width: calc(100% - 4.5rem);
    height: 0.9rem;
  }

  .left .track {
    justify-content: flex-end;
  }

  .bar {
    display: block;
    height: 100%;
    min-width: 0;
  }

  .sell-bar {
    background: var(--sell);
    border-radius: var(--radius-s) 0 0 var(--radius-s);
  }

  .buy-bar {
    background: var(--buy);
    border-radius: 0 var(--radius-s) var(--radius-s) 0;
  }

  .value {
    display: inline-block;
    width: 4.25rem;
    font-size: var(--step--1);
    font-weight: 500;
  }

  .left .value {
    text-align: right;
    padding-right: 0.4rem;
  }

  .right .value {
    padding-left: 0.4rem;
  }

  .net {
    width: 5.5rem;
    text-align: right;
    font-weight: 600;
    font-size: var(--step--1);
  }

  tr + tr th,
  tr + tr td:not(.left) {
    border-top: 1px solid var(--line);
  }

  /* Phone: name and net on one line, the full-width axis beneath, so the bars keep their size. */
  @media (max-width: 640px) {
    table,
    tbody {
      display: block;
    }

    tr {
      display: grid;
      grid-template-columns: 1fr 1fr;
      grid-template-areas:
        'label net'
        'left right';
      padding: 0.5rem 0;
    }

    tr + tr {
      border-top: 1px solid var(--line);
    }

    tr + tr th,
    tr + tr td:not(.left) {
      border-top: 0;
    }

    th[scope='row'] {
      grid-area: label;
      width: auto;
      padding: 0 0 0.3rem;
    }

    .net {
      grid-area: net;
      width: auto;
      padding: 0 0 0.3rem;
    }

    .left {
      grid-area: left;
      padding: 0;
    }

    .right {
      grid-area: right;
      padding: 0;
    }

    .track {
      width: calc(100% - 3.75rem);
    }

    .value {
      width: 3.5rem;
    }
  }
</style>
