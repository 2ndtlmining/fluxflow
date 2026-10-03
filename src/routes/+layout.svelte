<script lang="ts">
  import '../app.css';
  import { onMount, type Snippet } from 'svelte';
  import LiveToasts from '$lib/ui/LiveToasts.svelte';
  import SearchBox from '$lib/ui/SearchBox.svelte';
  import StatusBar from '$lib/ui/StatusBar.svelte';

  let { children }: { children: Snippet } = $props();

  let dark = $state(false);

  onMount(() => {
    const explicit = document.documentElement.dataset.theme;
    dark = explicit ? explicit === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  });

  function toggleTheme(): void {
    dark = !dark;
    const theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('fluxflow-theme', theme);
    } catch {
      /* storage unavailable: the choice lasts for this page only */
    }
  }
</script>

<a class="skip" href="#main">Skip to content</a>

<header class="top">
  <div class="inner">
    <a class="brand" href="/" aria-label="FluxFlow home">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path d="M2 12h9" stroke="var(--sell)" stroke-width="3" stroke-linecap="round" />
        <path d="M13 12h9" stroke="var(--buy)" stroke-width="3" stroke-linecap="round" />
        <path d="M12 4v16" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
      FluxFlow
    </a>
    <StatusBar />
    <SearchBox />
    <button
      type="button"
      class="theme"
      onclick={toggleTheme}
      aria-pressed={dark}
      aria-label="Dark theme"
      title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        {#if dark}
          <circle cx="12" cy="12" r="5" fill="currentColor" />
          <path
            d="M12 1v3M12 20v3M1 12h3M20 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        {:else}
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="currentColor" />
        {/if}
      </svg>
    </button>
  </div>
</header>

<main id="main">
  {@render children()}
</main>

<LiveToasts />

<footer class="foot muted">
  <p>
    On-chain FLUX moving to and from tracked exchange wallets. Labels are a best effort; an
    unlabelled wallet may belong to anyone.
  </p>
</footer>

<style>
  .skip {
    position: absolute;
    left: -9999px;
    top: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: var(--surface);
    border-radius: var(--radius-s);
    z-index: 10;
  }

  .skip:focus {
    left: 0.5rem;
  }

  .top {
    border-bottom: 1px solid var(--line);
    background: var(--surface);
  }

  .inner,
  main,
  .foot {
    max-width: 75rem;
    margin: 0 auto;
    padding-left: 1rem;
    padding-right: 1rem;
  }

  .inner {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    padding-top: 0.75rem;
    padding-bottom: 0.75rem;
    flex-wrap: wrap;
  }

  .inner :global(.status) {
    flex: 1;
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 600;
    font-size: var(--step-1);
    text-decoration: none;
  }

  .theme {
    display: grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    border: 1px solid var(--line);
    border-radius: 50%;
    background: transparent;
    cursor: pointer;
  }

  main {
    padding-bottom: 3rem;
  }

  .foot {
    padding-top: 1.5rem;
    padding-bottom: 2rem;
    border-top: 1px solid var(--line);
    font-size: var(--step--1);
  }

  .foot p {
    max-width: 70ch;
  }

  /* Below this the status needs its own line; squeezed beside the search it wraps word by word. */
  @media (max-width: 900px) {
    .inner {
      gap: 0.5rem 1rem;
    }
    .inner :global(.status) {
      order: 3;
      flex-basis: 100%;
    }
    .inner :global(form[role='search']) {
      margin-left: auto;
    }
  }

  @media (max-width: 640px) {
    .inner :global(form[role='search']) {
      order: 4;
      flex-basis: 100%;
      margin-left: 0;
    }
    .theme {
      margin-left: auto;
    }
  }
</style>
