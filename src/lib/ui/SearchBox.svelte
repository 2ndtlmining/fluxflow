<!--
  Find a wallet, a label or a transaction (#30).

  A full address goes straight to its wallet page and a full txid to its transaction page
  (#66); anything else opens the results page,
  which asks GET /api/search. It is a plain GET form, so it also works before JavaScript loads.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { isAddress, isTxid } from '$lib/client/endpoints';

  let query = $state('');

  function submit(event: SubmitEvent): void {
    const value = query.trim();
    if (value.length < 2) {
      event.preventDefault();
      return;
    }
    if (isAddress(value)) {
      event.preventDefault();
      query = '';
      void goto(`/wallet/${value}`);
    } else if (isTxid(value)) {
      event.preventDefault();
      query = '';
      void goto(`/tx/${value.toLowerCase()}`);
    }
  }
</script>

<form role="search" action="/search" method="get" onsubmit={submit}>
  <label for="site-search" class="visually-hidden">
    Search by address, exchange or label, or transaction id
  </label>
  <input
    id="site-search"
    name="q"
    type="search"
    placeholder="Search address, label or txid"
    autocomplete="off"
    spellcheck="false"
    minlength="2"
    maxlength="64"
    bind:value={query}
  />
</form>

<style>
  form {
    min-width: 0;
  }

  input {
    width: 17rem;
    max-width: 100%;
    padding: 0.4rem 0.7rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--bg);
    color: var(--text);
    font-size: var(--step--1);
  }

  @media (max-width: 640px) {
    form {
      flex: 1;
    }
    input {
      width: 100%;
    }
  }
</style>
