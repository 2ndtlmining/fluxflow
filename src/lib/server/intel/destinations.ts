/**
 * Where Foundation money goes next (#31).
 *
 * The Foundation pays contributors, funds nodes and moves money to exchanges, often through
 * one or two wallets in between. Its own report only sees the first recipient; this follows
 * each outflow forward, up to `maxHops` wallets deep, and says where the value ended up:
 *
 *   exchange    deposited to a labelled exchange (by name)
 *   nodes       paid to a node operator address, or as node collateral that a live node
 *               uses (its transaction is a collateral outpoint on the node list)
 *   returned    came back to a Foundation wallet
 *   held        still in a wallet: not passed on within `hopBlocks` of arriving
 *   untraced    still moving after `maxHops` wallets
 *
 * The rules, chosen so that nothing is counted twice and nothing is invented:
 *
 *  - **Amount-capped.** A wallet passes on at most what was traced into it. Its outgoing
 *    payments are consumed first-in, first-out from the moment the traced value arrived, and
 *    a payment used by one trace is not available to another.
 *  - **Proportional.** In a transaction with several funders, each recipient's value is split
 *    across the funders by what they put in (the same rule flow derivation uses), so a wallet
 *    is credited only with its own share.
 *  - **Time-bounded.** Value that sits longer than `hopBlocks` is `held` — the trace does not
 *    guess what a wallet did with savings weeks later.
 *  - **Collateral is verified, not guessed.** A round 1,000 FLUX payment is as likely a
 *    wage as a Cumulus collateral. A payment of exactly a collateral amount counts as nodes
 *    only when the node list names its transaction as a live node's collateral; otherwise it
 *    is reported as `unconfirmed` collateral-sized and its value is still followed.
 *  - **Label-independent walk.** The walk reads `tx_deltas`, not `flows`; labels only decide
 *    where it stops.
 */

import type { Db } from '../db/database.js';
import { SATS_PER_FLUX } from '../ingest/datasource/types.js';
import type { LabelLookup } from '../labels.js';
import { COLLATERAL_SAT } from './intermediaries.js';

export const DESTINATION_DEFAULTS = {
  maxHops: 3,
  /** ~7 days at 30-second blocks. */
  hopBlocks: 20_160,
  /** Recipients listed individually. */
  recipients: 15
} as const;

/** A Foundation-wide net below this is an internal move plus fee, not an outflow. */
const INTERNAL_TOLERANCE_SAT = 0.01 * SATS_PER_FLUX;

export interface DestinationTotals {
  readonly exchange: number;
  readonly byExchange: Record<string, number>;
  readonly nodes: number;
  readonly collateral: {
    readonly payments: number;
    readonly amount: number;
    /**
     * Exactly a collateral amount, but not a live node's collateral. Informational: the value
     * is still followed and counted where it ended, so this is not a share of the total.
     */
    readonly unconfirmedPayments: number;
    readonly unconfirmedAmount: number;
  };
  readonly returned: number;
  readonly held: number;
  readonly untraced: number;
}

export interface RecipientDestinations extends DestinationTotals {
  readonly address: string;
  readonly name: string | null;
  readonly kind: string;
  readonly subLabel: string | null;
  /** FLUX this recipient received from the Foundation in the window. */
  readonly received: number;
  /** The deepest hop at which any of its value ended: 1 is the recipient itself. */
  readonly hops: number;
}

export interface FoundationDestinations extends DestinationTotals {
  /** FLUX paid by Foundation wallets to anyone else in the window. */
  readonly traced: number;
  readonly maxHops: number;
  readonly hopBlocks: number;
  readonly recipients: RecipientDestinations[];
}

interface Delta {
  txid: string;
  address: string;
  height: number;
  time: number;
  net: number;
}

/** One outgoing payment of a wallet, with what is left of it for other traces. */
interface Spend {
  height: number;
  remaining: number;
  /** Where its value went: the wallet's share of each recipient. */
  to: { txid: string; address: string; net: number; time: number; sat: number }[];
  value: number;
}

class Tally {
  exchange = 0;
  byExchange = new Map<string, number>();
  nodes = 0;
  /** `txid:address`, so a payment split across several traces is one payment. */
  collateralPayments = new Set<string>();
  collateralAmount = 0;
  unconfirmedPayments = new Set<string>();
  unconfirmedAmount = 0;
  returned = 0;
  held = 0;
  untraced = 0;
  hops = 0;

