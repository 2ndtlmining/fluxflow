# Flux Flow Tracker

Real-time exchange flow analysis dashboard for the Flux blockchain network. Tracks buy/sell pressure by analyzing transactions between exchanges, node operators, foundation, and unknown wallets.

## 🎯 Features

- **Flow Direction Detection**: buying pressure (funds leaving exchanges) and selling
  pressure (funds arriving at exchanges)
- **Wallet Classification**: addresses classified as exchange, node operator, Foundation, or
  unknown, from a label file that can be corrected without a rebuild
- **Multiple Time Periods**: Today, This Week, This Month, This Quarter, Last 6 Months
- **Top Movers**: the largest buyers and sellers in any period
- **Exchange Breakdown**: per-exchange totals
- **Persistent**: SQLite in WAL mode, so the API keeps serving reads while ingestion writes
- **Resilient**: every outbound request is bounded by a timeout; failed heights are retried;
  data sources fail over and are health-probed back
- **One process, one port**: the API and the web app are served together, so there is no
  proxy to misconfigure

## 📊 What We Track

### Buying Pressure (From Exchanges)

- Total FLUX moving from exchanges
- Destinations: Node Operators, Unknown Wallets, Foundation, Exchange-to-Exchange
- Per-exchange source breakdown

### Selling Pressure (To Exchanges)

- Total FLUX moving to exchanges
- Sources: Node Operators, Unknown Wallets, Foundation, Exchange-to-Exchange
- Per-exchange destination breakdown

### Classification

- **Exchanges**: Configurable list of exchange addresses (Binance, KuCoin, etc.)
- **Foundation**: Flux Foundation official addresses
- **Node Operators**: Dynamic list fetched from Flux API (includes node count and tiers)
- **Unknown**: All other addresses

## 🚀 Quick Start

### Development

```bash
npm install
cp .env.example .env       # then edit; LOG_PRETTY=1 for readable logs

npm run dev                # API on :3000 + Vite on :5173, both watching
```

Open <http://localhost:5173>. `vite dev` proxies `/api` to the API process, so there is
nothing else to start.

To run the API on its own, without the web server:

```bash
npm run dev:api            # http://localhost:3000
```

### Production

```bash
npm run build:all          # vite build -> build/, tsc -> dist/
npm start                  # one process, one port
```

### Docker

```bash
cp .env.example .env
docker compose up -d       # http://localhost:3000
```

Or directly:

```bash
docker build -t fluxflow .
docker run -d --name fluxflow \
  -p 3000:3000 \
  -v fluxflow-data:/app/data \
  -v ./config:/app/config:ro \
  -e ADMIN_TOKEN=$(openssl rand -hex 32) \
  fluxflow
```

**One port serves both the API and the web app.** There is no proxy and no CORS
configuration: if `/api` works, the app works, from `localhost` or from a server IP.

The database lives on the `/app/data` volume. On `docker stop` the service checkpoints the
WAL into the main file and closes cleanly, so a plain copy of `flux-flow.db` is a complete
backup.

### Configuration

Everything comes from the environment and is validated **once** at startup by zod. Invalid
configuration fails the boot with every problem listed at once, rather than surfacing one
per restart. `ADMIN_TOKEN` is mandatory when `NODE_ENV=production` and must be at least 32
characters. See [`.env.example`](.env.example) for every variable, or
[`src/lib/server/config.ts`](src/lib/server/config.ts) for the annotated schema.

```bash
DATABASE_PATH=/app/data/flux-flow.db
FLUX_INDEXER_URL=http://your-indexer:42067   # optional; omit to use the public FluxNode pool
SYNC_POLL_SECONDS=30
ADMIN_TOKEN=$(openssl rand -hex 32)
```

Address labels live in [`config/labels.json`](config/labels.json), which is mounted into the
container — exchanges and Foundation addresses can be corrected without a rebuild.

### Verification

