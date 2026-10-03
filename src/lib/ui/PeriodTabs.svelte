<!--
  Period choice as plain links, so it works by keyboard, by middle-click into a new tab and
  without JavaScript; the URL is the state (#26).
-->
<script lang="ts">
  import { PERIOD_IDS, type PeriodId } from '$lib/shared/constants';

  interface Props {
    current: PeriodId;
    /** Builds the link for a period, keeping the other query parameters. */
    href: (period: PeriodId) => string;
  }

  let { current, href }: Props = $props();

  const LABELS: Record<PeriodId, string> = {
    '24H': '24 hours',
    '7D': '7 days',
    '30D': '30 days',
    '90D': '90 days',
    '6M': '6 months'
  };
</script>

<nav aria-label="Time period">
  <ul>
    {#each PERIOD_IDS as period (period)}
      <li>
        <a
          href={href(period)}
          aria-current={period === current ? 'page' : undefined}
          data-sveltekit-noscroll
          data-sveltekit-keepfocus
        >
          <span class="short" aria-hidden="true">{period}</span>
          <span class="long">{LABELS[period]}</span>
        </a>
      </li>
    {/each}
  </ul>
</nav>

<style>
  ul {
    display: flex;
    gap: 0.25rem;
    margin: 0;
    padding: 0.25rem;
    list-style: none;
    background: var(--surface-2);
    border-radius: var(--radius-m);
    width: fit-content;
    max-width: 100%;
  }

  a {
    display: block;
    padding: 0.4rem 0.75rem;
    border-radius: calc(var(--radius-m) - 3px);
    text-decoration: none;
    color: var(--text-muted);
    font-weight: 500;
    white-space: nowrap;
  }

  a:hover {
    color: var(--text);
  }

  a[aria-current='page'] {
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 0 0 1px var(--line);
  }

  .short {
    display: none;
  }

  @media (max-width: 560px) {
    .short {
      display: inline;
    }
    .long {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }
    a {
      padding: 0.4rem 0.6rem;
    }
  }
</style>
