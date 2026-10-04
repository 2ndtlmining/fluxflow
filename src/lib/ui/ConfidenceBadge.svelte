<!--
  How sure a label is (#19), as a small badge whose explanation opens on hover, keyboard
  focus or tap, and closes with Escape, on leaving, or on tapping elsewhere. A toggletip rather than a `title`:
  `title` never shows on touch screens and is unreliable for screen readers.
-->
<script lang="ts">
  import { evidenceText, sourceText } from '$lib/client/format';
  import type { ConfidenceLevel } from '$lib/client/types';

  interface Props {
    level: ConfidenceLevel | null;
    source: string | null;
    confidence?: number | null;
    evidence?: Record<string, unknown> | null;
  }

  let { level, source, confidence = null, evidence = null }: Props = $props();

  let open = $state(false);
  const id = `tip-${Math.random().toString(36).slice(2, 9)}`;

  const details = $derived([
    sourceText(source),
    ...evidenceText(evidence),
    ...(confidence !== null ? [`${Math.round(confidence * 100)}% confidence`] : [])
  ]);
</script>

{#if level}
  <span
    class="wrap"
    role="presentation"
    onmouseenter={() => (open = true)}
    onmouseleave={() => (open = false)}
  >
    <button
      type="button"
      class="badge {level}"
      aria-expanded={open}
      aria-controls={id}
      aria-label="{level} label, show why"
      onclick={() => (open = true)}
      onfocus={() => (open = true)}
      onblur={() => (open = false)}
      onkeydown={(event) => {
        if (event.key === 'Escape') open = false;
      }}
    >
      {level}
    </button>
    <span {id} role="status" class="tip" class:open>
      {#if open}
        {#each details as line (line)}<span>{line}</span>{/each}
      {/if}
    </span>
  </span>
{/if}

<style>
  .wrap {
    position: relative;
    display: inline-block;
    vertical-align: baseline;
  }

  .badge {
    margin-left: 0.3rem;
    padding: 0 0.4rem;
    border: 1px solid currentColor;
    border-radius: 999px;
    background: transparent;
    font-size: 0.7rem;
    font-weight: 500;
    line-height: 1.5;
    cursor: help;
  }

  /* Solid for confirmed, outlined for likely, dashed for possible: readable without colour. */
  .confirmed {
    color: var(--good);
    background: color-mix(in srgb, var(--good) 14%, transparent);
  }

  .likely {
    color: var(--brand);
  }

  .possible,
  .candidate {
    color: var(--text-muted);
    border-style: dashed;
  }

  .tip {
    position: absolute;
    left: 0;
    top: calc(100% + 0.35rem);
    z-index: 15;
    display: none;
    width: max-content;
    max-width: min(18rem, 80vw);
    padding: 0.5rem 0.65rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    box-shadow: 0 6px 20px color-mix(in srgb, var(--text) 16%, transparent);
    font-size: var(--step--1);
    color: var(--text);
    white-space: normal;
  }

  .tip.open {
    display: grid;
    gap: 0.15rem;
  }
</style>
