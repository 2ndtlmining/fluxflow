<!--
  What a wallet or entity holds, and held over the stored window (#67).

  The line is a daily closing balance rebuilt backwards from the node's current balance, so
  accumulation, distribution and "emptied before a sale" read straight off it. Without a node
  there is no anchor and the line is the running net change instead, labelled as such.
  Plain SVG, measured from zero so a near-empty wallet looks near-empty.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { isAbort } from '$lib/client/api';
  import {
    formatDate,
    formatFlux,
    formatFluxFull,
    formatSigned,
    formatTime
  } from '$lib/client/format';
  import { balanceSteps } from '$lib/client/series';
  import type { BalanceHistory } from '$lib/client/types';

  interface Props {
    /** Re-fetched whenever `key` changes. */
    load: (signal: AbortSignal) => Promise<BalanceHistory>;
    key: string;
    /** "this wallet" / "these wallets", for the sentences. */
    subject?: string;
  }

  let { load, key, subject = 'this wallet' }: Props = $props();

  const WIDTH = 1000;
  const HEIGHT = 200;
  const PAD = 8;

  let data = $state<BalanceHistory | null>(null);
  let failed = $state(false);
  let active = $state<number | null>(null);

  $effect(() => {
    void key;
    const controller = new AbortController();
    data = null;
    failed = false;
    // Only `key` decides when to reload; a parent re-render may pass a new `load` closure.
    untrack(() => load)(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) data = result;
      })
      .catch((reason: unknown) => {
        if (!isAbort(reason)) failed = true;
      });
    return () => controller.abort();
  });

  const anchored = $derived(data?.balance !== null && data?.balance !== undefined);
  const steps = $derived(data ? balanceSteps(data.series, data.opening) : []);
  const low = $derived(Math.min(0, ...steps.map((s) => s.value)));
  const high = $derived(Math.max(low + 1, ...steps.map((s) => s.value)));
  const y = (value: number) => HEIGHT - PAD - ((value - low) / (high - low)) * (HEIGHT - 2 * PAD);
  const x = (index: number) => (steps.length <= 1 ? 0 : (index / (steps.length - 1)) * WIDTH);

  // A step line: each day's value holds until the next day's.
  const line = $derived(
    steps
      .map((s, i) =>
        i === 0
          ? `M${x(i).toFixed(1)},${y(s.value).toFixed(1)}`
          : `H${x(i).toFixed(1)}V${y(s.value).toFixed(1)}`
      )
      .join('')
  );
  const area = $derived(steps.length > 0 ? `${line}V${y(low).toFixed(1)}H${x(0).toFixed(1)}Z` : '');
  const shown = $derived(active === null ? steps.at(-1) : steps[active]);
  const change = $derived(data?.series.at(-1)?.change ?? 0);

  function hover(event: PointerEvent): void {
    const box = (event.currentTarget as SVGElement).getBoundingClientRect();
    const fraction = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
    active = Math.round(fraction * (steps.length - 1));
  }
</script>

<section aria-labelledby="balance-heading" class="block">
  <h2 id="balance-heading">Balance</h2>

  {#if failed}
    <p class="muted">Couldn't load the balance history.</p>
  {:else if !data}
    <p class="muted" aria-busy="true"><span class="skeleton">loading balance</span></p>
  {:else}
    <dl class="facts">
      <div>
        <dt>Holds now</dt>
        {#if anchored}
          <dd title="{formatFluxFull(data.balance!)} FLUX">{formatFlux(data.balance!)}</dd>
        {:else}
          <dd class="small-dd muted">Unknown</dd>
        {/if}
      </div>
      {#if data.series.length > 0}
        <div>
          <dt>Held before {formatDate(data.series[0]!.time)}</dt>
          {#if anchored && data.opening !== null}
            <dd title="{formatFluxFull(data.opening)} FLUX">{formatFlux(data.opening)}</dd>
          {:else}
            <dd class="small-dd muted">Unknown</dd>
          {/if}
        </div>
        <div>
          <dt>Change since</dt>
          <dd class:buy={change > 0} class:sell={change < 0} title="{formatFluxFull(change)} FLUX">
            {formatSigned(change)}
          </dd>
        </div>
      {/if}
    </dl>

    {#if steps.length > 1}
      <figure>
        <p class="readout" aria-live="polite">
          {#if shown}
            <span class="muted">{formatDate(shown.time)}</span>
            <strong
              >{anchored ? '' : 'Net '}{anchored
                ? formatFlux(shown.value)
                : formatSigned(shown.value)} FLUX</strong
            >
          {/if}
        </p>
        <!-- Hover only moves the readout; the label and the facts above carry the values. -->
        <svg
          viewBox="0 0 {WIDTH} {HEIGHT}"
          preserveAspectRatio="none"
          role="img"
          aria-label="{anchored ? 'Balance' : 'Net change'} from {formatFlux(
            steps[0]!.value
          )} on {formatDate(steps[0]!.time)} to {formatFlux(steps.at(-1)!.value)} on {formatDate(
            steps.at(-1)!.time
          )}"
          onpointermove={hover}
          onpointerleave={() => (active = null)}
        >
          {#if low < 0}
            <line class="zero" x1="0" x2={WIDTH} y1={y(0)} y2={y(0)} />
          {/if}
          <path class="area" d={area} />
          <path class="line" d={line} vector-effect="non-scaling-stroke" />
          {#if active !== null}
            <line
              class="cursor"
              x1={x(active)}
              x2={x(active)}
              y1="0"
              y2={HEIGHT}
              vector-effect="non-scaling-stroke"
            />
          {/if}
        </svg>
        <div class="axis muted small">
          <span>{formatDate(steps[0]!.time)}</span>
          {#if anchored}<span>peak {formatFlux(high)}</span>{/if}
          <span>{formatDate(steps.at(-1)!.time)}</span>
        </div>
      </figure>
    {/if}

    <p class="muted small">
      {#if anchored}
        Rebuilt backwards from today's balance of {subject} on your node
        {#if data.asOf}(read {formatTime(data.asOf / 1000)}){/if}, one day at a time, across the
        stored history. Every transaction counts, including node rewards and fees.
      {:else if data.series.length > 0}
        No node with an address index is configured (FLUX_NODE_URL), or it didn't answer, so the
        line is the net change since the first stored day rather than the balance.
      {:else}
        No stored transactions for {subject}.
      {/if}
    </p>
    {#if !data.consistent}
      <p class="warn small" role="note">
        Going back from today's balance, the line would drop below zero, so some transactions are
        missing from the stored data. That can happen while FluxFlow is still catching up to the
        node. Treat the older part of the line as approximate.
      </p>
    {/if}
  {/if}
</section>

<style>
  .block {
    display: grid;
    gap: 0.75rem;
  }

  .block > p {
    margin: 0;
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

  figure {
    margin: 0;
    display: grid;
    gap: 0.35rem;
  }

  .readout {
    margin: 0;
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
    font-size: var(--step--1);
    min-height: 1.3em;
  }

  svg {
    width: 100%;
    height: 12rem;
    display: block;
    touch-action: pan-y;
  }

  .area {
    fill: color-mix(in srgb, var(--brand) 14%, transparent);
  }

  .line {
    fill: none;
    stroke: var(--brand);
    stroke-width: 2;
  }

  .zero {
    stroke: var(--line);
    stroke-dasharray: 4 4;
  }

  .cursor {
    stroke: var(--text-muted);
    stroke-width: 1;
  }

  .axis {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }

  .small {
    font-size: var(--step--1);
  }

  .warn {
    color: var(--warn);
  }
</style>
