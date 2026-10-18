<!--
  Flux app payments: transfers into the app hosting addresses in the period, who paid them,
  how those wallets were funded (two hops up), and where the hosting addresses sent the money.

  Payments stay wallet-to-wallet transfers everywhere else; this page is where they are named.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { isAbort, peek } from '$lib/client/api';
  import { fetchApps } from '$lib/client/endpoints';
  import {
    formatCount,
    formatFlux,
    formatFluxFull,
    formatTime,
    kindLabel,
    shortAddress,
    timeAgo
  } from '$lib/client/format';
  import { live } from '$lib/client/live.svelte';
  import type { AppPayments } from '$lib/client/types';
  import { isPeriodId, type PeriodId } from '$lib/shared/constants';
  import KindMix from '$lib/ui/KindMix.svelte';
  import PartyTable from '$lib/ui/PartyTable.svelte';
  import PeriodTabs from '$lib/ui/PeriodTabs.svelte';

  // App fees are small and steady: a month is the useful default, not a day.
  const DEFAULT: PeriodId = '30D';
  const period = $derived.by((): PeriodId => {
    const raw = (page.url.searchParams.get('period') ?? '').toUpperCase();
    return isPeriodId(raw) ? raw : DEFAULT;
  });

  let data = $state<AppPayments | undefined>();
  let error = $state<string | null>(null);

  $effect(() => live.start());

  $effect(() => {
    const current = period;
    void live.version;
    const controller = new AbortController();
    data = peek<AppPayments>(`/apps?period=${current}`) ?? data;

    fetchApps(current, controller.signal)
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

  // Every day of the period, quiet ones as zero, so the columns are a true timeline.
  const DAY = 86_400;
  const days = $derived.by(() => {
    const series = data?.series ?? [];
    if (series.length === 0) return [];
    const byDay = new Map(series.map((day) => [day.time, day]));
    const first = series[0]!.time;
    const last = series.at(-1)!.time;
    const filled = [];
    for (let time = first; time <= last; time += DAY) {
      filled.push(byDay.get(time) ?? { time, total: 0, count: 0 });
    }
    return filled;
  });
  const peak = $derived(Math.max(1, ...days.map((day) => day.total)));
  let active = $state<number | null>(null);
  const dayLabel = (time: number) =>
    new Date(time * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const foundationShare = $derived(data?.fundingOfPayments.foundation ?? 0);
  const now = Date.now();
</script>

<svelte:head>
  <title>App payments | FluxFlow</title>
</svelte:head>

<article class="apps">
  <p><a href="/">Back to the dashboard</a></p>
  <h1>Flux app payments</h1>
  <p class="muted lede">
    FLUX paid to host apps on Flux. Who pays, how much, and where that money came from.
  </p>
  <PeriodTabs current={period} href={(p) => (p === DEFAULT ? '/apps' : `/apps?period=${p}`)} />

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if !data}
    <p class="muted" aria-busy="true">Loading app payments…</p>
  {:else if data.hosting.length === 0}
    <p class="note">
      No app hosting address is configured. Add one under <code>appHosting</code> in
      <code>config/labels.json</code>.
    </p>
  {:else}
    <dl class="facts">
      <div>
        <dt>Paid for apps</dt>
        <dd title="{formatFluxFull(data.total)} FLUX">{formatFlux(data.total)}</dd>
      </div>
      <div>
        <dt>Payments</dt>
        <dd>{formatCount(data.count)}</dd>
      </div>
      <div>
        <dt>Paying wallets</dt>
        <dd>{formatCount(data.payers)}</dd>
      </div>
      <div>
        <dt>Traced to the Foundation</dt>
        <dd class="small-dd">
          {Math.round(foundationShare * 100)}% <span class="muted">of the top payers' fees</span>
        </dd>
      </div>
    </dl>
    <p class="muted small">
      Paid into
      {#each data.hosting as host, i (host.address)}{i > 0 ? ', ' : ' '}<a
          href="/wallet/{host.address}">{host.name ?? shortAddress(host.address)}</a
        >
        (<a href="/graph?root={host.address}&period={period}">follow the money</a>){/each},
      {formatTime(data.fromTime)} to {formatTime(data.toTime)}.
    </p>

    {#if data.count > 0}
      <section aria-labelledby="funding-heading" class="block">
        <h2 id="funding-heading">Where the fee money came from</h2>
        <KindMix mix={data.fundingOfPayments} fractions />
        <p class="muted small">
          Each top payer's inflows split by who sent them; an unlabelled sender is followed one
          wallet further. Weighted by what each payer spent on apps. An indication, not an audit: it
          ignores the order money arrived in.
        </p>
      </section>

      {#if days.length > 1}
        <section aria-labelledby="when-heading" class="block">
          <h2 id="when-heading">Per day</h2>
          <figure>
            <svg
              viewBox="0 0 {days.length * 10} 100"
              preserveAspectRatio="none"
              role="img"
              aria-label="FLUX paid for Flux apps per day: {formatFluxFull(
                data.total
              )} FLUX over {days.length} days, peaking at {formatFluxFull(peak)}"
            >
              {#each days as day, i (day.time)}
                {@const height = (day.total / peak) * 96}
                <!-- Hover only reveals one day's figures; the label carries the summary. -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <g
                  class:dim={active !== null && active !== i}
                  onpointerenter={() => (active = i)}
                  onpointerleave={() => (active = null)}
                >
                  <rect x={i * 10} y="0" width="10" height="100" fill="transparent" />
                  <rect class="col" x={i * 10 + 1.5} y={100 - height} width="7" {height} />
                </g>
              {/each}
            </svg>
            <figcaption class="small">
              {#if active !== null && days[active]}
                {@const day = days[active]}
                <span>{dayLabel(day.time)}</span>
                <strong>{formatFlux(day.total)} FLUX</strong>
                <span class="muted">in {formatCount(day.count)} payments</span>
              {:else}
                <span class="muted">Hover a column for that day's payments.</span>
              {/if}
            </figcaption>
          </figure>
        </section>
      {/if}

      <section aria-labelledby="payers-heading" class="block">
        <h2 id="payers-heading">Who pays</h2>
        <div class="scroll">
          <table>
            <caption class="visually-hidden">Wallets paying app hosting fees, largest first</caption
            >
            <thead>
              <tr>
                <th scope="col">Payer</th>
                <th scope="col" class="num">Paid</th>
                <th scope="col" class="num">Payments</th>
                <th scope="col">Funded by</th>
                <th scope="col">Largest senders</th>
                <th scope="col" class="num">Last</th>
              </tr>
            </thead>
            <tbody>
              {#each data.topPayers as payer (payer.address)}
                <tr>
                  <td>
                    <a
                      href="/wallet/{payer.address}"
                      class:mono={!payer.name}
                      title={payer.address}
                    >
                      {payer.name ?? shortAddress(payer.address)}
                    </a>
                    <span class="muted small">{kindLabel(payer.kind)}</span>
                  </td>
                  <td class="num strong" title="{formatFluxFull(payer.total)} FLUX">
                    {formatFlux(payer.total)}
                    <span class="muted small">{Math.round(payer.share * 100)}%</span>
                  </td>
                  <td class="num">{formatCount(payer.count)}</td>
                  <td class="mix">
                    <KindMix mix={payer.fundedBy.mix} legend={false} />
                    {#if payer.fundedBy.received > 0}
                      <span class="muted small">{formatFlux(payer.fundedBy.received)} received</span
                      >
                    {/if}
                  </td>
                  <td class="funders small">
                    {#each payer.topFunders as funder (funder.address)}
                      <a
                        href="/wallet/{funder.address}"
                        class:mono={!funder.name}
                        title={funder.address}
                      >
                        {funder.name ?? shortAddress(funder.address, 4)}
                      </a>
                      <span class="muted">{formatFlux(funder.total)}</span>
                    {/each}
                  </td>
                  <td class="num muted small">{timeAgo(payer.lastSeen, now)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <KindMix keyOnly />
      </section>

      {#if data.outflows.recipients.length > 0}
        <section aria-labelledby="out-heading" class="block">
          <h2 id="out-heading">Where the hosting address sends it</h2>
          <p class="muted small">{formatFlux(data.outflows.total)} FLUX sent on in the period.</p>
          <PartyTable
            parties={data.outflows.recipients}
            column="To"
            caption="Where the app hosting addresses sent FLUX, largest first"
          />
        </section>
      {/if}
    {:else}
      <p class="muted">No app payments stored for this period.</p>
    {/if}
  {/if}
</article>

<style>
  .apps {
    display: grid;
    gap: 1.5rem;
    padding-top: 1.5rem;
  }

  h1 {
    font-size: var(--step-2);
  }

  .lede {
    margin: -0.75rem 0 0;
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

  .scroll {
    overflow-x: auto;
  }

  figure {
    margin: 0;
  }

  svg {
    display: block;
    width: 100%;
    height: 8rem;
  }

  .col {
    fill: var(--good);
  }

  .dim .col {
    opacity: 0.4;
  }

  figcaption {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    min-height: 1.5rem;
    margin-top: 0.4rem;
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
    padding: 0.5rem 0.75rem 0.5rem 0;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }

  td:first-child > *,
  td.mix > * {
    display: block;
  }

  td.mix {
    min-width: 8rem;
  }

  td.mix span {
    margin-top: 0.25rem;
  }

  .funders {
    display: grid;
    grid-template-columns: auto auto;
    gap: 0.1rem 0.5rem;
    justify-content: start;
  }

  .num {
    text-align: right;
    white-space: nowrap;
  }

  td.num > .small {
    display: block;
    font-weight: 400;
  }

  th:last-child,
  td:last-child {
    padding-right: 0;
  }

  .strong {
    font-weight: 600;
  }

  .small {
    font-size: var(--step--1);
  }

  .note {
    max-width: 62ch;
  }

  .error {
    color: var(--bad);
  }
</style>
