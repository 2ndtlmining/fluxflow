# 1. Rewrite FluxFlow as a single TypeScript service

- **Status:** Accepted
- **Date:** 2026-10-03
- **Supersedes:** the phase ordering in #34
- **Decides:** the open question raised in #8 ("Should FluxFlow move to Rust?")
- **Tracking:** #36

## Context

FluxFlow is a SvelteKit dashboard over an Express API that tracks FLUX exchange flow from
chain data. A full code review (#2–#35) found that the slowness is **architectural**, not
language-related:

| Stage                                                         | Measured                       | Needed for a full-speed 6-month backfill | Headroom                      |
| ------------------------------------------------------------- | ------------------------------ | ---------------------------------------- | ----------------------------- |
| Fetch from a FluxNode pool (live, 40 nodes)                   | 1,267–1,430 blocks/s           | –                                        | the ceiling                   |
| `JSON.parse` + normalise a real 13 KB block (Node 22, 1 core) | 24 µs (~41,000 blocks/s)       | 1,300 blocks/s                           | ~30×                          |
| SQLite batched inserts, 3 indexes (better-sqlite3)            | 178,000 rows/s                 | ≤ ~40,000 rows/s                         | ~4×                           |
| `/api/flow/6M` today (aggregation in JS)                      | 28 s, then crash               | –                                        | fixed by rollups (#4)         |
| Status polling today                                          | ~700 ms/call, ~5 calls per 5 s | –                                        | fixed by cached counters (#3) |

At the network ceiling, Node sits at **<5% CPU for parsing** and **<25% for writes**. A Rust
implementation of the same design would be exactly as slow.

## Decision

**Option B: rebuild FluxFlow as a single TypeScript service** (Node 22 LTS + SvelteKit 2 /
Svelte 5 + SQLite). Keep the language, change the design.

### Why not the alternatives

|                                   | A. Patch current code         | **B. TypeScript rework**        | C. Rust backend | D. Go backend |
| --------------------------------- | ----------------------------- | ------------------------------- | --------------- | ------------- |
| Fixes the real bottlenecks        | partly                        | yes                             | yes             | yes           |
| Effort to v2                      | lowest, but repeated patching | ~9–12 wks                       | ~12–16 wks      | ~11–14 wks    |
| Reuse of code/knowledge           | high                          | **medium–high**                 | low (UI only)   | low (UI only) |
| Type safety for chain data shapes | none                          | good (strict TS + zod at edges) | excellent       | good          |
| Risk                              | accumulates                   | low–medium                      | medium–high     | medium–high   |

Choose **C (Rust)** later instead if any of these become true:

1. FluxFlow becomes a **full-chain indexer or public API** serving many concurrent users
   (clustering over all history, an address index for every wallet). That workload is
   CPU- and memory-heavy, and Rust pays off.
2. **Hosting cost per MB of RAM** is the binding constraint, e.g. running as a small Flux app
   where ~100 MB vs ~30 MB changes the spec tier.
3. The maintainers are already comfortable in Rust.

### Target architecture

```
┌──────────────── one container, one process, one port ─────────────────┐
│  main thread: HTTP — SvelteKit handler + /api router — reads SQLite    │
│                (WAL) — SSE                                            │
│  worker thread: ingest                                                │
│     DataSource: FluxNode pool → own fluxd (optional) → Blockbook,     │
│     circuit-broken → normalise → single writer txn/batch → facts +    │
│     rollups → gap repair, reorg check, retention                      │
│  worker thread: intelligence (labels, node rewards, clustering,       │
│     heuristics)                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

## The Rust seam

Ingestion is its own module on a worker thread and communicates with the API **only through
the SQLite schema**: it writes immutable chain facts, and the API derives read models from
them. Porting ingest to a Rust sidecar later touches neither the API nor the UI. This is the
property that makes option B a safe stepping stone rather than a dead end.

## Consequences

- **Good:** the `/api/*` 404 in Docker (#9) and the hard-coded LAN IP (#11) become structurally
  impossible — there is one process, one port, and config comes from validated env vars.
- **Good:** hung requests can no longer stall sync forever (#10) because every outbound call
  goes through one client with a mandatory `AbortSignal.timeout`.
- **Good:** chain data shapes are validated at the edge with zod, so a FluxNode returning a
  surprise shape fails loudly instead of writing half a block (#15).
- **Bad:** the rewrite risks regression. Mitigated by keeping v1 runnable until v2 matches it,
  and by a parallel-run cutover (see #36 Phase 5).
- **Bad:** ~9–12 weeks of work. Mitigated by the MVP cut in #36 (~5–6 weeks) and by shipping
  one theme per PR.

## Alternatives rejected

- **Option A (patch in place).** Lowest effort per fix but the design debt is the cause of
  most of the 30+ issues; each patch lands on top of the same two-process/JS-aggregation
  architecture.
- **DuckDB for analytics.** Still worth evaluating for the analytics queries (#4), but it does
  not address ingestion, the API contract, or the data model. Deferred.
