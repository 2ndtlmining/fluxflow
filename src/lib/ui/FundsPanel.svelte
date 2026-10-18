<!--
  Source of funds and where a wallet's money went (#64), a chosen number of hops deep.

  Both sides load on their own, so a busy wallet's trace never holds up the rest of the page.
  The figures are proportional exposure (see `server/api/funds.ts`), and the note says so.
-->
<script lang="ts">
  import { isAbort } from '$lib/client/api';
  import { fetchFunds } from '$lib/client/endpoints';
  import { formatFlux, formatFluxFull, kindLabel, shortAddress } from '$lib/client/format';
  import { live } from '$lib/client/live.svelte';
  import type { WalletFunds } from '$lib/client/types';
  import KindMix from './KindMix.svelte';

  let { address }: { address: string } = $props();

  const HOPS = [1, 2, 3, 4] as const;
  let hops = $state(3);
  let sources = $state<WalletFunds | null>(null);
  let destinations = $state<WalletFunds | null>(null);
  let failed = $state(false);

  $effect(() => {
    const current = address;
    const depth = hops;
    void live.version;
    const controller = new AbortController();
    failed = false;

    for (const direction of ['in', 'out'] as const) {
      fetchFunds(current, direction, depth, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          if (direction === 'in') sources = result;
          else destinations = result;
        })
        .catch((reason: unknown) => {
          if (!isAbort(reason)) failed = true;
        });
    }

    return () => controller.abort();
  });

  const sides = $derived([
    { id: 'in', title: 'Where its money came from', empty: 'Nothing received', data: sources },
    { id: 'out', title: 'Where its money went', empty: 'Nothing sent', data: destinations }
  ] as const);
</script>

<section aria-labelledby="funds-heading" class="block">
  <div class="head">
    <h2 id="funds-heading">Source and destination of funds</h2>
    <div class="hops" role="group" aria-label="How many wallets deep to follow the money">
      <span class="muted small">Follow</span>
      {#each HOPS as option (option)}
        <button type="button" aria-pressed={hops === option} onclick={() => (hops = option)}>
          {option}
        </button>
      {/each}
      <span class="muted small">{hops === 1 ? 'hop' : 'hops'}</span>
    </div>
  </div>

  {#if failed}
    <p class="muted small">Could not load the trace. It will retry with the next update.</p>
  {/if}

  <div class="sides">
    {#each sides as side (side.id)}
      <div>
        <h3>
          {side.title}
          {#if side.data}
            <span class="muted small">{formatFlux(side.data.total)} FLUX</span>
          {/if}
        </h3>
        {#if !side.data}
          <p class="muted small">Loading…</p>
        {:else}
          <KindMix mix={side.data.byKind} empty={side.empty} />
          {#if Object.keys(side.data.byExchange).length > 0}
            <p class="small">
              <span class="muted">Exchanges:</span>
              {#each Object.entries(side.data.byExchange) as [name, amount], i (name)}{i > 0
                  ? ', '
                  : ' '}{name} <strong>{formatFlux(amount)}</strong>{/each}
            </p>
          {/if}
          {#if side.data.endpoints.length > 0}
            <table>
              <caption class="visually-hidden">
                Labelled wallets this money {side.id === 'in' ? 'came from' : 'reached'}, largest
                first
              </caption>
              <thead>
                <tr>
                  <th scope="col">{side.id === 'in' ? 'From' : 'To'}</th>
                  <th scope="col" class="num">FLUX</th>
                  <th scope="col" class="num">Hops away</th>
                </tr>
              </thead>
              <tbody>
                {#each side.data.endpoints as end (end.address)}
                  <tr>
                    <td>
                      <a href="/wallet/{end.address}" class:mono={!end.name} title={end.address}>
                        {end.name ?? shortAddress(end.address)}
                      </a>
                      <span class="muted small">{kindLabel(end.kind)}</span>
                    </td>
                    <td class="num strong" title="{formatFluxFull(end.amount)} FLUX">
                      {formatFlux(end.amount)}
                    </td>
                    <td class="num">{end.hop}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
          {#if side.data.truncated}
            <p class="muted small">
              Stopped early: this trace reaches too many wallets. What it did not follow is counted
              as unlabelled.
            </p>
          {/if}
        {/if}
      </div>
    {/each}
  </div>

  <p class="muted small">
    Within the stored window. Unlabelled wallets are followed up to {hops}
    {hops === 1 ? 'hop' : 'hops'} and their own mix is applied in proportion to what passed through them,
    so these are shares, not exact coins. Money still with an unlabelled wallet after the last hop shows
    as unlabelled.
  </p>
</section>

<style>
  .block {
    display: grid;
    gap: 0.75rem;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem 1rem;
  }

  h2 {
    margin: 0;
  }

  .hops {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .hops button {
    min-width: 2rem;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }

  .hops button[aria-pressed='true'] {
    border-color: var(--brand);
    background: var(--brand);
    color: var(--surface);
  }

  .hops button:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  .sides {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
    gap: 1.25rem 2rem;
  }

  h3 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.6rem;
    margin: 0 0 0.5rem;
    font-size: var(--step-0);
  }

  table {
    width: 100%;
    margin-top: 0.75rem;
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
    padding: 0.35rem 0.5rem 0.35rem 0;
    border-bottom: 1px solid var(--line);
    vertical-align: baseline;
  }

  td span {
    margin-left: 0.4rem;
  }

  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .strong {
    font-weight: 500;
  }

  .small {
    font-size: var(--step--1);
  }

  p {
    margin: 0.5rem 0 0;
  }
</style>
