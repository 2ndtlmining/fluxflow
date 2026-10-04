/**
 * The intelligence pass (#18-#20, #31): keeps labels current and flows consistent with them.
 *
 * Jobs, each on its own timer and each cheap or bounded:
 *
 *   labels file   watched; an edit is applied without a restart
 *   node list     every NODE_REFRESH_SECONDS: node-list, coinbase-reward and forwarding
 *                 labels (`nodes.ts`)
 *   clustering    every INTEL_CLUSTER_SECONDS: clusters and exchange candidates
 *                 (`clusters.ts`); candidates change nothing until accepted
 *   hops          every minute, incrementally (`hops.ts`)
 *   balances      Foundation balances from your own node, when configured (`foundation.ts`)
 *   foundation    with the node list: Foundation intermediaries (`intermediaries.ts`); the
 *                 report and its traced destinations (`destinations.ts`) are cached per data
 *                 version and recomputed in the background, off the request path
 *   relabel       whenever the queue is not empty: re-derives flows in ≤ 50 ms batches,
 *                 inside the sync loop's exclusive section (`relabel.ts`)
 *
 * Nothing here blocks ingestion for long, and every job logs and carries on when it fails —
 * stale intelligence is better than a stopped service.
 */

import fs from 'node:fs';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Db } from '../db/database.js';
import type { HttpRequestOptions } from '../http.js';
import type { SyncService } from '../ingest/sync.js';
import { APPLY_MIN_CONFIDENCE, replaceSourceLabels, type LabelLookup } from '../labels.js';
import { serialiseError } from '../logger.js';
import { clusterAddresses, storeCandidates, type ClusterResult } from './clusters.js';
import { fetchBalances, type BalanceSnapshot } from './foundation.js';
import { detectDepositForwarders } from './forwarders.js';
import { detectIntermediaries, INTERMEDIARY_SOURCE } from './intermediaries.js';
import { dataVersion } from '../api/queries.js';
import { detectHops } from './hops.js';
import { computeNodeOperatorLabels, fetchNodeList, type NodeList } from './nodes.js';
import { Relabeler } from './relabel.js';

const HOP_INTERVAL_MS = 60_000;
const RELABEL_INTERVAL_MS = 2_000;
const BALANCE_INTERVAL_MS = 10 * 60_000;
const LABEL_WATCH_MS = 5_000;
/** A cached Foundation report is served while its replacement is computed, for this long. */
const FOUNDATION_STALE_MS = 5 * 60_000;
const FOUNDATION_REFRESH_MS = 60_000;

export interface IntelStatus {
  readonly enabled: boolean;
  readonly relabelQueue: number;
  readonly nodeList: { addresses: number; source: string; at: number } | null;
  readonly nodeOperators: {
    list: number;
    rewards: number;
    forwarding: number;
    protocolPayouts: number;
    foundationIntermediaries: number;
  } | null;
  readonly clustering: {
    at: number;
    clusters: number;
    clusteredAddresses: number;
    largest: number;
    candidates: number;
    conflicts: number;
    /** Deposit addresses labelled by behaviour (`forwarder`). */
    forwarders: number;
  } | null;
  readonly hops: { at: number; total: number } | null;
  readonly lastError: string | null;
}

export interface IntelServiceOptions {
  readonly config: Config;
  readonly db: Db;
  readonly labels: LabelLookup;
  readonly log: Logger;
  readonly sync?: SyncService | null;
  readonly http?: Partial<HttpRequestOptions>;
}

export class IntelService {
  private readonly relabeler: Relabeler;
  private timers: NodeJS.Timeout[] = [];
  private watching = false;
  private running = new Set<string>();
  private nodeList: {
    list: NodeList;
    source: string;
    collateralTxids: Set<string>;
    at: number;
  } | null = null;
  private nodeCounts: IntelStatus['nodeOperators'] = null;
  private clustering: IntelStatus['clustering'] = null;
  private hops: IntelStatus['hops'] = null;
  private hopHeight = 0;
  private lastError: string | null = null;
  private balances: BalanceSnapshot | null = null;
  private foundationCache = new Map<
    string,
    { key: string; at: number; value: unknown; compute: () => unknown; maxStaleMs: number }
  >();

  constructor(private readonly options: IntelServiceOptions) {
    this.relabeler = new Relabeler(
      options.db,
      options.labels,
      options.log.child({ job: 'relabel' })
    );
  }