Every change is checked in CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

```bash
npm run verify         # format:check + lint + typecheck:server + test
npm run check          # svelte-check across components, routes and server code
npm run test:watch     # Vitest in watch mode
npm run lint:fix       # ESLint --fix
npm run format         # Prettier --write
```

CI targets **Node 22 LTS**.

## 📁 Project Structure

> **v2 rework in progress.** FluxFlow is being rebuilt as a single TypeScript service — see
> [ADR 0001](docs/adr/0001-typescript-rework.md) and the roadmap in
> [#36](https://github.com/2ndtlmining/fluxflow/issues/36). Ingestion, the API and the Docker
> image have landed; the intelligence layer and the UI rework are next.

```
fluxflow/
├── src/
│   ├── lib/
│   │   ├── shared/                    # Isomorphic code, safe in any bundle
│   │   │   └── constants.ts           # Periods, labels, block-time helpers
│   │   ├── client/                    # Browser-only helpers, never imported server-side
│   │   │   └── api.ts                 # Same-origin /api client
│   │   ├── server/                    # Server-only; stripped from the client bundle
│   │   │   ├── config.ts              # zod-validated environment
│   │   │   ├── logger.ts              # pino, structured, redacted
│   │   │   ├── http.ts                # every outbound call: timeout, retries, limiter
│   │   │   ├── labels.ts              # exchange / Foundation labels -> address_labels
│   │   │   ├── index.ts               # service assembly, lifecycle, graceful shutdown
│   │   │   ├── api/                   # read queries + the /api router
│   │   │   ├── db/                    # SQLite connection + versioned migrations
│   │   │   └── ingest/datasource/     # normalised chain shapes, adapters, breaker
│   │   ├── components/                # Svelte UI
│   │   └── data/exchanges.json        # legacy labels, superseded by config/labels.json
│   ├── routes/                        # SvelteKit routes
│   ├── server.ts                      # entry: /api router + SvelteKit handler, one process
│   ├── app.css
│   └── app.html
├── scripts/dev-api.ts                 # API-only entry for `npm run dev`
├── config/labels.json                 # mounted into the container
├── docs/adr/                          # architecture decision records
├── .github/workflows/ci.yml
├── Dockerfile                         # multi-stage, Node 22, tini, one port
├── docker-compose.yml
├── tsconfig.json                      # editor, svelte-check and component typechecking
├── tsconfig.server.json               # emits the Node server to dist/
└── package.json
```

### Where code belongs

| Path          | Runs in          | May import        |
| ------------- | ---------------- | ----------------- |
| `$lib/shared` | server + browser | nothing app-bound |
| `$lib/client` | browser only     | `$lib/shared`     |
| `$lib/server` | server only      | `$lib/shared`     |

SvelteKit strips `$lib/server` out of the client bundle, which is why configuration and
credentials belong there rather than in `$lib/shared`.

### Server modules

| Module                      | Responsibility                                                                      | Issues       |
| --------------------------- | ----------------------------------------------------------------------------------- | ------------ |
| `server/config.ts`          | zod-validated environment, resolved once at startup                                 | #11          |
| `server/logger.ts`          | pino structured logging with redaction                                              | #24          |
| `server/http.ts`            | the only outbound call site: mandatory timeout, retries, shared concurrency limiter | #10, #5      |
| `server/db/database.ts`     | SQLite connection and pragmas; `DEBUG_SQL` gates SQL logging                        | #6           |
| `server/db/migrations.ts`   | versioned schema migrations; refuses a legacy v1 database                           | #17          |
| `server/ingest/datasource/` | normalised chain shapes, Blockbook + FluxIndexer adapters, circuit breaker          | #12, #15     |
| `server/ingest/derive.ts`   | a fetched block → deltas, flows and node rewards. Pure, no I/O                      | #15, #18     |
| `server/ingest/writer.ts`   | the single writer: one transaction per batch, statements prepared once              | #14, #16     |
| `server/ingest/sync.ts`     | tip-following, gap repair, reorg rollback, retention                                | #5, #13, #17 |
| `server/labels.ts`          | `config/labels.json` → `address_labels`, reloadable without a restart               | #18, #20     |
| `server/api/queries.ts`     | bounded SQL: aggregates in the database, keyset pagination, no full scans           | #2, #3       |
| `server/api/router.ts`      | the `/api` surface; O(1) health that reports staleness                              | #3, #21      |
| `server/index.ts`           | service assembly and graceful shutdown                                              | #14, #22     |

## 🔧 How It Works

### Data model

Chain facts are stored once and are never rewritten; everything the dashboard shows is
derived from them and can be rebuilt.

| Table            | Role                                                                         |
| ---------------- | ---------------------------------------------------------------------------- |
| `blocks`         | height, hash, `prev_hash`, time, tx count, and which source it came from     |
| `tx_deltas`      | per-transfer, per-address satoshi deltas — the unit of analysis              |
| `node_rewards`   | coinbase-derived, so "was a node operator" is time-accurate                  |
| `address_labels` | exchange / Foundation / operator labels — mutable, correctable, re-derivable |
| `flows`          | the derived buy/sell/p2p rows the API reads                                  |
| `missing_blocks` | heights that failed to fetch, with backoff — retried, never skipped          |

Because labels are separate from facts, correcting an exchange address never rewrites
history and never invalidates an analysis.

### Flow classification

For each transfer transaction:

1. Collect every input address and every output address.
2. Collapse to one row per address in `tx_deltas` — a wallet that funded two inputs is one
   delta, not two.
3. Ignore `OP_RETURN` and other unspendable outputs: they are not counterparty transfers.
4. Look up each address in `address_labels`; anything unlabelled is `unknown`.
5. Direction: funds **from** an exchange to elsewhere = `buying`; funds **to** an exchange
   from elsewhere = `selling`; everything else = `p2p`.

### Resilience

- Every outbound request has a mandatory timeout, so a hung node cannot stall sync.
- Failed heights are recorded in `missing_blocks` and retried with backoff.
- One circuit breaker per data source: failures are counted across all requests, the
  primary is health-probed and taken back once it recovers, and one bad block cannot
  demote a healthy source.
- `docker stop` checkpoints the WAL and closes the database before exit.

## 📡 API Endpoints

All endpoints are same-origin. There is no CORS layer unless `ORIGIN` is set explicitly.

| Method | Path                        | Notes                                         |
| ------ | --------------------------- | --------------------------------------------- |
| GET    | `/api/health`               | O(1); 503 + `degraded` when sync is stale     |
| GET    | `/api/status`               | sync, database, data-source and label summary |
| GET    | `/api/blocks/status`        | block range and sync progress                 |
| GET    | `/api/database/stats`       | row counts and database size                  |
| GET    | `/api/classification/stats` | label counts                                  |
| GET    | `/api/unknowns/stats`       | how much is still unlabelled                  |
| GET    | `/api/flow/:period`         | aggregated totals, no events attached         |
| GET    | `/api/flow/:period/events`  | keyset-paginated events, filterable           |
| GET    | `/api/flow/:period/buyers`  | top N addresses receiving from exchanges      |
| GET    | `/api/flow/:period/sellers` | top N addresses sending to exchanges          |

`period` is one of `24H`, `7D`, `30D`, `90D`, `6M`. Windows are resolved from block **time**
rather than a block count, so "Today" means today even if block times drift.

`/api/flow/:period` returns aggregates only. Events are served a page at a time by
`/events`, because shipping a whole period to the browser took 28 seconds and then crashed
in `JSON.stringify` at six months.

---

## ⚙️ Configuration Files

### Address labels (`config/labels.json`)

```json
{
  "exchanges": [{ "name": "Coinex", "addresses": ["t1abc...", "t1def..."] }],
  "foundation": {
    "name": "Flux Foundation",
    "addresses": ["t1xyz..."]
  }
}
```

Mounted at `/app/config/labels.json` in the container, so this file can be edited on a live
server without rebuilding. It is loaded into the `address_labels` table on startup, and
`labels.reload()` re-reads it without a restart.

Coverage is thin — only a handful of exchanges are known. Addresses discovered by
clustering are proposed as candidates and need a human to add them here.

## 🎨 Theming

The app uses a terminal-style dark theme inspired by Fluxtracker:

- Flux purple primary color (#8247e5)
- Cyan accents (#00d4ff)
- Dark background (#0a0e27)
- Monospace font (Courier New)

## 🐛 Troubleshooting

### `/api/health` returns 503

The service reports `degraded` when sync has not completed a cycle recently, and the
`reason` field says why. In Docker the healthcheck will report unhealthy and an orchestrator
can restart the container. Check `/api/status` for the data-source state and any open
circuit breaker.

### The dashboard shows zeros

On a fresh install the database starts empty and fills from the retention floor upwards.
`/api/flow/:period` returns `ready: false` and a progress figure until enough blocks have
landed. Watch progress at `/api/status`, or in the logs:

```bash
docker logs -f fluxflow | grep "batch committed"
```

### Ingestion stalls on `HTTP 429` or timeouts

The **public** Blockbook instance rate-limits by IP, so a shared or busy host will be
throttled. The service handles this correctly — it backs off, opens the circuit breaker and
reports `degraded` rather than writing partial data — but it cannot make progress.

For sustained ingestion, give it a source that is not rate-limited:

| Option                                | How                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------- |
| **Your own FluxIndexer** (fastest)    | `FLUX_INDEXER_URL=http://your-indexer:42067`                           |
| **FluxNode pool** (free, distributed) | default; many nodes instead of one                                     |
| **Own `fluxd`**                       | planned — see [#36](https://github.com/2ndtlmining/fluxflow/issues/36) |

`SYNC_CONCURRENCY` and `SYNC_BATCH_SIZE` are the two knobs. Lowering them reduces the
pressure on a shared source at the cost of a slower initial backfill.

### Insufficient data

If you see "Insufficient data" messages, the system is still syncing blocks. Wait for the
progress bar to reach 100%.

### Sync errors

Logs are structured JSON, so failures are easy to filter:

```bash
docker logs fluxflow 2>&1 | grep '"level":40'
docker logs fluxflow 2>&1 | grep 'circuit breaker transition'
```

Common causes are rate limiting (see above), network connectivity, and a data source
returning an unexpected shape. A height that cannot be fetched is recorded in
`missing_blocks` and retried with backoff — it is never skipped.

### High memory usage

Set `RETENTION_DAYS` to keep less history. Blocks older than the retention window are
pruned on a schedule; rollups can be kept for longer than the raw data once they land.

## 📝 Roadmap

Work in progress is tracked in [#36](https://github.com/2ndtlmining/fluxflow/issues/36) and
[#34](https://github.com/2ndtlmining/fluxflow/issues/34). The remaining layers are:

- **FluxNode pool** — a distributed, non-rate-limited data source (#35), so a fresh install
  does not depend on the single public Blockbook instance
- **Read models** — rollup tables so dashboard queries are O(buckets) rather than O(events)
- **Intelligence** — node-operator detection from coinbase rewards, exchange clustering,
  confidence-scored heuristics
- **UI** — status bar, leaderboards, net-flow-over-time, transaction explorer, wallet pages

## 🙏 Credits

Built on the Flux blockchain ecosystem:

- Blockbook API: https://blockbook.runonflux.io
- Flux Nodes API: https://explorer.runonflux.io
- Inspired by: Fluxtracker (https://fluxtracker.app.runonflux.io)

## 📄 License

MIT License - See LICENSE file for details
