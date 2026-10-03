<!--
  Flux Foundation (#31): every Foundation wallet, its balance and movements in the period,
  the balance over time, and the latest transfers in or out. Moves between Foundation wallets
  are netted per transaction, so they never show up as outflow plus inflow.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { isAbort, peek } from '$lib/client/api';
  import { fetchFoundation, foundationPath } from '$lib/client/endpoints';
  import {
    formatCount,
    formatFlux,
    formatFluxFull,
    formatSigned,
    formatTime,
    kindLabel,
    shortAddress,
    timeAgo
  } from '$lib/client/format';
  import { live } from '$lib/client/live.svelte';
  import type { Foundation } from '$lib/client/types';
  import { DEFAULT_PERIOD, isPeriodId, type PeriodId } from '$lib/shared/constants';
  import PeriodTabs from '$lib/ui/PeriodTabs.svelte';

  const period = $derived.by((): PeriodId => {
    const raw = (page.url.searchParams.get('period') ?? '').toUpperCase();
    return isPeriodId(raw) ? raw : DEFAULT_PERIOD;
  });

  let data = $state<Foundation | undefined>();
  let error = $state<string | null>(null);

  $effect(() => live.start());

  $effect(() => {
    const current = period;
    void live.version;
    const controller = new AbortController();
    data = peek<Foundation>(foundationPath(current)) ?? data;

    fetchFoundation(current, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          data = result;
          error = null;
        }
      })
      .catch((reason: unknown) => {
        if (!isAbort(reason)) error = (reason as Error).message;
      });

    return () => controller.abort();
  });

  const wallets = $derived(
    [...(data?.wallets ?? [])].sort(
      (a, b) => (b.balance ?? 0) - (a.balance ?? 0) || Math.abs(b.net) - Math.abs(a.net)
    )
  );

  // Balance history as a line; nulls (no node to ask) are skipped.
  const WIDTH = 1000;
  const HEIGHT = 160;
  const history = $derived(
    (data?.series ?? []).filter(
      (point): point is { time: number; net: number; balance: number } => point.balance !== null
    )
  );
  const range = $derived({
    min: Math.min(...history.map((point) => point.balance)),
    max: Math.max(...history.map((point) => point.balance))
  });

  const line = $derived.by(() => {
    if (history.length < 2) return '';
    const values = history.map((point) => point.balance);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const step = WIDTH / (history.length - 1);
    return history
      .map(
        (point, i) =>
          `${(i * step).toFixed(1)},${(HEIGHT - 8 - ((point.balance - min) / span) * (HEIGHT - 16)).toFixed(1)}`
      )
      .join(' ');
  });

  const now = Date.now();
</script>

<svelte:head>
  <title>Flux Foundation | FluxFlow</title>
</svelte:head>

