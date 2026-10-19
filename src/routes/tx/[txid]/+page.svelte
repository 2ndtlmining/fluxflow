<!--
  Transaction page (#66): who paid in, who received, and how FluxFlow turned that into flows.

  Every input pays into every output in the same proportion, so one bar of funder shares
  explains every flow row: a funder that put in 40% is credited with 40% of each output. Flow
  rows keep the kinds they were classified with; a row whose wallet has been relabelled since
  is marked, and the party table shows the label as it is now.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { ApiError, isAbort } from '$lib/client/api';
  import { fetchTx, isTxid } from '$lib/client/endpoints';
  import {
    flowLabel,
    formatCount,
    formatFlux,
    formatFluxFull,
    formatSigned,
    formatTime,
    kindLabel,
    shortAddress
  } from '$lib/client/format';
  import type { TxDetail, TxParty } from '$lib/client/types';
  import ConfidenceBadge from '$lib/ui/ConfidenceBadge.svelte';

  /** Funders drawn as their own segment; the rest share one "others" segment. */
  const SEGMENTS = 6;
  /** Flow rows shown before "Show all". A 500-input sweep has 500 rows per output. */
  const FLOW_ROWS = 100;

  const txid = $derived((page.params.txid ?? '').toLowerCase());
  const valid = $derived(isTxid(txid));

  let tx = $state<TxDetail | null>(null);
  let missing = $state(false);
  let error = $state<string | null>(null);
  let allFlows = $state(false);
  let copied = $state(false);

  $effect(() => {
    const current = txid;
    if (!isTxid(current)) return;
    const controller = new AbortController();
    tx = null;
    missing = false;
    error = null;
    allFlows = false;

    fetchTx(current, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) tx = result;
      })
      .catch((reason: unknown) => {
        if (isAbort(reason)) return;
        if (reason instanceof ApiError && reason.status === 404) missing = true;
        else error = (reason as Error).message;
      });

    return () => controller.abort();
  });

  const funders = $derived((tx?.parties ?? []).filter((party) => party.role === 'funder'));
  const recipients = $derived((tx?.parties ?? []).filter((party) => party.role === 'recipient'));
  const change = $derived((tx?.parties ?? []).filter((party) => party.role === 'change'));
  const byAddress = $derived(new Map((tx?.parties ?? []).map((party) => [party.address, party])));

  // Segment order follows the party list (largest funder first), so colours match the legend.
  const segments = $derived.by(() => {
    const shown = funders.slice(0, SEGMENTS).map((party, index) => ({
      key: party.address,
      label: displayName(party),
      share: party.share ?? 0,
      tone: index
    }));
    const rest = funders.slice(SEGMENTS);
    if (rest.length > 0) {
      shown.push({
        key: 'others',
        label: `${formatCount(rest.length)} others`,
        share: rest.reduce((sum, party) => sum + (party.share ?? 0), 0),
        tone: SEGMENTS
      });
    }
    return shown;
  });
  const toneOf = $derived(
    new Map(funders.map((party, index) => [party.address, Math.min(index, SEGMENTS)]))
  );

  // Stored rows are in derivation order (by address); read them per recipient, largest first.
  const sortedFlows = $derived(
    [...(tx?.flows ?? [])].sort(
      (a, b) =>
        (a.toAddress < b.toAddress ? -1 : a.toAddress > b.toAddress ? 1 : 0) || b.amount - a.amount
    )
  );
  const flows = $derived(allFlows ? sortedFlows : sortedFlows.slice(0, FLOW_ROWS));
  const staleRows = $derived((tx?.flows ?? []).filter((flow) => flow.stale).length);

  function displayName(party: TxParty): string {
    return party.name ?? shortAddress(party.address);
  }

  function nameOf(address: string): string {
    const party = byAddress.get(address);
    return party ? displayName(party) : shortAddress(address);
  }

  /** Fees are fractions of a FLUX: show every significant satoshi rather than "0". */
  const formatFee = (fee: number) => (fee === 0 ? '0' : fee.toFixed(8).replace(/\.?0+$/, ''));

  /** A net amount; one that is only a fee is shown in full rather than as "−<0.01". */
  const signed = (net: number) =>
    Math.abs(net) >= 0.01
      ? formatSigned(net)
      : `${net < 0 ? '−' : net > 0 ? '+' : ''}${formatFee(Math.abs(net))}`;

  const percent = (share: number) =>
    share >= 0.9995 ? '100%' : share < 0.001 ? '<0.1%' : `${(share * 100).toFixed(1)}%`;

  const tone = (flowType: string) =>
    flowType === 'selling' ? 'sell' : flowType === 'buying' ? 'buy' : 'muted';

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(txid);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      /* clipboard blocked: the id is selectable text */
    }
  }
