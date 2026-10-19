/**
 * Entities (#65): one named owner behind many addresses, with combined totals.
 *
 * Two kinds:
 *
 *  - **Label entities**, derived: every applied label with a name groups its addresses — all
 *    "Kucoin" exchange addresses are the Kucoin entity, all Foundation addresses are the
 *    Foundation. Nothing is stored; they follow the labels.
 *  - **Named entities**, stored (`entities`, `entity_members`): what a person names on the
 *    review page — an unlabelled co-spend cluster, or addresses merged by hand. A `cluster`
 *    member stands for its address's whole current cluster, so the entity follows the
 *    cluster as clustering finds more of it.
 *
 * An address belongs to at most one entity. A named entity wins over a label entity (it is
 * a person's decision about that exact address), and the oldest named entity wins over a
 * newer one. Entities are display and grouping only: they never change a flow's kind or
 * any exchange total — that is what labels are for.
 */

import type { Db } from '../db/database.js';
import type { AddressKind } from '../ingest/datasource/types.js';
import { SATS_PER_FLUX } from '../ingest/datasource/types.js';
import type { LabelLookup } from '../labels.js';
import { addressSetReport, type FoundationReport } from './foundation.js';

export type MemberSource = 'label' | 'manual' | 'cluster';

export interface EntityRef {
  readonly id: string;
  readonly name: string;
  readonly kind: AddressKind;
  /** Derived from labels, or named on the review page. */
  readonly source: 'label' | 'stored';
  readonly members: number;
}

export interface EntityMember {
  readonly address: string;
  readonly source: MemberSource;
}

const LABELLED_KINDS: readonly AddressKind[] = [
  'foundation',
  'exchange',
  'app_hosting',
  'node_operator'
];

/** The Foundation is one entity whatever its wallets are called. */
export function labelEntityId(kind: AddressKind, name: string): string {
  return kind === 'foundation' ? 'foundation' : `${kind}:${name}`;
}

/** Every entity and who belongs to it, as of now. Cheap enough to build per request. */
export class EntityIndex {
  private readonly refs = new Map<string, EntityRef>();
  private readonly memberLists = new Map<string, EntityMember[]>();
  private readonly owner = new Map<string, string>();

  static build(db: Db, labels: LabelLookup): EntityIndex {
    const index = new EntityIndex();
    const pending = new Map<
      string,
      { name: string; kind: AddressKind; source: 'label' | 'stored' }
    >();

    // Named entities first: they win an address over a label entity.
    const stored = db
      .prepare<
        [],
        {
          id: string;
          name: string;
          kind: AddressKind;
          address: string | null;
          source: string | null;
        }
      >(
        `SELECT e.id, e.name, e.kind, m.address, m.source
         FROM entities e LEFT JOIN entity_members m ON m.entity_id = e.id
         ORDER BY e.created_at, e.id, m.added_at, m.address`
      )
      .all();
    const clusterOf = db.prepare<[string], { address: string }>(
      `SELECT address FROM address_clusters
       WHERE cluster_id = (SELECT cluster_id FROM address_clusters WHERE address = ?)
       ORDER BY address`
    );
    for (const row of stored) {
      pending.set(row.id, { name: row.name, kind: row.kind, source: 'stored' });
      if (!row.address) {
        index.memberLists.set(row.id, index.memberLists.get(row.id) ?? []);
        continue;
      }
      const source = row.source === 'cluster' ? 'cluster' : 'manual';
      const addresses =
        source === 'cluster' ? clusterOf.all(row.address).map((r) => r.address) : [row.address];
      if (addresses.length === 0) addresses.push(row.address);
      for (const address of addresses) index.claim(row.id, address, source);
    }

    for (const kind of LABELLED_KINDS) {
      for (const address of labels.addressesOf(kind)) {
        const name = kind === 'foundation' ? 'Flux Foundation' : labels.nameOf(address);
        if (!name) continue;
        const id = labelEntityId(kind, name);
        if (!pending.has(id)) pending.set(id, { name, kind, source: 'label' });
        index.claim(id, address, 'label');
      }
    }

    for (const [id, entity] of pending) {
      index.refs.set(id, { id, ...entity, members: index.memberLists.get(id)?.length ?? 0 });
    }
    return index;
  }

