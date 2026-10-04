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

Every label lives in `address_labels` with a **source**, a **confidence** and its
**evidence** (#18, #19). Only labels at _likely_ or above change how a flow is counted;
weaker ones are shown on the wallet page and nowhere else.

| Kind          | How we know                                                                                            | Confidence         |
| ------------- | ------------------------------------------------------------------------------------------------------ | ------------------ |
| Exchange      | `config/labels.json`, or a clustering candidate a human accepted                                       | confirmed / likely |
| Foundation    | `config/labels.json`, with named sub-wallets                                                           | confirmed          |
| Node operator | payment address on the current deterministic node list                                                 | confirmed          |
| Node operator | received coinbase rewards in stored blocks, no longer on the list (valid 30 days past its last reward) | likely             |
| Node operator | wallet fed ≥ 80% by node payout addresses (reward forwarding)                                          | likely / possible  |
| Unknown       | everything else                                                                                        | —                  |

When a label changes, the address's flows are re-derived from the stored transactions and
the totals follow (the rollups are maintained by triggers, so they stay exact). Transfers
between Foundation wallets produce no flow. Exchange **hops** — a withdrawal re-deposited by
the same wallet shortly after — are reported separately, with headline totals also given
without them.

## 🚀 Quick Start

### Development

```bash
npm install
cp .env.example .env       # then edit; LOG_PRETTY=1 for readable logs

npm run dev                # API on :3000 + Vite on :5173, both watching
```

Open <http://localhost:5173>. `vite dev` proxies `/api` to the API process, so there is
nothing else to start.

To work on the UI against an API that is already running elsewhere, such as the Compose
container with real data, point the proxy at it and start only the web server:

```bash
API_PROXY_TARGET=http://localhost:3000 npm run dev:web
```

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

See [Running with Docker Compose](#-running-with-docker-compose) below. It is the supported
way to run FluxFlow on a server.

### Configuration

Everything comes from the environment and is validated **once** at startup by zod. Invalid
configuration fails the boot with every problem listed at once, rather than surfacing one
per restart. `ADMIN_TOKEN` is mandatory when `NODE_ENV=production` and must be at least 32
characters. See [`.env.example`](.env.example) for every variable, or
[`src/lib/server/config.ts`](src/lib/server/config.ts) for the annotated schema.

```bash
DATABASE_PATH=/app/data/flux-flow.db
FLUX_INDEXER_URL=http://your-indexer:42067   # optional; omit to use the FluxNode pool
SYNC_POLL_SECONDS=30
ADMIN_TOKEN=$(openssl rand -hex 32)
```

#### Where the data comes from

With no configuration at all, FluxFlow reads chain data from the **FluxNode pool**: it
discovers nodes from the public explorer, probes them, keeps the fastest ~15 within two
blocks of the pool median tip, and spreads every block fetch across them at two concurrent
requests per node. This is free, needs no indexer, and — unlike the single public Blockbook
instance — is not rate-limited per IP.

Each FluxNode is an operator's home connection, so the pool is deliberately restrained:
`User-Agent: FluxFlow/2 (+repo url)`, two requests in flight per node, a random sample rather
than a sweep, and exponential backoff on any failure. It also does not trust any single node:
the tip is the **median** across the pool, every 25th block's hash is re-fetched from a
_different_ node and compared, and a node that disagrees is benched rather than believed.

Set `FLUXNODE_POOL_ENABLED=0` to turn it off. If you run your own indexer or `fluxd`, set
`FLUX_INDEXER_URL` and it is preferred — the pool stays as the fallback.

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

## 🐳 Running with Docker Compose

Everything runs in **one container on one port**. The only state is the SQLite database on
the `fluxflow-data` Docker volume, so rebuilding, updating or recreating the container never
touches your data.

### Launching (first time)

```bash
git clone https://github.com/2ndtlmining/fluxflow.git
cd fluxflow
cp .env.example.compose .env
# Set ADMIN_TOKEN in .env (at least 32 characters): openssl rand -hex 32
deploy/redeploy.sh
```

Open `http://<server>:3000` (or the `PORT` set in `.env`).

On first launch the script creates the volume, builds the image and waits until the container
is healthy. Health turns green once the first batch of blocks is stored, which takes about a
minute with the FluxNode pool. History back to `RETENTION_DAYS` then fills in the background:
`GET /api/status` shows progress.

### Updating

```bash
deploy/redeploy.sh
```

That one command:

1. checks that `.env` and `ADMIN_TOKEN` are present and that the checkout has no local changes
2. runs `git pull --ff-only`
3. **backs up the database** from the running container using SQLite's online backup, which
   is safe while ingestion is writing
4. builds an image tagged with the git SHA (`fluxflow:<sha>`) and recreates the container
5. waits for the Docker healthcheck
6. checks that `/api/health` reports the new SHA, so you know the new build is what answers

Schema changes are applied automatically at startup by the versioned migrations, and only
ever move forward.

| Variable           | Default | Effect                                                      |
| ------------------ | ------- | ----------------------------------------------------------- |
| `SKIP_PULL=1`      | off     | deploy the checkout as it is                                |
| `BACKUP_KEEP`      | `3`     | backups kept inside the volume                              |
| `BACKUP_DIR=/path` | unset   | also copy each backup to this host directory                |
| `SKIP_BACKUP=1`    | off     | allow a deploy when data exists but no container is running |
| `HEALTH_TIMEOUT`   | `900`   | seconds to wait for healthy                                 |

### Rolling back

Every build keeps its own `fluxflow:<sha>` image, and the script prints the exact rollback
command at the end:

```bash
GIT_SHA=<previous sha> docker compose up -d --no-build
```

A rollback across a schema migration also needs the matching backup restored (below).

### Where the data lives

| What               | Where                                                                   |
| ------------------ | ----------------------------------------------------------------------- |
| Database           | volume `fluxflow-data` → `/app/data/flux-flow.db`                       |
| Pre-deploy backups | volume `fluxflow-data` → `/app/data/backups/` (newest `BACKUP_KEEP`)    |
| Address labels     | `./config/labels.json`, mounted read-only, so edits need only a restart |
| Settings           | `.env` (never committed, never copied into the image)                   |

The volume name is fixed in `docker-compose.yml`, so it does not depend on the folder the repo
is cloned into. `docker compose down` keeps it. **Only `docker compose down -v` or
`docker volume rm fluxflow-data` deletes your data.**

Copy a backup to the host:

```bash
docker compose cp fluxflow:/app/data/backups ./backups
```

Restore one (stop first, so nothing is writing):

```bash
docker compose stop
docker run --rm -v fluxflow-data:/data -v "$PWD/backups:/b" alpine   sh -c 'rm -f /data/flux-flow.db-wal /data/flux-flow.db-shm && cp /b/<backup>.db /data/flux-flow.db && chown 1000:1000 /data/flux-flow.db'
docker compose start
```

### Day to day

```bash
docker compose ps              # health
docker compose logs -f         # structured JSON logs
curl localhost:3000/api/status # sync progress, data sources, FluxNode pool
docker compose restart         # e.g. after editing config/labels.json
```

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
│   │   │   ├── api.ts                 # Same-origin /api client, abortable, last-answer cache
│   │   │   ├── urlState.ts            # period + filters <-> query string
│   │   │   ├── format.ts, csv.ts      # display formatting, CSV export
│   │   │   ├── endpoints.ts           # typed calls for every data endpoint (docs/api.md)
│   │   │   ├── pager.ts               # keyset paging, merging buying + selling streams
│   │   │   ├── live.svelte.ts         # one EventSource on /api/stream; polling fallback
│   │   │   └── watchlist.ts           # per-browser watchlist (localStorage)
│   │   ├── server/                    # Server-only; stripped from the client bundle
│   │   │   ├── config.ts              # zod-validated environment
│   │   │   ├── logger.ts              # pino, structured, redacted
│   │   │   ├── http.ts                # every outbound call: timeout, retries, limiter
│   │   │   ├── labels.ts              # exchange / Foundation labels -> address_labels
│   │   │   ├── index.ts               # service assembly, lifecycle, graceful shutdown
│   │   │   ├── api/                   # read queries + the /api router
│   │   │   ├── db/                    # SQLite connection + versioned migrations
│   │   │   └── ingest/datasource/     # normalised chain shapes, adapters, breaker
│   │   ├── ui/                        # Svelte 5 components (balance axis, boards, explorer)
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

| Module                      | Responsibility                                                                      | Issues        |
| --------------------------- | ----------------------------------------------------------------------------------- | ------------- |
| `server/config.ts`          | zod-validated environment, resolved once at startup                                 | #11           |
| `server/logger.ts`          | pino structured logging with redaction                                              | #24           |
| `server/http.ts`            | the only outbound call site: mandatory timeout, retries, shared concurrency limiter | #10, #5       |
| `server/db/database.ts`     | SQLite connection and pragmas; `DEBUG_SQL` gates SQL logging                        | #6            |
| `server/db/migrations.ts`   | versioned schema migrations; refuses a legacy v1 database                           | #17           |
| `server/ingest/datasource/` | normalised chain shapes, FluxNode pool + Blockbook + FluxIndexer, circuit breaker   | #12, #15, #35 |
| `server/ingest/derive.ts`   | a fetched block → deltas, flows and node rewards. Pure, no I/O                      | #15, #18      |
| `server/ingest/writer.ts`   | the single writer: one transaction per batch, statements prepared once              | #14, #16      |
| `server/ingest/sync.ts`     | tip-following, gap repair, reorg rollback, retention                                | #5, #13, #17  |
| `server/labels.ts`          | `config/labels.json` → `address_labels`, reloadable without a restart               | #18, #20      |
| `server/api/queries.ts`     | bounded SQL: aggregates in the database, keyset pagination, no full scans           | #2, #3        |
| `server/api/router.ts`      | the `/api` surface; O(1) health that reports staleness                              | #3, #21       |
| `server/index.ts`           | service assembly and graceful shutdown                                              | #14, #22      |

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
| `rollup_*`       | hourly and daily totals per direction, counterparty and exchange (triggers)  |
| `wallet_*`       | daily and 30-day totals per wallet, for leaderboards and profiles (triggers) |
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

| Method | Path                           | Notes                                         |
| ------ | ------------------------------ | --------------------------------------------- |
| GET    | `/api/health`                  | O(1); 503 + `degraded` when sync is stale     |
| GET    | `/api/status`                  | sync, database, data-source and label summary |
| GET    | `/api/blocks/status`           | block range and sync progress                 |
| GET    | `/api/database/stats`          | row counts and database size                  |
| GET    | `/api/classification/stats`    | label counts                                  |
| GET    | `/api/unknowns/stats`          | how much is still unlabelled                  |
| GET    | `/api/flow/:period`            | aggregated totals, no events attached         |
| GET    | `/api/flow/:period/events`     | keyset-paginated events, filterable           |
| GET    | `/api/flow/:period/buyers`     | top wallets withdrawing from exchanges        |
| GET    | `/api/flow/:period/sellers`    | top wallets depositing to exchanges           |
| GET    | `/api/flow/:period/series`     | buying/selling/net per hour (≤7D) or day      |
| GET    | `/api/wallets/:address`        | wallet profile: totals, exchanges, history    |
| GET    | `/api/wallets/:address/events` | a wallet's flows, keyset-paginated            |
| GET    | `/api/search?q=`               | address prefix, label name or txid            |
| GET    | `/api/flow/:period/hops`       | exchange hops (withdraw → re-deposit)         |
| GET    | `/api/foundation?period=`      | Foundation wallets, flows, balance history    |
| GET    | `/api/intel/status`            | labels by source, node list, clustering       |
| GET    | `/api/stream`                  | Server-Sent Events: `sync` and `flow` (live)  |
| GET    | `/api/metrics`                 | Prometheus text format                        |
| POST   | `/api/admin/sync`              | admin: start a cycle now (answers 202)        |
| POST   | `/api/admin/retention`         | admin: prune past the retention window now    |
| POST   | `/api/admin/alerts/reload`     | admin: re-read `config/alerts.json`           |

`period` is one of `24H`, `7D`, `30D`, `90D`, `6M`. Windows are resolved from block **time**
rather than a block count, so "Today" means today even if block times drift.

Every response carries an `ETag` tied to the stored data's version: repeat requests between
syncs are served from memory, or answered `304`. Full request and response shapes are in
[`docs/api.md`](docs/api.md).

`/api/flow/:period` returns aggregates only. Events are served a page at a time by
`/events`, because shipping a whole period to the browser took 28 seconds and then crashed
in `JSON.stringify` at six months.

Admin endpoints need `Authorization: Bearer $ADMIN_TOKEN` and are refused outright when no
token is configured.

**Limits.** Every query parameter is validated: a bad `limit`, `type` or `kind` is a `400`
naming the parameter, not a silent default. Clients are rate limited per IP
(`API_RATE_LIMIT_RPS` sustained, `API_RATE_LIMIT_BURST` burst; `0` disables), except
health, status, metrics and the stream. Request bodies over 64 KB are refused with `413`,
and a request must arrive within 30 s. Behind a reverse proxy set `TRUST_PROXY=1` so the
limiter sees real client IPs.

### Live updates (`/api/stream`)

After each committed sync cycle the server sends `event: sync` with the new tip and data
version (the same version the API's ETags carry, so a refetch is a cheap `304` when nothing
you show changed). New flows of at least `LIVE_FLOW_MIN_FLUX` from tip-following arrive as
`event: flow`. Backfilled history never does.

```js
const events = new EventSource('/api/stream');
events.addEventListener('sync', (e) => refresh(JSON.parse(e.data)));
events.addEventListener('flow', (e) => toast(JSON.parse(e.data)));
```

At most `LIVE_MAX_CLIENTS` subscribers; beyond that the stream answers `503` and clients
should fall back to polling.

### Metrics (`/api/metrics`)

Prometheus text format, cheap enough to scrape every 15 s. Highlights:
`fluxflow_chain_height`, `fluxflow_sync_blocks_total{phase}`,
`fluxflow_sync_blocks_per_minute`, `fluxflow_source_active{source}`,
`fluxflow_pool_nodes{state}`, `fluxflow_api_cache_total{outcome}`,
`fluxflow_event_loop_delay_seconds{quantile}`, `fluxflow_alerts_total{outcome}`.
`/api/status` carries the event-loop delay too, under `runtime`.

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

Foundation sub-wallets go under `foundation.wallets` as `{ "name": "Treasury",
"addresses": [...] }`; the name becomes the wallet's `subLabel`.

Mounted at `/app/config/labels.json` in the container and **watched**: an edit is applied
within a few seconds, without a restart, and the affected flows are re-derived. Removing an
address from the file removes its label.

### Growing exchange coverage (#20)

Clustering (addresses spent together share an owner) and sweep detection (deposit
addresses consolidated into a known hot wallet) propose **candidates**. They change no total
until accepted. The easiest way is the **Label review** page at `/review` (linked in the
footer): enter `ADMIN_TOKEN` once per browser tab, then accept or reject whole groups (one
exchange, one method) with the evidence for each address beside it. Or with curl:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" localhost:3000/api/admin/labels/candidates?status=pending
curl -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"address":"t1...","kind":"exchange","name":"Kucoin","decision":"accepted"}' \
  localhost:3000/api/admin/labels/candidates/decide
```

A manual label (`POST /api/admin/labels`) beats every other source; `"kind": "unknown"`
removes a wrong label. `npm run precision -- <copy of the db>` runs the whole pass on a
database file and prints how often each heuristic agrees with independent ground truth.

### Alerts (`config/alerts.json`)

Whale and watchlist alerts to Discord, Telegram or any webhook. Copy
[`config/alerts.example.json`](config/alerts.example.json) to `config/alerts.json` (or point
`ALERTS_PATH` elsewhere); without the file, alerts are off.

```json
{
  "channels": {
    "discord": { "type": "discord", "url": "env:DISCORD_WEBHOOK_URL" }
  },
  "rules": [
    {
      "name": "Whale sell to an exchange",
      "minFlux": 25000,
      "flowTypes": ["selling"],
      "channels": ["discord"],
      "cooldownSeconds": 300
    }
  ]
}
```

- **Matching:** `minFlux`, `flowTypes`, `exchanges`, `kinds` (the counterparty, e.g.
  `node_operator`) and `addresses` (either side) — every condition given must hold.
- **Secrets:** `"env:NAME"` reads a value from the environment, so webhook URLs and bot
  tokens stay out of the file. A channel whose variable is unset is disabled with a warning.
- **Noise control:** each flow alerts once per rule, `cooldownSeconds` suppresses repeats,
  and one batch sends at most 5 alerts per rule plus a `(+N more)` note. Only recent
  tip-following flows are checked; backfill never alerts.
- **Delivery** runs in the background with retries, never delaying ingestion.
- The file is re-read when it changes (or `POST /api/admin/alerts/reload`); an invalid edit
  keeps the previous rules and is reported in `/api/status`.

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

If `blockbook` is the active source it is being rate-limited by IP, which it does to shared
and busy hosts. The service handles this correctly — it backs off, opens the circuit breaker
and reports `degraded` rather than writing partial data — but it cannot make progress.

Check which source is actually in use:

```bash
curl -s localhost:3000/api/status | jq '.dataSources.active'
```

If that says `blockbook` when you expected `fluxnode-pool`, the pool found no usable nodes.
`/api/status` carries the detail:

```bash
curl -s localhost:3000/api/status | jq '.dataSources.details["fluxnode-pool"]'
```

| Field             | Meaning                                                         |
| ----------------- | --------------------------------------------------------------- |
| `discovered`      | nodes kept after probing                                        |
| `serving`         | not currently benched                                           |
| `insight`         | of those, how many can attribute transaction inputs             |
| `medianTip`       | the agreed chain tip                                            |
| `lastError`       | why the last probe or fetch failed                              |
| `nodes[].benched` | a node answering wrongly or failing is out for a cooling period |

`insight: 0` means no node could tell us **who sent** the value, so the pool refuses to serve
blocks rather than record flows with no counterparty. Raise `FLUXNODE_PROBE_SAMPLE` to look
at more candidates, and check `FLUXNODE_API_PORTS` if your nodes run on non-standard ports.

For sustained ingestion, prefer a source you control:

| Option                                | How                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------- |
| **Your own FluxIndexer** (fastest)    | `FLUX_INDEXER_URL=http://your-indexer:42067`                           |
| **FluxNode pool** (free, distributed) | default; many nodes instead of one                                     |
| **Own `fluxd`**                       | planned — see [#36](https://github.com/2ndtlmining/fluxflow/issues/36) |

`SYNC_CONCURRENCY`, `SYNC_BATCH_SIZE`, `FLUXNODE_POOL_SIZE` and `FLUXNODE_MAX_INFLIGHT` are
the knobs. Lowering them reduces pressure on remote nodes at the cost of a slower backfill.

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