</script>

<svelte:head>
  <title>Transaction {txid.slice(0, 8)}… | FluxFlow</title>
</svelte:head>

<article class="tx">
  <p><a href="/">Back to the dashboard</a></p>

  {#if !valid}
    <h1>That isn't a transaction id</h1>
    <p class="muted">A FLUX transaction id is 64 hexadecimal characters (0-9, a-f).</p>
  {:else}
    <header>
      <h1>Transaction</h1>
      <p class="mono txid">{txid}</p>
      {#if tx}
        <p class="muted">
          Block <span class="mono">{formatCount(tx.height)}</span> · {formatTime(tx.time)}
        </p>
      {/if}
      <div class="actions">
        <button type="button" class="button" onclick={copy}>
          {copied ? 'Copied' : 'Copy id'}
        </button>
        <a
          class="button"
          href="https://explorer.runonflux.io/tx/{txid}"
          rel="noopener noreferrer"
          target="_blank">Open in block explorer</a
        >
      </div>
    </header>

    {#if error}
      <p role="alert" class="bad">Couldn't load this transaction: {error}</p>
    {:else if missing}
      <p class="muted">
        FluxFlow has no record of this transaction. It keeps transfers within its retention window
        only, and coinbase transactions without their node rewards. The block explorer has the full
        record.
      </p>
    {:else if !tx}
      <p class="muted" aria-busy="true"><span class="skeleton">loading transaction</span></p>
    {:else}
      <dl class="facts">
        <div>
          <dt>Paid in</dt>
          <dd title="{formatFluxFull(tx.totalIn)} FLUX">{formatFlux(tx.totalIn)}</dd>
        </div>
        <div>
          <dt>Paid out</dt>
          <dd title="{formatFluxFull(tx.totalOut)} FLUX">{formatFlux(tx.totalOut)}</dd>
        </div>
        <div>
          <dt>Fee</dt>
          <dd class="small-dd">{formatFee(tx.fee)} FLUX</dd>
        </div>
        <div>
          <dt>Flows recorded</dt>
          <dd>{formatCount(tx.flows.length)}</dd>
        </div>
      </dl>

      {#if tx.hops.length > 0}
        <section aria-labelledby="hop-heading" class="block callout">
          <h2 id="hop-heading">Part of an exchange hop</h2>
          {#each tx.hops as hop (hop.otherTxid + hop.leg)}
            <p>
              <a class="mono" href="/wallet/{hop.address}">{nameOf(hop.address)}</a>
              withdrew {formatFlux(hop.withdrawn)} FLUX from {hop.fromExchange} and deposited
              {formatFlux(hop.deposited)} into {hop.toExchange}
              {formatCount(hop.blocksApart)} blocks later. This transaction is the
              {hop.leg === 'buy' ? 'withdrawal' : 'deposit'};
              <a href="/tx/{hop.otherTxid}">the {hop.leg === 'buy' ? 'deposit' : 'withdrawal'}</a>
              is the other half. Hops are moves between exchanges, so neither half counts as buying or
              selling.
            </p>
          {/each}
        </section>
      {/if}

      {#if funders.length > 1}
        <section aria-labelledby="split-heading" class="block">
          <h2 id="split-heading">How the money is split</h2>
          <p class="muted">
            Every input pays into every output in the same proportion, so each funder is credited
            with its share of every amount received below.
          </p>
          <div class="bar" role="img" aria-label="Funder shares of the input">
            {#each segments as segment (segment.key)}
              <span
                class="segment tone-{segment.tone}"
                style:flex-grow={Math.max(segment.share, 0.004)}
                title="{segment.label}: {percent(segment.share)}"
              ></span>
            {/each}
          </div>
          <ul class="legend">
            {#each segments as segment (segment.key)}
              <li>
                <span class="swatch tone-{segment.tone}" aria-hidden="true"></span>
                <span>{segment.label}</span>
                <span class="muted">{percent(segment.share)}</span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      <section aria-labelledby="parties-heading" class="block">
        <h2 id="parties-heading">Who paid in and who received</h2>
        <p class="muted">
          Inputs and outputs of the same address are netted: an address that paid in 100 and got 70
          back as change paid 30. Labels are shown as they are now.
        </p>
        <div class="table-wrap">
          <table class="parties">
            <caption class="visually-hidden">Addresses in this transaction</caption>
            <thead>
              <tr>
                <th scope="col">Address</th>
                <th scope="col">Label</th>
                <th scope="col" class="num">Paid in</th>
                <th scope="col" class="num">Received</th>
                <th scope="col" class="num">Net</th>
              </tr>
            </thead>
            {#each [{ title: 'Funders', rows: funders }, { title: 'Recipients', rows: recipients }, { title: 'Change only (paid itself back exactly)', rows: change }] as group (group.title)}
              {#if group.rows.length > 0}
                <tbody>
                  <tr class="group"><th scope="rowgroup" colspan="5">{group.title}</th></tr>
                  {#each group.rows as party (party.address)}
                    <tr>
                      <td class="who">
                        {#if party.role === 'funder'}
                          <span
                            class="swatch tone-{toneOf.get(party.address) ?? SEGMENTS}"
                            aria-hidden="true"
                          ></span>
                        {/if}
                        <a class="mono" href="/wallet/{party.address}" title={party.address}
                          >{displayName(party)}</a
                        >
                        {#if party.name}
                          <span class="muted mono small">{shortAddress(party.address)}</span>
                        {/if}
                        {#if party.entity && party.entity.name !== party.name}
                          <span class="small">
                            part of
                            <a href="/entity/{encodeURIComponent(party.entity.id)}"
                              >{party.entity.name}</a
                            >
                          </span>
                        {/if}
                      </td>
                      <td class="label">
                        <span>{kindLabel(party.kind)}</span>
                        {#if party.label}
                          <ConfidenceBadge
                            level={party.label.level}
                            source={party.label.source}
                            confidence={party.label.confidence}
                          />
                        {/if}
                      </td>
                      <td class="num detail" title="{formatFluxFull(party.sent)} FLUX"
                        >{party.sent > 0 ? formatFlux(party.sent) : '–'}</td
                      >
                      <td class="num detail" title="{formatFluxFull(party.received)} FLUX"
                        >{party.received > 0 ? formatFlux(party.received) : '–'}</td
                      >
                      <td class="num net">
                        {signed(party.net)}
                        {#if party.share !== null}
                          <span class="muted small">{percent(party.share)} of input</span>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              {/if}
            {/each}
          </table>
        </div>
      </section>

      <section aria-labelledby="flows-heading" class="block">
        <h2 id="flows-heading">How FluxFlow classified it</h2>
        {#if tx.flows.length === 0}
          <p class="muted">No flows recorded. {tx.note ?? ''}</p>
        {:else}
          <p class="muted">
            One row per funder and recipient. Withdrawn from an exchange counts as buying, deposited
            to one as selling; everything else is wallet to wallet.
            {#if staleRows > 0}
              <strong class="warn">
                {formatCount(staleRows)}
                {staleRows === 1 ? 'row was' : 'rows were'} classified before a label changed
              </strong>
              and will be re-derived on the next relabel pass.
            {/if}
          </p>
          <div class="table-wrap">
            <table class="flows">
              <caption class="visually-hidden">Flows derived from this transaction</caption>
              <thead>
                <tr>
                  <th scope="col">From</th>
                  <th scope="col">To</th>
                  <th scope="col">What</th>
                  <th scope="col" class="num">Share</th>
                  <th scope="col" class="num">FLUX</th>
                </tr>
              </thead>
              <tbody>
                {#each flows as flow (flow.vout)}
                  <tr class:stale={flow.stale}>
                    <td class="from">
                      <span
                        class="swatch tone-{toneOf.get(flow.fromAddress) ?? SEGMENTS}"
                        aria-hidden="true"
                      ></span>
                      <a class="mono" href="/wallet/{flow.fromAddress}" title={flow.fromAddress}
                        >{nameOf(flow.fromAddress)}</a
                      >
                      <span class="muted small">{kindLabel(flow.fromKind)}</span>
                    </td>
                    <td class="to">
                      <a class="mono" href="/wallet/{flow.toAddress}" title={flow.toAddress}
                        >{nameOf(flow.toAddress)}</a
                      >
                      <span class="muted small">{kindLabel(flow.toKind)}</span>
                    </td>
                    <td class="what">
                      <span class={tone(flow.flowType)}>{flowLabel(flow.flowType)}</span>
                      {#if flow.fromKind === 'exchange' && flow.toKind === 'exchange'}
                        <span class="muted small">between exchange wallets, not a trade</span>
                      {/if}
                      {#if flow.exchange}<span class="muted small">{flow.exchange}</span>{/if}
                      {#if flow.stale}<span class="warn small">label changed since</span>{/if}
                    </td>
                    <td class="num muted share" title="Share of what the recipient received"
                      >{percent(flow.share)}</td
                    >
                    <td class="num amount" title="{formatFluxFull(flow.amount)} FLUX"
                      >{formatFlux(flow.amount)}</td
                    >
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if !allFlows && tx.flows.length > FLOW_ROWS}
            <button type="button" class="button more" onclick={() => (allFlows = true)}>
              Show all {formatCount(tx.flows.length)} rows
            </button>
          {/if}
        {/if}
      </section>
    {/if}
  {/if}
</article>

<style>
  .tx {
    display: grid;
    gap: 1.75rem;
    padding-top: 1.5rem;
  }

  header {
    display: grid;
    gap: 0.5rem;
  }

  header p {
    margin: 0;
  }

  h1 {
    font-size: var(--step-2);
  }

  .txid {
    word-break: break-all;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .button {
    padding: 0.5rem 0.9rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-weight: 500;
    text-decoration: none;
    cursor: pointer;
  }

  .more {
    justify-self: start;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
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

  .block > p {
    margin: 0;
  }

  .callout {
    padding: 0.75rem 1rem;
    border-left: 3px solid var(--brand);
    background: var(--surface);
    border-radius: var(--radius-s);
  }

  .bad {
    color: var(--bad);
  }

  .warn {
    color: var(--warn);
  }

  .small {
    font-size: var(--step--1);
  }

  /* Funder shares: one bar, one tone per funder, matched in the legend and the tables. */
  .bar {
    display: flex;
    height: 1.25rem;
    border-radius: var(--radius-s);
    overflow: hidden;
    gap: 2px;
    background: var(--surface-2);
  }

  .segment {
    flex-basis: 0;
    min-width: 3px;
  }

  .tone-0 {
    background: var(--brand);
  }
  .tone-1 {
    background: color-mix(in srgb, var(--brand) 72%, var(--surface));
  }
  .tone-2 {
    background: color-mix(in srgb, var(--brand) 52%, var(--surface));
  }
  .tone-3 {
    background: color-mix(in srgb, var(--brand) 36%, var(--surface));
  }
  .tone-4 {
    background: color-mix(in srgb, var(--brand) 24%, var(--surface));
  }
  .tone-5 {
    background: color-mix(in srgb, var(--brand) 15%, var(--surface));
  }
  .tone-6 {
    background: var(--line);
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 1.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--step--1);
  }

  .legend li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .swatch {
    display: inline-block;
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 2px;
    border: 1px solid var(--line);
    vertical-align: middle;
    margin-right: 0.3rem;
  }

  .table-wrap {
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
    padding: 0.4rem 0.5rem 0.4rem 0;
    border-bottom: 1px solid var(--line);
  }

  tr.group th {
    padding-top: 1rem;
    color: var(--text);
    font-weight: 600;
  }

  td {
    padding: 0.55rem 0.5rem 0.55rem 0;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }

  tbody tr {
    content-visibility: auto;
    contain-intrinsic-size: auto 3.25rem;
  }

  td > span:not(.swatch),
  td > a + span {
    display: block;
  }

  tr.stale td {
    background: color-mix(in srgb, var(--warn) 7%, transparent);
  }

  .num {
    text-align: right;
    white-space: nowrap;
    padding-right: 0;
  }

  td.num {
    font-weight: 600;
  }

  td.num .small {
    font-weight: 400;
  }

  /* Phone: rows become compact blocks rather than a wide table. */
  @media (max-width: 640px) {
    thead {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }

    tbody tr:not(.group) {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0.15rem 0.75rem;
      padding: 0.6rem 0;
      border-bottom: 1px solid var(--line);
    }

    td {
      padding: 0;
      border: 0;
    }

    /* Parties: who and net on top, label below; the gross in/out columns are in the net. */
    .parties tbody tr:not(.group) {
      grid-template-areas: 'who net' 'label net';
    }
    .parties .detail {
      display: none;
    }
    .who {
      grid-area: who;
    }
    .label {
      grid-area: label;
    }
    .net {
      grid-area: net;
    }

    /* Flows: from and amount, then to and share, then what it counted as. */
    .flows tbody tr {
      grid-template-areas: 'from amount' 'to share' 'what what';
    }
    .from {
      grid-area: from;
    }
    .to {
      grid-area: to;
    }
    .to::before {
      content: '→ ';
      color: var(--text-muted);
    }
    .what {
      grid-area: what;
    }
    .share {
      grid-area: share;
    }
    .amount {
      grid-area: amount;
    }
  }
</style>
