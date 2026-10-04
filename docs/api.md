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

---

## Flows

### `GET /api/flow/:period`

Totals per direction, by counterparty kind and by exchange, plus the same figures for the
equally long window before this one.

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

## Intelligence (#18–#20, #31)

Labels carry a confidence: `confirmed` (≥ 0.95), `likely` (≥ 0.7), `possible` (≥ 0.45),
`candidate`. Only `likely` and above change how flows are counted.

### Additions to existing responses

- `GET /api/flow/:period` adds `exchangeHops: {count, buyingExcluded, sellingExcluded}` and
  `adjusted: {buying, selling, netFlow}` — the headline totals without exchange hops.
- `GET /api/flow/:period/{buyers,sellers}` rows add `name`, `confidence`, `level`,
  `labelSource`. `?minConfidence=` (`confirmed` | `likely` | `possible` | a number 0–1) keeps
  only wallets labelled at least that surely; anything else is `400`.
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

### `GET /api/intel/status`

Label counts by kind and source, the node list (size, source, time), node-operator counts,
the last clustering pass, hop count, the relabel queue length and the last job error.

## Admin

All need `Authorization: Bearer <ADMIN_TOKEN>` and are refused when no token is configured.

| Method | Path                                       | Body / query                                                                                                                                                                                                   |
| ------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/admin/sync`                          | —                                                                                                                                                                                                              |
| POST   | `/api/admin/retention`                     | —                                                                                                                                                                                                              |
| POST   | `/api/admin/intel/run`                     | — runs node refresh, clustering, hops and the relabel backlog now                                                                                                                                              |
| GET    | `/api/admin/labels/candidates`             | `?status=pending\|accepted\|rejected&limit=`                                                                                                                                                                   |
| POST   | `/api/admin/labels/candidates/decide`      | `{address, kind, name, decision: "accepted"\|"rejected"}`                                                                                                                                                      |
| GET    | `/api/admin/labels/review`                 | `?status=pending\|accepted\|rejected` — candidates with activity (sent/received, share to the proposed exchange, first/last seen), `strength` 0–1, the current label, and `counts` per status; strongest first |
| POST   | `/api/admin/labels/candidates/decide-bulk` | `{decision, candidates: [{address, kind, name}]}` (1–500) — all or nothing (404 + `missing` if any is unknown), one label refresh; answers `decided`, `changedAddresses`, `transactions` to re-derive          |
| POST   | `/api/admin/labels`                        | `{address, kind, name?, subLabel?, note?}` — a manual label; `kind: "unknown"` overrides                                                                                                                       |
| DELETE | `/api/admin/labels/:address`               | removes the address's manual labels                                                                                                                                                                            |

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
