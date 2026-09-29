# FluxNode pool: parallel block ingestion PoC

Proof of concept for [#35](https://github.com/2ndtlmining/fluxflow/issues/35): fetch chain data directly from many FluxNodes' FluxOS APIs in parallel, instead of one rate-limited Blockbook server, and check that the data is what FluxFlow needs.

## What it does
1. **Discover** nodes from `viewdeterministicfluxnodelist` (`ip`, `tier`, `payment_address`).
2. **Probe** a random sample: `getblockcount` (latency, height), take the median as the tip, keep nodes within ±2 blocks. Mark nodes where `getblockdeltas` works as **insight-capable**, meaning input addresses and amounts are available.
3. **Baseline:** one node, one request at a time.
4. **Scaling test:** 1 → 5 → 10 → 20 → 40 nodes on separate block ranges.
5. **Main run:** a shared work queue over N nodes × 2 requests in flight, fetching `GET /daemon/getblock/<height>/2`, which returns the full block with every transaction in one call. Faster nodes naturally take more work, failed requests are retried on other nodes, and failing nodes are evicted.
6. **Integrity:**
   - each node's first 3 blocks, then a random ~1 in 20, are re-read from another node, and a third node settles any disagreement (majority of three)
   - a node that is outvoted is evicted, and every block it served is fetched again
   - the `previousblockhash` chain is checked across the whole range
   - the top block hash is confirmed by 5 other nodes
7. **Data fitness:** blocks are converted to the transaction shape FluxFlow uses today (`lib/normalize.mjs`) and then checked:
   - every input has an address and amount
   - inputs − outputs = a small positive fee (proves amounts and units are right)
   - transaction types are identified (coinbase, fluxnode, transfer)
   - PoN rewards go to node-list addresses
   - the transactions are run through the app's **unchanged** `BlockSyncService.processTransaction()`
8. **Report:** `out/<run>/report.html` + `report.json` + screenshots.

## Run it
```bash
npm ci

# Live network (needs outbound access to api.runonflux.io and node IPs on 16127-16197)
node poc/fluxnode-pool/run.mjs --blocks 3000 --pool 40 --out poc/fluxnode-pool/out/live

# Offline simulator (300 fake nodes incl. offline/lagging/flaky/hanging/non-insight/lying)
node poc/fluxnode-pool/sim/fake-network.mjs --nodes 300 &
node poc/fluxnode-pool/run.mjs --sources http://127.0.0.1:18000/daemon/viewdeterministicfluxnodelist \
  --label "SIMULATED network" --out poc/fluxnode-pool/out/sim

# Screenshots (needs playwright or playwright-core + Chromium)
node poc/fluxnode-pool/screenshot.mjs poc/fluxnode-pool/out/live
```
Behind an HTTP proxy, set `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21).

The GitHub workflow `.github/workflows/fluxnode-pool-poc.yml` runs the live version on a GitHub runner and commits the results to `out/live/`.

## Files
| File | Purpose |
|---|---|
| `lib/http.mjs` | fetch with timeout, FluxOS `{status,data}` envelope |
| `lib/pool.mjs` | discovery, probing, parallel range fetch, integrity checks |
| `lib/normalize.mjs` | fluxd block JSON → FluxFlow tx shape (uses `valueSat`, not `value/1e8`) |
| `lib/validate.mjs` | data checks + runs the app's own classification code |
| `run.mjs` | the end-to-end PoC run |
| `sim/fake-network.mjs` | offline FluxOS/fluxd simulator for testing |
| `report.html` | report template |
| `screenshot.mjs` | Playwright screenshots |