  private claim(id: string, address: string, source: MemberSource): void {
    if (this.owner.has(address)) return;
    this.owner.set(address, id);
    const list = this.memberLists.get(id) ?? [];
    list.push({ address, source });
    this.memberLists.set(id, list);
  }

  get(id: string): EntityRef | null {
    return this.refs.get(id) ?? null;
  }

  entityOf(address: string): EntityRef | null {
    const id = this.owner.get(address);
    return id ? (this.refs.get(id) ?? null) : null;
  }

  members(id: string): EntityMember[] {
    return this.memberLists.get(id) ?? [];
  }

  /** Largest first. */
  list(): EntityRef[] {
    return [...this.refs.values()].sort(
      (a, b) => b.members - a.members || a.name.localeCompare(b.name)
    );
  }
}

/**
 * `labels`, except that an unlabelled address in a named entity is called by the entity's
 * name. For API answers only: flow derivation keeps reading the labels themselves.
 */
export function withEntityNames(labels: LabelLookup, index: EntityIndex): LabelLookup {
  return {
    ...labels,
    nameOf: (address, time) => {
      const named = labels.nameOf(address, time);
      if (named) return named;
      const entity = index.entityOf(address);
      return entity?.source === 'stored' ? entity.name : null;
    }
  };
}

export interface EntityParty {
  /** The counterparty entity, when it is one; otherwise a single wallet. */
  readonly entity: { id: string; members: number } | null;
  /** The wallet, or the entity's largest counterparty address in this period. */
  readonly address: string;
  readonly name: string | null;
  readonly kind: AddressKind;
  readonly total: number;
  readonly count: number;
  readonly share: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
}

export interface EntityReport {
  readonly entity: EntityRef;
  readonly totals: FoundationReport['totals'];
  readonly series: FoundationReport['series'];
  readonly recent: FoundationReport['recent'];
  /** The most active members in the period (at most {@link ENTITY_LIMITS.wallets}). */
  readonly wallets: (FoundationReport['wallets'][number] & { source: MemberSource })[];
  readonly memberSources: Record<MemberSource, number>;
  readonly incoming: { total: number; parties: EntityParty[] };
  readonly outgoing: { total: number; parties: EntityParty[] };
  /** Paid by members to `app_hosting` addresses. */
  readonly appPayments: { total: number; count: number };
}

export const ENTITY_LIMITS = {
  wallets: 100,
  parties: 15
} as const;