  start(): void {
    const { config } = this.options;
    if (!config.intel.enabled) return;

    const every = (ms: number, job: () => Promise<unknown>) => {
      const timer = setInterval(() => void job(), ms);
      timer.unref?.();
      this.timers.push(timer);
    };

    every(RELABEL_INTERVAL_MS, () => this.relabel());
    every(config.nodeRefreshSeconds * 1000, () => this.refreshNodes());
    every(config.intel.clusterSeconds * 1000, () => this.cluster());
    every(HOP_INTERVAL_MS, () => this.detectHops());
    every(FOUNDATION_REFRESH_MS, () => this.refreshFoundation());
    if (config.dataSources.fluxNodeUrl) every(BALANCE_INTERVAL_MS, () => this.refreshBalances());

    // First runs shortly after boot, not during it.
    const soon = setTimeout(() => {
      void this.refreshNodes()
        .then(() => this.cluster())
        .then(() => this.detectHops());
      void this.refreshBalances();
    }, 5_000);
    soon.unref?.();
    this.timers.push(soon);

    // Polling, not fs.watch: a bind-mounted file inside Docker does not deliver inotify events
    // reliably, and editors replace the file rather than writing to it.
    fs.watchFile(config.labelsPath, { interval: LABEL_WATCH_MS }, () => {
      this.options.log.info({ path: config.labelsPath }, 'labels file changed, reloading');
      this.options.labels.reload();
    });
    this.watching = true;
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.watching) fs.unwatchFile(this.options.config.labelsPath);
    this.watching = false;
  }

  status(): IntelStatus {
    return {
      enabled: this.options.config.intel.enabled,
      relabelQueue: this.relabeler.pending(),
      nodeList: this.nodeList
        ? { addresses: this.nodeList.list.size, source: this.nodeList.source, at: this.nodeList.at }
        : null,
      nodeOperators: this.nodeCounts,
      clustering: this.clustering,
      hops: this.hops,
      lastError: this.lastError
    };
  }

  /** The latest Foundation balances, or null when no node is configured or none answered. */
  foundationBalances(): BalanceSnapshot | null {
    return this.balances;
  }

  /**
   * A Foundation report, computed at most once per data version and label change.
   *
   * The report walks Foundation outflows several wallets deep, which is too much work for
   * every request on a long period. A fresh entry is returned as is; a stale one (data or
   * labels changed since) is still returned for up to {@link FOUNDATION_STALE_MS} while a
   * replacement is computed after the response. {@link refreshFoundation} also recomputes
   * every cached report once a minute, so a request only pays for the first computation of
   * a period, or one after a long quiet spell.
   *
   * `maxStaleMs` lets a long period skip recomputation for a while even when new blocks
   * arrive, as the leaderboards do: a 6-month picture does not change every 30 seconds.
   */
  foundationReport<T>(name: string, compute: () => T, maxStaleMs = 0): T {
    const key = this.foundationKey();
    const hit = this.foundationCache.get(name);
    const age = hit ? Date.now() - hit.at : Number.POSITIVE_INFINITY;

    if (hit && (hit.key === key || age < Math.max(maxStaleMs, FOUNDATION_STALE_MS))) {
      if (hit.key !== key && age >= maxStaleMs) setImmediate(() => void this.refreshFoundation());
      return hit.value as T;
    }

    const value = compute();
    this.foundationCache.set(name, { key, at: Date.now(), value, compute, maxStaleMs });
    return value;
  }

  /** Recompute every cached Foundation report whose data or labels changed. */
  async refreshFoundation(): Promise<void> {
    await this.guard('foundation', async () => {
      for (const [name, entry] of this.foundationCache) {
        const key = this.foundationKey();
        if (entry.key === key || Date.now() - entry.at < entry.maxStaleMs) continue;
        const value = await this.exclusive(entry.compute);
        this.foundationCache.set(name, { ...entry, key, at: Date.now(), value });
        // Let requests in between periods.
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
  }

  private foundationKey(): string {
    const { db, labels } = this.options;
    return `${dataVersion(db)}|${labels.stats().loadedAt}|${this.balances?.at ?? 0}`;
  }

  /** Collateral transactions of the live nodes, from the last node list. */
  collateralTxids(): ReadonlySet<string> {
    return this.nodeList?.collateralTxids ?? new Set();
  }

  /** The node list last fetched, for the precision report. */
  currentNodeList(): NodeList | null {
    return this.nodeList?.list ?? null;
  }

  /** Run every job once, now (`POST /api/admin/intel/run`). */
  async runAll(): Promise<IntelStatus> {
    await this.refreshNodes();
    await this.cluster();
    this.hopHeight = 0;
    await this.detectHops();
    await this.relabel(Number.POSITIVE_INFINITY);
    return this.status();
  }

  /** Drain the relabel queue in budgeted batches; `rounds` caps how many per call. */
  async relabel(rounds = 20): Promise<void> {
    await this.guard('relabel', async () => {
      for (let round = 0; round < rounds; round++) {
        if (this.relabeler.pending() === 0) return;
        await this.exclusive(() => this.relabeler.run());
        // Let requests in between batches.
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
  }

  async refreshNodes(): Promise<void> {
    await this.guard('nodes', async () => {
      const { config, db, labels, log } = this.options;

      const fetched = await fetchNodeList({
        ownNodeUrl: config.dataSources.fluxNodeUrl,
        explorerUrl: config.dataSources.fluxNodesApi,
        ...(this.options.http ? { http: this.options.http } : {})
      });
      if (fetched) this.nodeList = { ...fetched, at: Date.now() };
      else log.warn('node list unavailable; keeping the previous node-list labels');

      // Addresses already something else (exchange, Foundation) are not claimed by forwarding.
      const exclude = new Set(
        [...labels.entries()]
          .filter(([, label]) => label.kind !== 'node_operator')
          .map(([address]) => address)
      );

      const computed = await this.exclusive(() =>
        computeNodeOperatorLabels(db, this.nodeList?.list ?? null, exclude)
      );

      await this.exclusive(() => {
        if (computed.nodeList) replaceSourceLabels(db, 'node_list', computed.nodeList);
        replaceSourceLabels(db, 'node_rewards', computed.nodeRewards);
        replaceSourceLabels(db, 'forwarding', computed.forwarding);
      });
      const nodesChanged = labels.refresh('node operators refreshed');

      // After the node labels: an intermediary is recognised by paying node operators.
      const intermediaries = await this.exclusive(() => {
        const rows = detectIntermediaries(db, labels, this.collateralTxids());
        replaceSourceLabels(db, INTERMEDIARY_SOURCE, rows);
        return rows;
      });

      const changed = [...nodesChanged, ...labels.refresh('foundation intermediaries refreshed')];
      this.nodeCounts = {
        list: computed.nodeList?.length ?? this.nodeCounts?.list ?? 0,
        rewards: computed.nodeRewards.length,
        forwarding: computed.forwarding.length,
        protocolPayouts: computed.protocolPayouts.length,
        foundationIntermediaries: intermediaries.filter(
          (row) => row.confidence >= APPLY_MIN_CONFIDENCE
        ).length
      };

      log.info(
        {
          ...this.nodeCounts,
          changed: changed.length,
          nodeListSource: this.nodeList?.source ?? null
        },
        'node operator labels refreshed'
      );
    });
  }

  async cluster(): Promise<ClusterResult | null> {
    let result: ClusterResult | null = null;

    await this.guard('cluster', async () => {
      const { db, labels, log } = this.options;
      result = await this.exclusive(() => clusterAddresses(db, labels));

      // Deposit addresses by behaviour: strong ones applied, weaker ones for review.
      const labelled = new Map(
        [...labels.entries().keys()].map(
          (address) => [address, labels.labelOf(address)?.source ?? ''] as const
        )
      );
      const forwarders = await this.exclusive(() => detectDepositForwarders(db, labelled));
      await this.exclusive(() => replaceSourceLabels(db, 'forwarder', forwarders.labels));
      const changed = labels.refresh('deposit forwarders refreshed');

      const stored = await this.exclusive(() =>
        storeCandidates(db, [...result!.candidates, ...forwarders.candidates])
      );

      this.clustering = {
        at: Date.now(),
        clusters: result.clusters,
        clusteredAddresses: result.clusteredAddresses,
        largest: result.largest,
        candidates: result.candidates.length + forwarders.candidates.length,
        conflicts: result.conflicts.length,
        forwarders: forwarders.labels.length
      };

      log.info(
        {
          ...this.clustering,
          stored,
          labelsChanged: changed.length,
          skippedCoinjoins: result.skippedCoinjoins
        },
        'clustering done'
      );
      if (result.conflicts.length > 0) {
        log.warn(
          { conflicts: result.conflicts.slice(0, 5) },
          'clusters span several exchanges; no candidates proposed for them'
        );
      }
    });

    return result;
  }

  async detectHops(): Promise<void> {
    await this.guard('hops', async () => {
      const { db, config } = this.options;
      const tip =
        db.prepare<[], { h: number | null }>(`SELECT MAX(height) AS h FROM blocks`).get()?.h ?? 0;
      const since = Math.max(0, this.hopHeight - config.intel.hopMaxBlocks);

      await this.exclusive(() => detectHops(db, since, { maxBlocks: config.intel.hopMaxBlocks }));

      this.hopHeight = tip;
      this.hops = {
        at: Date.now(),
        total: db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM exchange_hops`).get()!.n
      };
    });
  }

  async refreshBalances(): Promise<void> {
    const url = this.options.config.dataSources.fluxNodeUrl;
    if (!url) return;

    await this.guard('balances', async () => {
      const addresses = this.options.labels.addressesOf('foundation');
      if (addresses.length === 0) return;
      const snapshot = await fetchBalances(url, addresses, this.options.http ?? {});
      if (snapshot) this.balances = snapshot;
    });
  }

  /** Inside the sync loop's exclusive section when there is one. */
  private exclusive<T>(work: () => T): Promise<T> {
    return this.options.sync ? this.options.sync.exclusive(work) : Promise.resolve().then(work);
  }

  /** One instance of each job at a time; failures are logged, never thrown. */
  private async guard(job: string, work: () => Promise<void>): Promise<void> {
    if (this.running.has(job)) return;
    this.running.add(job);

    try {
      await work();
    } catch (error) {
      this.lastError = `${job}: ${error instanceof Error ? error.message : String(error)}`;
      this.options.log.error({ job, ...serialiseError(error) }, 'intelligence job failed');
    } finally {
      this.running.delete(job);
    }
  }
}
