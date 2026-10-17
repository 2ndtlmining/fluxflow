<!--
  Counterparties as a table: who, what kind, how much, how often, how recently.

  Every wallet links to its own page, so a trail can be followed upstream one click at a time.
-->
<script lang="ts">
  import {
    formatCount,
    formatFlux,
    formatFluxFull,
    kindLabel,
    shortAddress,
    timeAgo
  } from '$lib/client/format';
  import type { Party } from '$lib/client/types';

  let {
    parties,
    caption,
    column = 'Wallet'
  }: { parties: Party[]; caption: string; column?: string } = $props();

  const now = Date.now();
  const percent = (share: number) =>
    share > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`;
</script>

<div class="scroll">
  <table>
    <caption class="visually-hidden">{caption}</caption>
    <thead>
      <tr>
        <th scope="col">{column}</th>
        <th scope="col" class="num">FLUX</th>
        <th scope="col" class="num">Share</th>
        <th scope="col" class="num">Transfers</th>
        <th scope="col" class="num">Last</th>
      </tr>
    </thead>
    <tbody>
      {#each parties as party (party.address)}
        <tr>
          <td>
            <a href="/wallet/{party.address}" class:mono={!party.name} title={party.address}>
              {party.name ?? shortAddress(party.address)}
            </a>
            <span class="muted small kind {party.kind}">{kindLabel(party.kind)}</span>
          </td>
          <td class="num strong" title="{formatFluxFull(party.total)} FLUX">
            {formatFlux(party.total)}
          </td>
          <td class="num">
            <span class="share" style="--share: {party.share}">{percent(party.share)}</span>
          </td>
          <td class="num">{formatCount(party.count)}</td>
          <td class="num muted small">{timeAgo(party.lastSeen, now)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .scroll {
    overflow-x: auto;
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
    padding: 0.45rem 0.5rem 0.45rem 0;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }

  td:first-child > * {
    display: block;
  }

  .num {
    text-align: right;
    white-space: nowrap;
  }

  th:last-child,
  td:last-child {
    padding-right: 0;
  }

  .strong {
    font-weight: 600;
  }

  /* A faint bar behind the percentage: the share at a glance, the number to read. */
  .share {
    display: inline-block;
    min-width: 3.5rem;
    padding: 0 0.3rem;
    background: linear-gradient(
      to left,
      color-mix(in srgb, var(--brand) 22%, transparent) calc(var(--share) * 100%),
      transparent 0
    );
    border-radius: 2px;
  }

  .kind.foundation {
    color: var(--brand);
  }

  .kind.exchange {
    color: var(--sell);
  }

  .kind.node_operator {
    color: var(--buy);
  }

  .kind.app_hosting {
    color: var(--good);
  }

  .small {
    font-size: var(--step--1);
  }
</style>