/** An entity's combined report over a window; `null` for an unknown id. */
export function entityReport(
  db: Db,
  labels: LabelLookup,
  index: EntityIndex,
  id: string,
  window: { fromTime: number; toTime: number; fromHeight: number; toHeight: number }
): EntityReport | null {
  const entity = index.get(id);
  if (!entity) return null;
  const members = index.members(id);
  const addresses = members.map((member) => member.address);
  const sourceOf = new Map(members.map((member) => [member.address, member.source]));

  const report = addressSetReport(db, labels, addresses, window);

  return db.transaction(() => {
    db.prepare(`CREATE TEMP TABLE IF NOT EXISTS entity_set (address TEXT PRIMARY KEY)`).run();
    db.prepare(`DELETE FROM entity_set`).run();
    const insert = db.prepare(`INSERT OR IGNORE INTO entity_set (address) VALUES (?)`);
    for (const address of addresses) insert.run(address);

    const side = (inward: boolean) => {
      const [self, other] = inward
        ? ['to_address', 'from_address']
        : ['from_address', 'to_address'];
      const rows = db
        .prepare<
          [number, number],
          { address: string; sat: number; count: number; first: number; last: number }
        >(
          `SELECT f.${other} AS address, SUM(f.sat) AS sat, COUNT(*) AS count,
                  MIN(f.time) AS first, MAX(f.time) AS last
           FROM flows f JOIN entity_set s ON s.address = f.${self}
           WHERE f.height BETWEEN ? AND ?
             AND f.${other} NOT IN (SELECT address FROM entity_set)
           GROUP BY f.${other}`
        )
        .all(window.fromHeight, window.toHeight);
      return aggregateParties(rows, labels, index);
    };

    const hosting = labels.addressesOf('app_hosting');
    const apps =
      hosting.length === 0
        ? null
        : db
            .prepare<(string | number)[], { sat: number | null; count: number }>(
              `SELECT SUM(f.sat) AS sat, COUNT(*) AS count
               FROM flows f JOIN entity_set s ON s.address = f.from_address
               WHERE f.height BETWEEN ? AND ?
                 AND f.to_address IN (${hosting.map(() => '?').join(', ')})`
            )
            .get(window.fromHeight, window.toHeight, ...hosting);

    const memberSources: Record<MemberSource, number> = { label: 0, manual: 0, cluster: 0 };
    for (const member of members) memberSources[member.source]++;

    return {
      entity,
      totals: report.totals,
      series: report.series,
      recent: report.recent,
      wallets: report.wallets
        .slice()
        .sort(
          (a, b) =>
            b.inflow + b.outflow - (a.inflow + a.outflow) || a.address.localeCompare(b.address)
        )
        .slice(0, ENTITY_LIMITS.wallets)
        .map((wallet) => ({ ...wallet, source: sourceOf.get(wallet.address) ?? 'manual' })),
      memberSources,
      incoming: side(true),
      outgoing: side(false),
      appPayments: { total: (apps?.sat ?? 0) / SATS_PER_FLUX, count: apps?.count ?? 0 }
    };
  })();
}

/** Counterparty addresses grouped into entities where they belong to one, largest first. */
function aggregateParties(
  rows: { address: string; sat: number; count: number; first: number; last: number }[],
  labels: LabelLookup,
  index: EntityIndex
): { total: number; parties: EntityParty[] } {
  const groups = new Map<
    string,
    {
      entity: EntityRef | null;
      address: string;
      top: number;
      sat: number;
      count: number;
      first: number;
      last: number;
    }
  >();
  let total = 0;
  for (const row of rows) {
    total += row.sat;
    const entity = index.entityOf(row.address);
    const key = entity ? `entity:${entity.id}` : row.address;
    const group = groups.get(key) ?? {
      entity,
      address: row.address,
      top: 0,
      sat: 0,
      count: 0,
      first: row.first,
      last: row.last
    };
    if (row.sat > group.top) {
      group.top = row.sat;
      group.address = row.address;
    }
    group.sat += row.sat;
    group.count += row.count;
    group.first = Math.min(group.first, row.first);
    group.last = Math.max(group.last, row.last);
    groups.set(key, group);
  }

  const parties = [...groups.values()]
    .sort((a, b) => b.sat - a.sat || a.address.localeCompare(b.address))
    .slice(0, ENTITY_LIMITS.parties)
    .map((group): EntityParty => ({
      entity: group.entity ? { id: group.entity.id, members: group.entity.members } : null,
      address: group.address,
      name: group.entity?.name ?? labels.nameOf(group.address),
      kind: group.entity?.kind ?? labels.kindOf(group.address),
      total: group.sat / SATS_PER_FLUX,
      count: group.count,
      share: total > 0 ? group.sat / total : 0,
      firstSeen: group.first,
      lastSeen: group.last
    }));
  return { total: total / SATS_PER_FLUX, parties };
}

// ── Writes (admin) ──────────────────────────────────────────────────────────

const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'entity';

