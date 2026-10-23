# FluxFlow API

Every endpoint is a same-origin `GET` under `/api` unless noted. Amounts are in FLUX, times
in Unix seconds. Responses to the data endpoints carry an `ETag` that changes only when
stored data changes; send `If-None-Match` to get `304 Not Modified` between syncs.

`:period` is one of `24H`, `7D`, `30D`, `90D`, `6M`. A period runs from that long before the
newest stored block up to and including it. Anything else is a `400`.

Directions:

- **buying**: FLUX left an exchange for a non-exchange wallet (a withdrawal).
- **selling**: FLUX went from a non-exchange wallet to an exchange (a deposit).
- **p2p**: wallet to wallet, or exchange to exchange.

Counterparty kinds: `unknown`, `node_operator`, `foundation` (and `exchange` on the
exchange side).

---

## Health and status

### `GET /api/health`

O(1). `200` when sync is current, `503` when it is stale or has never succeeded.

```json
{ "status": "ok", "version": "5568d7d", "uptimeSeconds": 41, "lastSuccessfulSyncAt": 1791008231293 }
```

### `GET /api/status`

Cached once per data version: sync progress, database counts, data sources (with FluxNode
pool detail) and label counts.

`sync.catchUp` says whether the stored data is still catching up with the network (a fresh
install syncs six months oldest-first, forward to today). `catchingUp` turns false within 20
blocks of the tip. Times are unix seconds; `ingest.networkTip` is the same tip, and
`ingest.tip` is the highest _stored_ block.

```json
"catchUp": {
  "tip": 3007084,
  "behindBlocks": 318178,
  "catchingUp": true,
  "progress": 38.6,
  "dataFrom": 1775524774,
  "dataAsOf": 1781543554,
  "etaSeconds": 1391
}
```

---

## Flows

### `GET /api/flow/:period`

Totals per direction, by counterparty kind and by exchange, plus the same figures for the
equally long window before this one.

