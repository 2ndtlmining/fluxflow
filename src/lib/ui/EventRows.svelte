<!--
  A table of transfers, newest first. Shared by the transactions explorer and the wallet page.

  On the dashboard the "Wallet" column is the non-exchange side of each transfer. On a wallet
  page (`self` set) it is the *other* party, since the page is already about `self`.
-->
<script lang="ts">
  import {
    flowLabel,
    formatFlux,
    formatFluxFull,
    formatTime,
    kindLabel,
    shortAddress,
    timeAgo
  } from '$lib/client/format';
  import type { AddressKind, FlowEvent } from '$lib/client/types';

  interface Props {
    events: FlowEvent[];
    loading?: boolean;
    caption: string;
    /** Keys (`txid:vout`) of rows that just arrived, briefly highlighted. */
    fresh?: ReadonlySet<string>;
    /** The wallet a wallet page is about. */
    self?: string;
    empty?: import('svelte').Snippet;
  }

  let { events, loading = false, caption, fresh, self, empty }: Props = $props();

  // "3m ago" is measured when the rows change, not on every render.
  const now = $derived.by(() => {
    void events;
    return Date.now();
  });

  function party(event: FlowEvent): { address: string; kind: AddressKind; role: string } {
    if (self) {
      const outgoing = event.fromAddress === self;
      return outgoing
        ? { address: event.toAddress, kind: event.toKind, role: 'to' }
        : { address: event.fromAddress, kind: event.fromKind, role: 'from' };
    }
    return event.flowType === 'buying'
      ? { address: event.toAddress, kind: event.toKind, role: '' }
      : { address: event.fromAddress, kind: event.fromKind, role: '' };
  }

  const tone = (flowType: string) =>
    flowType === 'selling' ? 'sell' : flowType === 'buying' ? 'buy' : 'muted';
</script>

<div class="table-wrap" aria-busy={loading}>
  <table>
    <caption class="visually-hidden">{caption}</caption>
    <thead>
      <tr>
        <th scope="col">When</th>
        <th scope="col">What</th>
        <th scope="col">{self ? 'Other side' : 'Wallet'}</th>
        <th scope="col" class="num">FLUX</th>
      </tr>
    </thead>
    <tbody class:stale={loading && events.length > 0}>
      {#if loading && events.length === 0}
        {#each Array.from({ length: 6 }, (_, i) => i) as i (i)}
          <tr><td colspan="4"><span class="skeleton">loading transfer row</span></td></tr>
        {/each}
      {:else if events.length === 0}
        <tr><td colspan="4" class="muted empty">{@render empty?.()}</td></tr>
      {:else}
        {#each events as event (`${event.txid}:${event.vout}`)}
          {@const other = party(event)}
          <tr class:fresh={fresh?.has(`${event.txid}:${event.vout}`)}>
            <td class="when">
              <span title={formatTime(event.time)}>{timeAgo(event.time, now)}</span>
              <a
                class="muted mono small"
                href="https://explorer.runonflux.io/tx/{event.txid}"
                rel="noopener noreferrer"
                target="_blank">#{event.height}</a
              >
            </td>
            <td class="what">
              <span class={tone(event.flowType)}>{flowLabel(event.flowType)}</span>
              {#if event.exchange}<span class="muted">{event.exchange}</span>{/if}
            </td>
            <td class="wallet">
              {#if other.address === self}
                <span class="muted">this wallet</span>
              {:else}
                <a class="mono" href="/wallet/{other.address}" title={other.address}
                  >{other.role ? `${other.role} ` : ''}{shortAddress(other.address)}</a
                >
              {/if}
              <span class="muted small">{kindLabel(other.kind)}</span>
            </td>
            <td class="num" title="{formatFluxFull(event.amount)} FLUX"
              >{formatFlux(event.amount)}</td
            >
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
</div>

<style>
  table {
    width: 100%;
    border-collapse: collapse;
  }

  th {
    text-align: left;
    font-size: var(--step--1);
    font-weight: 500;
    color: var(--text-muted);
    padding: 0.4rem 0.5rem 0.4rem 0;
    border-bottom: 1px solid var(--line);
  }

  td {
    padding: 0.6rem 0.5rem 0.6rem 0;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }

  tbody tr {
    content-visibility: auto;
    contain-intrinsic-size: auto 3.25rem;
  }

  tbody.stale {
    opacity: 0.55;
    transition: opacity 150ms;
  }

  /* A new arrival fades from a tint; with reduced motion it keeps a static marker instead. */
  tr.fresh {
    animation: arrive 6s ease-out;
  }

  @keyframes arrive {
    from {
      background: color-mix(in srgb, var(--brand) 22%, transparent);
    }
    to {
      background: transparent;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    tr.fresh td:first-child {
      box-shadow: inset 3px 0 0 var(--brand);
      padding-left: 0.5rem;
    }
  }

  .when > *,
  .what > *,
  .wallet > * {
    display: block;
  }

  .small {
    font-size: var(--step--1);
  }

  .num {
    text-align: right;
    font-weight: 600;
    padding-right: 0;
    white-space: nowrap;
  }

  .empty {
    padding: 1.25rem 0;
  }

  /* Phone: each transfer becomes a compact two-line block instead of a wide row. */
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
        'what num'
        'wallet when';
      gap: 0.15rem 0.75rem;
      padding: 0.6rem 0;
      border-bottom: 1px solid var(--line);
    }

    td {
      padding: 0;
      border: 0;
    }

    td[colspan] {
      grid-column: 1 / -1;
    }

    .what {
      grid-area: what;
    }
    .num {
      grid-area: num;
    }
    .wallet {
      grid-area: wallet;
    }
    .when {
      grid-area: when;
      text-align: right;
    }
  }
</style>