  toJson(): DestinationTotals {
    // Proportional splits leave fractions of a satoshi; report whole satoshis.
    const flux = (sat: number) => Math.round(sat) / SATS_PER_FLUX;
    return {
      exchange: flux(this.exchange),
      byExchange: Object.fromEntries(
        [...this.byExchange].sort((a, b) => b[1] - a[1]).map(([name, sat]) => [name, flux(sat)])
      ),
      nodes: flux(this.nodes),
      collateral: {
        payments: this.collateralPayments.size,
        amount: flux(this.collateralAmount),
        unconfirmedPayments: this.unconfirmedPayments.size,
        unconfirmedAmount: flux(this.unconfirmedAmount)
      },
      returned: flux(this.returned),
      held: flux(this.held),
      untraced: flux(this.untraced)
    };
  }
}

export function traceFoundation(
  db: Db,
  labels: LabelLookup,
  window: { fromTime: number; toTime: number },
  options: {
    maxHops?: number;
    hopBlocks?: number;
    recipients?: number;
    /** Collateral transactions of live nodes (`parseCollateralTxids`). */
    collateralTxids?: ReadonlySet<string>;
  } = {}
): FoundationDestinations {
  const maxHops = options.maxHops ?? DESTINATION_DEFAULTS.maxHops;
  const hopBlocks = options.hopBlocks ?? DESTINATION_DEFAULTS.hopBlocks;
  const foundation = new Set(labels.addressesOf('foundation'));
  const collateralTxids = options.collateralTxids ?? new Set<string>();

  const byTx = db.prepare<[string], Delta>(
    `SELECT txid, address, height, time, sat_out - sat_in AS net FROM tx_deltas WHERE txid = ?`
  );
  const ofAddress = db.prepare<[string], Delta>(
    `SELECT txid, address, height, time, sat_out - sat_in AS net
     FROM tx_deltas WHERE address = ? ORDER BY height, txid`
  );

  /** Each recipient's share of `funder`'s contribution to a transaction. */
  const split = (rows: Delta[], funder: (row: Delta) => boolean) => {
    const funded = rows.reduce((sum, row) => sum + Math.max(0, -row.net), 0);
    const own = rows.filter((row) => row.net < 0 && funder(row)).reduce((s, r) => s - r.net, 0);
    if (funded <= 0 || own <= 0) return [];
    return rows
      .filter((row) => row.net > 0 && !funder(row))
      .map((row) => ({
        txid: row.txid,
        address: row.address,
        net: (row.net * own) / funded,
        time: row.time,
        sat: row.net
      }));
  };

  const spends = new Map<string, Spend[]>();
  const spendsOf = (address: string): Spend[] => {
    let list = spends.get(address);
    if (list) return list;
    list = [];
    for (const own of ofAddress.all(address)) {
      if (own.net >= 0) continue;
      const to = split(byTx.all(own.txid), (row) => row.address === address);
      const value = to.reduce((sum, part) => sum + part.net, 0);
      if (value > 0) list.push({ height: own.height, remaining: value, to, value });
    }
    spends.set(address, list);
    return list;
  };

  // Seeds: every Foundation outflow in the window, per recipient.
  const outflowTxs = db.transaction(() => {
    db.prepare(`CREATE TEMP TABLE IF NOT EXISTS trace_foundation (address TEXT PRIMARY KEY)`).run();
    db.prepare(`DELETE FROM trace_foundation`).run();
    const insert = db.prepare(`INSERT OR IGNORE INTO trace_foundation (address) VALUES (?)`);
    for (const address of foundation) insert.run(address);
    return db
      .prepare<[number, number], { txid: string; net: number }>(
        `SELECT d.txid, SUM(d.sat_out - d.sat_in) AS net
         FROM tx_deltas d JOIN trace_foundation f ON f.address = d.address
         WHERE d.time BETWEEN ? AND ?
         GROUP BY d.txid`
      )
      .all(window.fromTime, window.toTime);
  })();

  interface Item {
    txid: string;
    address: string;
    amount: number;
    height: number;
    time: number;
    sat: number;
    depth: number;
    root: string;
  }
  const queue: Item[] = [];
  const received = new Map<string, number>();

  for (const tx of outflowTxs) {
    if (tx.net >= -INTERNAL_TOLERANCE_SAT) continue;
    const rows = byTx.all(tx.txid);
    for (const part of split(rows, (row) => foundation.has(row.address))) {
      const height = rows[0]!.height;
      queue.push({ ...part, amount: part.net, height, depth: 1, root: part.address });
      received.set(part.address, (received.get(part.address) ?? 0) + part.net);
    }
  }

  const total = new Tally();
  const perRoot = new Map<string, Tally>();
  const tallyOf = (root: string) => {
    let tally = perRoot.get(root);
    if (!tally) {
      tally = new Tally();
      perRoot.set(root, tally);
    }
    return tally;
  };
  const add = (item: Item, apply: (tally: Tally) => void) => {
    apply(total);
    const tally = tallyOf(item.root);
    apply(tally);
    tally.hops = Math.max(tally.hops, item.depth);
  };

  // Earliest first, so first-in, first-out holds across traces sharing a wallet.
  queue.sort((a, b) => a.height - b.height);
  while (queue.length > 0) {
    const item = queue.shift()!;
    const label = labels.labelOf(item.address, item.time);

    if (label?.kind === 'exchange') {
      const name = label.name ?? 'Exchange';
      add(item, (t) => {
        t.exchange += item.amount;
        t.byExchange.set(name, (t.byExchange.get(name) ?? 0) + item.amount);
      });
      continue;
    }
    if (label?.kind === 'foundation' || foundation.has(item.address)) {
      add(item, (t) => (t.returned += item.amount));
      continue;
    }
    const collateralSized = COLLATERAL_SAT.has(item.sat);
    const collateral = collateralSized && collateralTxids.has(item.txid);
    if (label?.kind === 'node_operator' || collateral) {
      add(item, (t) => {
        t.nodes += item.amount;
        if (collateral) {
          t.collateralPayments.add(`${item.txid}:${item.address}`);
          t.collateralAmount += item.amount;
        }
      });
      continue;
    }
    if (collateralSized) {
      add(item, (t) => {
        t.unconfirmedPayments.add(`${item.txid}:${item.address}`);
        t.unconfirmedAmount += item.amount;
      });
    }
    if (item.depth > maxHops) {
      add(item, (t) => (t.untraced += item.amount));
      continue;
    }

    // Pass the value on through this wallet's later payments.
    let left = item.amount;
    const next: Item[] = [];
    for (const spend of spendsOf(item.address)) {
      if (left <= 0) break;
      if (spend.height < item.height || spend.remaining <= 0) continue;
      if (spend.height > item.height + hopBlocks) break;

      const used = Math.min(left, spend.remaining);
      spend.remaining -= used;
      left -= used;
      for (const part of spend.to) {
        const amount = (used * part.net) / spend.value;
        if (amount <= 0) continue;
        next.push({
          txid: part.txid,
          address: part.address,
          amount,
          height: spend.height,
          time: part.time,
          sat: part.sat,
          depth: item.depth + 1,
          root: item.root
        });
      }
    }
    if (left > 0) add(item, (t) => (t.held += left));

    for (const child of next) {
      // Keep the queue in height order; children are never earlier than their parent.
      let index = queue.length;
      while (index > 0 && queue[index - 1]!.height > child.height) index--;
      queue.splice(index, 0, child);
    }
  }

  const recipients = [...received]
    .sort((a, b) => b[1] - a[1])
    .slice(0, options.recipients ?? DESTINATION_DEFAULTS.recipients)
    .map(([address, sat]): RecipientDestinations => {
      const label = labels.labelOf(address);
      const tally = perRoot.get(address) ?? new Tally();
      return {
        address,
        name: label?.name ?? null,
        kind: label?.kind ?? 'unknown',
        subLabel: label?.subLabel ?? null,
        received: sat / SATS_PER_FLUX,
        hops: tally.hops,
        ...tally.toJson()
      };
    });

  return {
    traced: [...received.values()].reduce((sum, sat) => sum + sat, 0) / SATS_PER_FLUX,
    maxHops,
    hopBlocks,
    ...total.toJson(),
    recipients
  };
}