/** Create a named entity; returns its id (`e-<slug>`, made unique). */
export function createEntity(
  db: Db,
  input: { name: string; kind: AddressKind; note?: string | null }
): string {
  const base = `e-${slug(input.name)}`;
  const taken = db.prepare<[string], { n: number }>(
    `SELECT COUNT(*) AS n FROM entities WHERE id = ?`
  );
  let id = base;
  for (let n = 2; taken.get(id)!.n > 0; n++) id = `${base}-${n}`;
  db.prepare(`INSERT INTO entities (id, name, kind, note) VALUES (?, ?, ?, ?)`).run(
    id,
    input.name,
    input.kind,
    input.note ?? null
  );
  return id;
}

/** Add addresses (or whole clusters) to a named entity. Returns how many rows were added. */
export function addMembers(
  db: Db,
  id: string,
  members: readonly { address: string; source: 'manual' | 'cluster' }[]
): number {
  const insert = db.prepare(
    `INSERT INTO entity_members (entity_id, address, source) VALUES (?, ?, ?)
     ON CONFLICT (entity_id, address) DO UPDATE SET source = excluded.source`
  );
  return db.transaction(() =>
    members.reduce(
      (added, member) => added + insert.run(id, member.address, member.source).changes,
      0
    )
  )();
}

export function isStoredEntity(db: Db, id: string): boolean {
  return (
    db.prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM entities WHERE id = ?`).get(id)!
      .n > 0
  );
}

export interface ClusterSummary {
  /** Any member: clusters are anchored on an address, since their ids change. */
  readonly anchor: string;
  readonly size: number;
  readonly sample: string[];
  /** Entities its members already belong to, with how many members each. */
  readonly entities: { id: string; name: string; kind: AddressKind; members: number }[];
  /** Members not in any entity. */
  readonly unassigned: number;
  /** FLUX its members received and sent in the stored window (wallet to wallet included). */
  readonly received: number;
  readonly sent: number;
}

/** The largest co-spend clusters, with what is already known about them. */
export function listClusters(
  db: Db,
  index: EntityIndex,
  options: { limit?: number; unnamedOnly?: boolean } = {}
): ClusterSummary[] {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 25) || 1), 100);
  const clusters = db
    .prepare<[], { clusterId: string; size: number }>(
      `SELECT cluster_id AS clusterId, MAX(size) AS size FROM address_clusters
       GROUP BY cluster_id ORDER BY size DESC, cluster_id`
    )
    .all();
  const membersOf = db.prepare<[string], { address: string }>(
    `SELECT address FROM address_clusters WHERE cluster_id = ? ORDER BY address`
  );
  const moved = db.prepare<[string, string], { received: number | null; sent: number | null }>(
    `SELECT (SELECT SUM(sat) FROM flows WHERE to_address = ?) AS received,
            (SELECT SUM(sat) FROM flows WHERE from_address = ?) AS sent`
  );

  const out: ClusterSummary[] = [];
  for (const cluster of clusters) {
    if (out.length >= limit) break;
    const addresses = membersOf.all(cluster.clusterId).map((row) => row.address);
    const owners = new Map<string, { ref: EntityRef; count: number }>();
    let unassigned = 0;
    for (const address of addresses) {
      const ref = index.entityOf(address);
      if (!ref) {
        unassigned++;
        continue;
      }
      const seen = owners.get(ref.id) ?? { ref, count: 0 };
      seen.count++;
      owners.set(ref.id, seen);
    }
    if (options.unnamedOnly && unassigned === 0) continue;

    let received = 0;
    let sent = 0;
    for (const address of addresses) {
      const row = moved.get(address, address);
      received += row?.received ?? 0;
      sent += row?.sent ?? 0;
    }
    out.push({
      anchor: addresses[0]!,
      size: cluster.size,
      sample: addresses.slice(0, 5),
      entities: [...owners.values()]
        .sort((a, b) => b.count - a.count)
        .map(({ ref, count }) => ({ id: ref.id, name: ref.name, kind: ref.kind, members: count })),
      unassigned,
      received: received / SATS_PER_FLUX,
      sent: sent / SATS_PER_FLUX
    });
  }
  return out;
}