**A span inside the period (#29).** `?from=&to=` (unix seconds, `from < to`, both or neither)
narrows this endpoint, the leaderboards (`/buyers`, `/sellers`), `/events` and `/hops` to
`[from, to)`. The span is clamped to the period and to the oldest stored block, and each
response reports what it covers as `range: {from, to}` (`null` without one). A malformed
span, or one that does not overlap the period, is `400`. The "before" figures then cover the
equally long span just before it. `/series` and `/foundation` always cover the whole period.

```json
{
  "period": "7D",
  "ready": true,
  "buying": {
    "total": 812345.1,
    "count": 412,
    "breakdown": {
      "toNodeOperators": 1200.5,
      "toUnknown": 811144.6,
      "toFoundation": 0,
      "toExchanges": 0
    },
    "byExchange": { "Kucoin": { "name": "Kucoin", "total": 500000, "count": 200 } }
  },
  "selling": {
    "total": 1023456.7,
    "count": 530,
    "breakdown": {
      "fromNodeOperators": 23000,
      "fromUnknown": 1000456.7,
      "fromFoundation": 0,
      "fromExchanges": 0
    },
    "byExchange": {}
  },
  "netFlow": -211111.6,
  "byType": {
    "buying": { "unknown": 811144.6, "node_operator": 1200.5 },
    "selling": { "unknown": 1000456.7, "node_operator": 23000 }
  },
  "previousPeriod": {
    "from": 1790400000,
    "to": 1791004800,
    "buying": { "total": 700000, "count": 380 },
    "selling": { "total": 650000, "count": 300 },
    "netFlow": 50000,
    "byKind": { "buying": {}, "selling": {} }
  }
}
```

### `GET /api/flow/:period/events`

Keyset-paginated flows, newest first.

| Query       | Meaning                                                  |
| ----------- | -------------------------------------------------------- |
| `type`      | `buying`, `selling` or `p2p`                             |
| `kind`      | counterparty kind (either side)                          |
| `exchange`  | exchange name                                            |
| `minAmount` | minimum FLUX                                             |
| `limit`     | page size, 1–500 (default 50)                            |
| `cursor`    | `height:txid:vout` from the previous page's `nextCursor` |

```json
{
  "period": "24H",
  "events": [
    {
      "txid": "…",
      "vout": 0,
      "height": 3004201,
      "time": 1791008000,
      "fromAddress": "t1…",
      "fromKind": "unknown",
      "toAddress": "t1…",
      "toKind": "exchange",
      "exchange": "Kucoin",
      "flowType": "selling",
      "amount": 1250
    }
  ],
  "nextCursor": "3004199:ab…:1"
}
```

### `GET /api/flow/:period/buyers` · `GET /api/flow/:period/sellers`

Leaderboards: who withdrew from, or deposited to, exchanges.

| Query   | Meaning                                         |
| ------- | ----------------------------------------------- |
| `limit` | 1–100 (default 10)                              |
| `kind`  | `unknown`, `node_operator` or `foundation` only |
| `tag`   | a behaviour tag (#68), e.g. `automated`         |

```json
{
  "period": "30D",
  "flowType": "selling",
  "total": 4200000,
  "sellers": [
    {
      "rank": 1,
      "address": "t1…",
      "name": null,
      "kind": "node_operator",
      "total": 120000,
      "count": 14,
      "share": 0.0286,
      "exchanges": [
        { "name": "Kucoin", "total": 100000, "count": 10 },
        { "name": "Coinex", "total": 20000, "count": 4 }
      ],
      "lastSeen": 1791000000,
      "previousTotal": 80000,
      "change": 40000
    }
  ]
}
```

`previousTotal` is the same wallet, same direction, over the equally long window before this
one. Periods longer than 7 days may be up to 10 minutes old (see "Performance" below).

### `GET /api/flow/:period/series`

Buying, selling and net per bucket: hourly up to `7D`, daily beyond. Every bucket is present,
including empty ones. The first bucket starts at the window's start.

| Query      | Meaning                                                      |
| ---------- | ------------------------------------------------------------ |
| `exchange` | only flows through this exchange                             |
| `kind`     | counterparty kind (`unknown`, `node_operator`, `foundation`) |

```json
{
  "period": "24H",
  "bucketSeconds": 3600,
  "points": [
    { "time": 1790921600, "buying": 1200, "selling": 3400, "net": -2200, "cumulativeNet": -2200 }
  ]
}
```

FLUX price overlay is not part of the API yet.

---

## Wallets

Addresses must be FLUX transparent addresses (`t1…` or `t3…`, 35 base58 characters);
anything else is a `400`. There is no server-side watchlist: the UI keeps it in the browser.

### `GET /api/wallets/:address`

`404` when nothing is stored for the address.

```json
{
  "address": "t1…",
  "kind": "node_operator",
  "name": null,
  "labels": [{ "kind": "node_operator", "name": null, "source": "rewards", "confidence": 0.9 }],
  "totals": {
    "bought": 5000,
    "sold": 12000,
    "net": -7000,
    "boughtCount": 3,
    "soldCount": 9,
    "p2pIn": 40,
    "p2pOut": 0
  },
  "byExchange": [{ "name": "Kucoin", "bought": 5000, "sold": 12000, "count": 12 }],
  "firstSeen": 1780000000,
  "lastSeen": 1791000000,
  "series": [{ "time": 1790899200, "bought": 0, "sold": 1200 }],
  "recent": { "events": [], "nextCursor": "…" }
}
```

Exchange totals (`bought`, `sold`, `byExchange`, `series`) come from rollups and cover all
stored history, including days older than the raw retention window. `p2pIn`/`p2pOut` and
`recent` come from raw rows and cover the retention window only.

### `GET /api/wallets/:address/events`

The wallet's flows, either side, newest first. Same `cursor`/`limit` as the period events
(limit 1–200), and `type` = `buying` | `selling` | `p2p`.

### `GET /api/wallets/:address/counterparties`

`?limit=` (1-100, default 15). Who the wallet deals with, over the raw retention window:

```json
{
  "address": "t1…",
  "incoming": { "total": 1000, "count": 3, "distinct": 2, "parties": [Party] },
  "outgoing": { "total": 550, "count": 3, "distinct": 2, "parties": [Party] },
  "firstFunder": { "address": "t1…", "kind": "foundation", "name": "Flux Foundation", "txid": "…", "time": 1792227904, "amount": 1000 },
  "appPayments": { "total": 150, "count": 2 },
  "foundationMoves": null
}
```

`Party` is `{address, kind, name, total, count, share, firstSeen, lastSeen}`; `share` is of that side's
total. `firstFunder` is the earliest stored transfer into the wallet (`null` if none), and
`appPayments` what it paid to `app_hosting` addresses. For a Foundation wallet,
`foundationMoves` is `{incoming, outgoing}` in the same shape as above: what it moved to and
from the Foundation's other wallets. Those moves are never flows, so `incoming` and `outgoing`
leave them out. It is `null` for every other wallet.

### `GET /api/path`

Path finder (#70): the strongest routes from `src` to `dst`, ranked by their **bottleneck**
(the smallest hop, which caps how much can have travelled the whole way).

| Query     | Meaning                                                       |
| --------- | ------------------------------------------------------------- |
| `src`     | wallet the money starts at (required)                         |
| `dst`     | wallet it ends at (required)                                  |
| `maxHops` | 1–6, default 4                                                |
| `limit`   | paths returned, 1–20, default 5                               |
| `through` | `exchanges` to pass through exchange wallets (off by default) |
| `period`  | `24H` … `6M`; everything stored when left out                 |

```json
{
  "src": "t1…",
  "dst": "t3…",
  "maxHops": 4,
  "throughExchanges": false,
  "paths": [
    {
      "bottleneck": 1000,
      "hops": [
        {
          "from": "t1…",
          "to": "t1…",
          "total": 80000,
          "count": 1,
          "first": 1792000000,
          "last": 1792000000,
          "internal": true
        }
      ]
    }
  ],
  "nodes": { "t1…": { "kind": "foundation", "name": "Flux Foundation" } },
  "explored": { "forward": 26, "backward": 26 },
  "trimmed": 3,
  "truncated": false
}
```

Edges are wallet-to-wallet totals from `flows`, plus moves between Foundation wallets
(`internal: true`), which are never flows but are part of a trail. The search goes
breadth-first from both ends, takes at most 25 counterparties per wallet and side (largest
first; `trimmed` counts the wallets that had more) and 1,500 wallets per side; `truncated`
says when a budget stopped it. Under 250 ms at 6 hops on a synthetic six-month database.

### Investigation workspace (#69)

Your own notes, tags and saved cases. FluxFlow runs for one person on a local network, so
these need no admin token; every field is validated and size-limited. Notes and tags never
change a label, a kind or a total.

| Method | Path                  | Body / answer                                                                            |
| ------ | --------------------- | ---------------------------------------------------------------------------------------- |
| GET    | `/api/notes/:address` | `{address, note: {note, tags, updatedAt} \| null}`                                       |
| PUT    | `/api/notes/:address` | `{note?, tags?}` (up to 4,000 characters, 10 tags of 32); clearing both removes the note |
| GET    | `/api/cases`          | `{cases: [{id, name, description, count, updatedAt}]}`, most recently changed first      |
| POST   | `/api/cases`          | `{name, description?, addresses?, graph?}` → `201 {id}`                                  |
| GET    | `/api/cases/:id`      | the case plus `members: [{address, kind, name, note}]`; `404` when there is none         |
| PATCH  | `/api/cases/:id`      | any of `name`, `description`, `addresses`, `graph` (`null` forgets the saved view)       |
| DELETE | `/api/cases/:id`      | `{deleted: true}`; notes on its wallets stay                                             |

`graph` is the fund-flow view to reopen: `{root, period, min, expand: ["address:in" | "address:out", …]}`,
replayed in order by `/graph?root=…&expand=…`. A case holds up to 200 addresses.
`GET /api/wallets/:address` adds `note` and `cases: [{id, name}]`, and `/api/search` also
matches note text and tags, returning `note` with each wallet.

### `GET /api/wallets/:address/sources` and `/destinations`

`?hops=` (1-4, default 3). Source of funds (everything the wallet received, including coinbase
node rewards) or destination of funds (everything it sent), over the raw retention window:

```json
{
  "address": "t1…",
  "direction": "in",
  "hops": 3,
  "total": 1000,
  "byKind": { "foundation": 400, "node_rewards": 600 },
  "byExchange": {},
  "endpoints": [
    { "address": "t1…", "kind": "foundation", "name": "Flux Foundation", "amount": 400, "hop": 2 }
  ],
  "untraced": 0,
  "truncated": false
}
```

A labelled counterparty ends the trace. An unlabelled one (among each wallet's 5 largest) is
followed one hop further and its own mix applied in proportion; what is still unlabelled at the
last hop is `unknown`. `byKind` keys are the address kinds plus `node_rewards` (sources) and
`held` (destinations: what an intermediate wallet received but did not send on). `byKind` sums
to `total`; `untraced` is `byKind.unknown`. `endpoints` lists the largest labelled wallets
reached, with the fewest hops to each. At most 300 wallets are read per trace; `truncated`
says the budget ran out. At `hops=2`, `sources` equals `/api/apps` `fundedBy`.

### `GET /api/wallets/:address/balance`

What a wallet holds now and held each day of the stored history (#67). Not cached on the data
version: the current balance is read from your own node (`FLUX_NODE_URL`, address index) and
kept for five minutes per address. Foundation wallets use the Foundation report's balance
snapshot, so their line matches `/api/foundation`'s.

```json
{
  "address": "t3c4…",
  "balance": 9576898,
  "asOf": 1792456046039,
  "opening": 6609778.19,
  "series": [{ "time": 1776729600, "net": 12.5, "change": 12.5, "balance": 6609790.69 }],
  "consistent": true,
  "tipHeight": 3052081
}
```

`series` has one point per day with activity: the day's net change, the running change since
the first stored day, and the closing balance, rebuilt backwards from `balance`. `opening` is
what it held before the first stored day. Every delta counts, including node rewards,
transfers that produced no flow and fees. Without a node, `balance`, `opening` and every
point's `balance` are null; draw `change` instead. `consistent` is false when the rebuilt
history would dip below zero, meaning transactions are missing from the stored data (for
example while sync is still catching up to the node).

`GET /api/entities/:id/balance` returns the same for all of an entity's addresses combined
(plus `id` and `members`). Moves between its own addresses net to the fee. An entity with
more than 50 addresses the node would have to be asked about has an unknown balance.

### `GET /api/graph`

The fund-flow graph (#63): one wallet's largest senders and/or recipients as nodes and edges.
The `/graph?root=` page calls it once per click.

| Parameter   | Default | Meaning                                                                 |
| ----------- | ------- | ----------------------------------------------------------------------- |
| `address`   |         | The wallet (required)                                                   |
| `direction` | `both`  | `in` (senders), `out` (recipients) or `both`                            |
| `depth`     | 1       | 1-3: repeat for the unlabelled wallets found; labelled ones end a trail |
| `fanout`    | 12      | 1-50 counterparties per wallet and side, largest first                  |
| `minAmount` | 0       | Leave out edges under this many FLUX                                    |
| `period`    | all     | `24H` … `6M`; without it, the whole stored window                       |

```json
{
  "root": "t3…",
  "direction": "both",
  "depth": 1,
  "nodes": [{ "address": "t3…", "kind": "app_hosting", "name": "Flux App Hosting" }],
  "edges": [
    {
      "from": "t1…",
      "to": "t3…",
      "total": 386553,
      "count": 412,
      "first": 1776765244,
      "last": 1792346614
    }
  ],
  "expanded": {
    "t3…": { "in": { "more": 139, "sampled": false }, "out": { "more": 0, "sampled": false } }
  },
  "truncated": false
}
```

An edge is every flow between two wallets in the window. `expanded` says, per wallet and side,
how many counterparties were left out (`more`) and whether only its newest 20,000 flows were
read (`sampled`, for very busy wallets). At most 200 nodes; `truncated` says that cap was hit.

### `GET /api/tx/:txid`

One transaction as FluxFlow classified it (#66), for the `/tx/:txid` page. `txid` is 64 hex
characters (any case); anything else is a 400, and a transaction outside the stored window is a 404.

```json
{
  "txid": "4532…44c8",
  "height": 3019535,
  "time": 1791477634,
  "totalIn": 303992.8118619,
  "totalOut": 303992.81148772,
  "fee": 0.00037418,
  "parties": [
    {
      "address": "t1JKj8…",
      "kind": "unknown",
      "name": null,
      "label": null,
      "entity": null,
      "sent": 182165.45,
      "received": 0,
      "net": -182165.45,
      "role": "funder",
      "share": 0.5992
    }
  ],
  "flows": [
    {
      "vout": 0,
      "fromAddress": "t1JKj8…",
      "toAddress": "t1Yvim…",
      "fromKind": "unknown",
      "toKind": "exchange",
      "exchange": "GateIO",
      "flowType": "selling",
      "amount": 182165.22,
      "share": 0.5992,
      "stale": false
    }
  ],
  "hops": [],
  "note": null
}
```

`parties` nets each address's inputs against its outputs: `role` is `funder` (paid in more
than it got back), `recipient` or `change` (got back exactly what it paid). A funder's `share`
is its part of all net input, which is the share of every output credited to it. `kind`, `name`
and `label` are the label **now**; each flow keeps the kinds it was classified with, and
`stale` marks a row whose labels have changed since (the next relabel pass re-derives it).
`hops` lists the exchange hops this transaction is a leg of (`leg`: `buy` or `sell`, with
`otherTxid`). `note` says why a transaction produced no flows (a self-transfer, Foundation
wallets only, a coinbase).

### `GET /api/search?q=` (also `/api/wallets/search`)

`q` is 2–64 characters. Three forms:

- a 64-hex **txid**: returns `{ "type": "tx", "txid": "…", "height": 3004201 }` if a flow has it
- an **address prefix** (`t1`/`t3` + base58): known wallets starting with it
- anything else: a case-insensitive match on **label names**

```json
{
  "query": "kucoin",
  "results": [{ "type": "wallet", "address": "t1…", "name": "Kucoin", "kind": "exchange" }]
}
```

At most `limit` results (1–25, default 10).

---

## Entities (#65)

One owner behind many addresses. **Label entities** are derived: every applied label with a name
groups its addresses (id `exchange:Kucoin`), and all Foundation addresses are one entity (id
`foundation`). **Named entities** (id `e-<name>`) are stored, named on the review page; a
`cluster` member brings its whole current co-spend cluster, so the entity follows the cluster as
clustering finds more of it. An address belongs to one entity: a named entity wins over a label
entity, and the older named entity over a newer one. Entities never change a flow's kind or an
exchange total; they group and name. Elsewhere in the API, an unlabelled member of a named entity
is called by the entity's name, and `GET /api/wallets/:address` has `entity` (or `null`).

### `GET /api/entities`

`?q=` (name contains, 1-100 characters), `?limit=` (1-500, default 100). Most members first:

```json
{
  "total": 6,
  "entities": [
    {
      "id": "exchange:Kucoin",
      "name": "Kucoin",
      "kind": "exchange",
      "source": "label",
      "members": 28
    }
  ]
}
```

### `GET /api/entities/:id`

`?period=` (`24H` … `6M`, default `30D`). The Foundation report (below) for the entity's addresses —
`totals`, `series`, `recent`, `wallets` (the 100 most active, each with its member `source`) —
plus `memberSources`, `appPayments`, and `incoming` / `outgoing` counterparties grouped into
entities where they belong to one (`{entity: {id, members} | null, address, name, kind, total,
count, share, firstSeen, lastSeen}`). Moves between its own addresses are internal, so for
`foundation` the totals equal `/api/foundation`'s. 90-day and 6-month reports may be reused for
up to 5 minutes. 404 for an unknown id.

### `GET /api/clusters`

`?limit=` (1-100, default 25), `?unnamed=1` to skip clusters whose members all belong to an
entity. Largest first: `{anchor, size, sample, entities: [{id, name, kind, members}], unassigned,
received, sent}`. `anchor` is a member address — cluster ids change on every clustering pass.

## Intelligence (#18–#20, #31)

Labels carry a confidence: `confirmed` (≥ 0.95), `likely` (≥ 0.7), `possible` (≥ 0.45),
`candidate`. Only `likely` and above change how flows are counted.

### Additions to existing responses

- `GET /api/flow/:period` adds `exchangeHops: {count, buyingExcluded, sellingExcluded}` and
  `adjusted: {buying, selling, netFlow}` — the headline totals without exchange hops.
- `GET /api/flow/:period/{buyers,sellers}` rows add `name`, `confidence`, `level`,
  `labelSource`. `?minConfidence=` (`confirmed` | `likely` | `possible` | a number 0–1) keeps
  only wallets labelled at least that surely; anything else is `400`.
- Behaviour tags (#68): leaderboard rows add `tags` (tag names), and `?tag=` keeps only
  wallets with that tag (`recurring_payer`, `automated`, `collateral_amounts`,
  `dormant_waking`, `peel_chain`; anything else is `400`). `GET /api/wallets/:address` adds
  `tags: [{tag, evidence, updatedAt}]`, and `GET /api/intel/status` adds
  `behaviour: {at, ms, tags}` (wallets per tag after the last pass), and
  `coverage: {volume, classified, share, byKind, at}` (#20): exchange volume in the stored
  window, the part with a classified counterparty, and the share (`null` with no volume).
  `/api/metrics` exposes it as `fluxflow_classified_share` and
  `fluxflow_exchange_volume_flux{classified="yes"|"no"}`. Tags never change a
  label, a kind or a flow.
- `GET /api/wallets/:address` adds `label` (the one that classifies its flows, or `null`),
  `labels[]` (every label on record with `source`, `confidence`, `level`, `applied`,
  `validFrom`, `validTo`, `evidence`), `cluster: {clusterId, size, sample[]} | null` and
  `candidates[]`.

### `GET /api/flow/:period/hops`

```json
{
  "period": "7D",
  "summary": { "count": 9, "buyingExcluded": 237340.2, "sellingExcluded": 237340.2 },
  "hops": [
    {
      "address": "t1…",
      "fromExchange": "Coinex",
      "toExchange": "Kucoin",
      "withdrawn": 7866,
      "amount": 7860,
      "blocksApart": 13,
      "buyTxid": "…",
      "sellTxid": "…",
      "sellHeight": 2988264,
      "sellTime": 1790000000
    }
  ]
}
```

A withdrawal re-deposited by the same wallet within `INTEL_HOP_MAX_BLOCKS` (default 240)
blocks, for 97–100% of the amount.

### `GET /api/foundation?period=30D`

```json
{
  "period": "30D",
  "wallets": [
    {
      "address": "t1…",
      "name": "Flux Foundation",
      "subLabel": "Treasury",
      "balance": 1200000,
      "inflow": 0,
      "outflow": 50000,
      "net": -50000
    }
  ],
  "totals": {
    "balance": 1200000,
    "inflow": 0,
    "outflow": 50000,
    "net": -50000,
    "internalTransfers": 3,
    "internalVolume": 2077207
  },
  "series": [{ "time": 1790035200, "net": -50000, "balance": 1200000 }],
  "recent": [
    {
      "txid": "…",
      "height": 3001000,
      "time": 1790040000,
      "amount": -50000,
      "counterparty": "t1…",
      "counterpartyName": "Kucoin",
      "counterpartyKind": "exchange",
      "wallets": ["t1…"]
    }
  ],
  "balancesAsOf": 1790040000000,
  "destinations": {
    "traced": 50000,
    "maxHops": 3,
    "hopBlocks": 20160,
    "exchange": 12000,
    "byExchange": { "Kucoin": 12000 },
    "nodes": 30000,
    "collateral": {
      "payments": 2,
      "amount": 25000,
      "unconfirmedPayments": 1,
      "unconfirmedAmount": 1000
    },
    "returned": 0,
    "held": 8000,
    "untraced": 0,
    "recipients": [
      {
        "address": "t1…",
        "name": null,
        "kind": "unknown",
        "subLabel": null,
        "received": 20000,
        "hops": 2,
        "exchange": 12000,
        "byExchange": { "Kucoin": 12000 },
        "nodes": 0,
        "collateral": {
          "payments": 0,
          "amount": 0,
          "unconfirmedPayments": 0,
          "unconfirmedAmount": 0
        },
        "returned": 0,
        "held": 8000,
        "untraced": 0
      }
    ]
  }
}
```

Movements are netted across all Foundation wallets per transaction, so internal moves are
counted as `internalTransfers`, not as outflow plus inflow. `balance` needs `FLUX_NODE_URL`
(the node's address index); without it balances and the balance series are `null`.

`destinations` follows every outflow forward, up to `maxHops` wallets, and says where the
value ended: `exchange` (by name), `nodes` (a node operator address, or the collateral of a
node on the current node list), `returned` (back to a Foundation wallet), `held` (not passed
on within `hopBlocks`) and `untraced` (still moving after `maxHops` wallets). These five add
up to `traced`. Value is capped (a wallet passes on at most what was traced into it,
first-in first-out) and split by contribution in transactions with several funders.
`collateral.unconfirmed*` counts payments of exactly 1,000, 12,500 or 40,000 FLUX that no
running node uses; they are informational and their value is still followed. `recipients`
lists the largest direct recipients; `hops: 2` means the value ended at the recipient's
recipient.

Wallets that receive Foundation money and pass it on as node collateral are labelled
`foundation` (source `foundation_intermediary`, subLabel `Pays node collateral (detected)`),
so payments to them are internal and their payments are the Foundation's outflows. Wallets
that pass Foundation money on elsewhere are recorded at `possible` confidence only and never
change a total.

The report is cached per data version, label change and balance snapshot, and recomputed in
the background once a minute; a stale copy is served for up to five minutes meanwhile.

### `GET /api/apps?period=30D`

Flux app (dapp) hosting fees: transfers into the addresses labelled `app_hosting` in
`config/labels.json` (`appHosting`). They stay `p2p` flows and never change buying or selling.
`?limit=` (1-100, default 20) sizes `topPayers`.

```json
{
  "period": "30D", "fromTime": 1789638304, "toTime": 1792230304,
  "hosting": [{ "address": "t3NryfAQLGeFs9jEoeqsxmBN2QLRaRKFLUX", "name": "Flux App Hosting" }],
  "total": 52876.2, "count": 9516, "payers": 49,
  "byPayerKind": { "unknown": 51000, "node_operator": 1230 },
  "series": [{ "time": 1792195200, "total": 812.4, "count": 140 }],
  "topPayers": [{
    "address": "t1…", "kind": "unknown", "name": null, "total": 25576, "count": 3415, "share": 0.48,
    "firstSeen": 1776668314, "lastSeen": 1792227904,
    "fundedBy": { "received": 159373, "mix": { "foundation": 99313, "unknown": 60060 } },
    "topFunders": [{ "address": "t1…", "kind": "foundation", "name": "Flux Foundation", "total": 80000 }]
  }],
  "fundingOfPayments": { "foundation": 0.62, "unknown": 0.35, "exchange": 0.03 },
  "outflows": { "total": 744023, "recipients": [Party] }
}
```

`fundedBy` apportions everything the payer received (stored window, up to the period's end) by
the kind that sent it; an unlabelled sender is followed one more hop and its own mix applied in
proportion (largest 25 senders, 5 followed). It ignores ordering and balances: an indication, not
an audit. `fundingOfPayments` weights the top payers' mixes by what each paid for apps.
`outflows` is where the hosting addresses sent money in the period. The Foundation report's
destination trace also counts value reaching an `app_hosting` address as `apps`.

### `GET /api/intel/status`

Label counts by kind and source, the node list (size, source, time), node-operator counts,
the last clustering pass, hop count, the relabel queue length and the last job error.

## Admin

All need `Authorization: Bearer <ADMIN_TOKEN>` and are refused when no token is configured.

| Method | Path                                       | Body / query                                                                                                                                                                                                   |
| ------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/admin/sync`                          | —                                                                                                                                                                                                              |
| POST   | `/api/admin/retention`                     | —                                                                                                                                                                                                              |
| POST   | `/api/admin/intel/run`                     | — starts node refresh, clustering, hops and the relabel backlog; answers `202` at once (progress on `/api/intel/status`)                                                                                       |
| GET    | `/api/admin/labels/candidates`             | `?status=pending\|accepted\|rejected&limit=`                                                                                                                                                                   |
| POST   | `/api/admin/labels/candidates/decide`      | `{address, kind, name, decision: "accepted"\|"rejected"}`                                                                                                                                                      |
| GET    | `/api/admin/labels/review`                 | `?status=pending\|accepted\|rejected` — candidates with activity (sent/received, share to the proposed exchange, first/last seen), `strength` 0–1, the current label, and `counts` per status; strongest first |
| POST   | `/api/admin/labels/candidates/decide-bulk` | `{decision, candidates: [{address, kind, name}]}` (1–500) — all or nothing (404 + `missing` if any is unknown), one label refresh; answers `decided`, `changedAddresses`, `transactions` to re-derive          |
| POST   | `/api/admin/labels`                        | `{address, kind, name?, subLabel?, note?}` — a manual label; `kind: "unknown"` overrides                                                                                                                       |
| DELETE | `/api/admin/labels/:address`               | removes the address's manual labels                                                                                                                                                                            |
| POST   | `/api/admin/entities`                      | `{name, kind?, note?, addresses?: [], clusterOf?: []}` — a named entity (#65); `clusterOf` adds each address with its whole current co-spend cluster. Answers `{id}`                                           |
| PATCH  | `/api/admin/entities/:id`                  | `{name?, kind?, note?}`                                                                                                                                                                                        |
| DELETE | `/api/admin/entities/:id`                  | removes the entity and its members                                                                                                                                                                             |
| POST   | `/api/admin/entities/:id/members`          | `{addresses?: [], clusterOf?: []}`                                                                                                                                                                             |
| DELETE | `/api/admin/entities/:id/members/:address` | removes one member row                                                                                                                                                                                         |

---

## Performance

Measured with `npx tsx scripts/bench-api.ts` on a synthetic 6-month database: 518,400 blocks,
1.7M flows, wallets drawn heavy-tailed from a pool of 20,000. Warm, p50:

| Query                    | 24H    | 7D     | 30D    | 6M     |
| ------------------------ | ------ | ------ | ------ | ------ |
| summary (buy + sell)     | 0.3 ms | 0.4 ms | 0.7 ms | 2.4 ms |
| events, first page       | 0.1 ms | 0.1 ms | 0.1 ms | 0.1 ms |
| series                   | 0.3 ms | 1.0 ms | 0.4 ms | 0.5 ms |
| top sellers              | 5.4 ms | 17 ms  | 50 ms  | 111 ms |
| wallet profile (busiest) | 3.0 ms |        |        |        |

An exact top-N has to group every wallet active in the window: ~19,000 distinct sellers
over 6 months here. Rankings for periods over 7 days are therefore recomputed at most every
10 minutes rather than on every sync.