<article class="foundation">
  <p><a href="/{period === DEFAULT_PERIOD ? '' : `?period=${period}`}">Back to the dashboard</a></p>
  <h1>Flux Foundation</h1>
  <PeriodTabs
    current={period}
    href={(p) => (p === DEFAULT_PERIOD ? '/foundation' : `/foundation?period=${p}`)}
  />

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if !data}
    <p class="muted" aria-busy="true">Loading Foundation wallets…</p>
  {:else}
    <dl class="facts">
      {#if data.totals.balance !== null}
        <div>
          <dt>Holds</dt>
          <dd title="{formatFluxFull(data.totals.balance)} FLUX">
            {formatFlux(data.totals.balance)}
          </dd>
        </div>
      {/if}
      <div>
        <dt>Received</dt>
        <dd class="buy">{formatFlux(data.totals.inflow)}</dd>
      </div>
      <div>
        <dt>Sent</dt>
        <dd class="sell">{formatFlux(data.totals.outflow)}</dd>
      </div>
      <div>
        <dt>Net</dt>
        <dd class={data.totals.net < 0 ? 'sell' : data.totals.net > 0 ? 'buy' : ''}>
          {formatSigned(data.totals.net)}
        </dd>
      </div>
      <div>
        <dt>Between its own wallets</dt>
        <dd class="small-dd">
          {formatCount(data.totals.internalTransfers)} moves, {formatFlux(
            data.totals.internalVolume
          )} FLUX
        </dd>
      </div>
    </dl>
    {#if data.balancesAsOf}
      <p class="muted small">Balances as of {formatTime(data.balancesAsOf / 1000)}.</p>
    {:else}
      <p class="muted small">
        Balances need FluxFlow to be connected to a node with an address index (FLUX_NODE_URL).
      </p>
    {/if}

    {#if line}
      <section aria-labelledby="balance-heading" class="block">
        <h2 id="balance-heading">Balance over the period</h2>
        <svg
          viewBox="0 0 {WIDTH} {HEIGHT}"
          preserveAspectRatio="none"
          role="img"
          aria-label="Foundation balance from {formatFlux(history[0]!.balance)} to {formatFlux(
            history.at(-1)!.balance
          )} FLUX"
        >
          <polyline points={line} class="balance" />
        </svg>
        <p class="muted small">
          From {formatFlux(history[0]!.balance)} on {formatTime(history[0]!.time)} to
          {formatFlux(history.at(-1)!.balance)} on {formatTime(history.at(-1)!.time)}. The line is
          scaled to its own range, {formatFlux(range.min)} to {formatFlux(range.max)}, so small
          changes look large.
        </p>
      </section>
    {/if}

    <section aria-labelledby="wallets-heading" class="block">
      <h2 id="wallets-heading">Wallets</h2>
      <table>
        <caption class="visually-hidden">Foundation wallets, largest balance first</caption>
        <thead>
          <tr>
            <th scope="col">Wallet</th>
            <th scope="col" class="num">Balance</th>
            <th scope="col" class="num">Received</th>
            <th scope="col" class="num">Sent</th>
            <th scope="col" class="num">Net</th>
          </tr>
        </thead>
        <tbody>
          {#each wallets as wallet (wallet.address)}
            <tr>
              <td>
                <a href="/wallet/{wallet.address}">
                  {wallet.subLabel ?? wallet.name ?? 'Foundation wallet'}
                </a>
                <span class="mono muted small">{shortAddress(wallet.address)}</span>
              </td>
              <td class="num">{wallet.balance === null ? '–' : formatFlux(wallet.balance)}</td>
              <td class="num buy">{wallet.inflow ? formatFlux(wallet.inflow) : ''}</td>
              <td class="num sell">{wallet.outflow ? formatFlux(wallet.outflow) : ''}</td>
              <td class="num {wallet.net < 0 ? 'sell' : wallet.net > 0 ? 'buy' : 'muted'}">
                {wallet.net ? formatSigned(wallet.net) : '0'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>

    <section aria-labelledby="recent-heading" class="block">
      <h2 id="recent-heading">Latest movements</h2>
      {#if data.recent.length === 0}
        <p class="muted">No FLUX moved in or out of Foundation wallets in this period.</p>
      {:else}
        <ul class="recent">
          {#each data.recent as move (move.txid)}
            <li>
              <span class="amount {move.amount < 0 ? 'sell' : 'buy'}">
                {move.amount < 0 ? 'Sent' : 'Received'}
                {formatFlux(Math.abs(move.amount))}
              </span>
              <span>
                {move.amount < 0 ? 'to' : 'from'}
                <a href="/wallet/{move.counterparty}" class:mono={!move.counterpartyName}>
                  {move.counterpartyName ?? shortAddress(move.counterparty)}
                </a>
                <span class="muted">({kindLabel(move.counterpartyKind)})</span>
              </span>
              <a
                class="muted small when"
                href="https://explorer.runonflux.io/tx/{move.txid}"
                rel="noopener noreferrer"
                target="_blank"
                title={formatTime(move.time)}>{timeAgo(move.time, now)}</a
              >
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</article>

<style>
  .foundation {
    display: grid;
    gap: 1.5rem;
    padding-top: 1.5rem;
  }

  h1 {
    font-size: var(--step-2);
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: 1rem 1.5rem;
    margin: 0;
  }

  dt {
    font-size: var(--step--1);
    color: var(--text-muted);
  }

  dd {
    margin: 0;
    font-size: var(--step-2);
    font-weight: 600;
  }

  .small-dd {
    font-size: var(--step-0);
    font-weight: 500;
  }

  .block {
    display: grid;
    gap: 0.75rem;
  }

  svg {
    width: 100%;
    height: 9rem;
  }

  .balance {
    fill: none;
    stroke: var(--brand);
    stroke-width: 2.5;
    vector-effect: non-scaling-stroke;
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

  .num {
    text-align: right;
    white-space: nowrap;
  }

  td.num {
    font-weight: 600;
  }

  th:last-child,
  td:last-child {
    padding-right: 0;
  }

  .recent {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .recent li {
    display: grid;
    grid-template-columns: 9rem minmax(0, 1fr) auto;
    gap: 0.75rem;
    padding: 0.5rem 0;
    border-top: 1px solid var(--line);
  }

  .amount {
    font-weight: 600;
  }

  .small {
    font-size: var(--step--1);
  }

  .error {
    color: var(--bad);
  }

  @media (max-width: 640px) {
    th:nth-child(3),
    td:nth-child(3),
    th:nth-child(4),
    td:nth-child(4) {
      display: none;
    }

    .recent li {
      grid-template-columns: 1fr auto;
    }

    .recent li > :nth-child(2) {
      grid-column: 1 / -1;
      grid-row: 2;
    }
  }
</style>
