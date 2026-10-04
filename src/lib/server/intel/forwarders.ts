/**
 * Exchange deposit addresses, found by what they do with the money (#20).
 *
 * An exchange gives every customer a deposit address and later sweeps it into a hot wallet.
 * Until the deposit address is known, the customer's deposit looks like a transfer between
 * strangers and the sweep looks like a *sale by the deposit address*, hours later: on seven
 * days of live data, nine such addresses accounted for 52% of all recorded selling, and the
 * node operators behind them showed no selling at all.
 *
 * Sweep detection (`clusters.ts`) only sees sweeps with two or more inputs. Kucoin sweeps one
 * address at a time, so its deposit addresses never showed up. This finds them by behaviour:
 *
 *  - every outflow goes to addresses of **one** exchange;
 *  - it passes on (almost) everything it receives;
 *  - it never received from an exchange. A wallet that withdraws from one exchange and
 *    deposits into another is a person moving money (an exchange hop), not a deposit address.
 *
 * Detection reads the recipient's label, not the flow type: once an address is labelled as
 * the exchange, its sweeps stop being "selling", and reading the flow type would make the
 * label switch itself off on the next pass.
 *
 * With {@link FORWARDER.autoOutflows} or more such outflows the address is labelled at once
 * (source `forwarder`, "likely"), so deposits into it count as sales when they happen and by
 * whoever made them. Fewer, and it is proposed as a candidate for review instead.
 */

import type { Db } from '../db/database.js';
import { CONFIDENCE, type LabelInput } from '../labels.js';
import type { Candidate } from './clusters.js';

export const FORWARDER = {
  /** Outflows, all to one exchange, before the address is labelled without review. */
  autoOutflows: 5,
  /** Fewer than `autoOutflows` but at least this many: proposed for review. */
  candidateOutflows: 2,
  /** It must pass on at least this share of what it received inside the window. */
  minPassThrough: 0.9,
  confidence: CONFIDENCE.likely,
  candidateConfidence: 0.5
} as const;

/** The label sources a forwarder may already carry and still be (re)detected. */
const REDETECTABLE = new Set(['forwarder', 'forwarding']);

export interface ForwarderResult {
  /** Strong: applied as `forwarder` labels. */
  readonly labels: LabelInput[];
  /** Weaker: proposed for review. */
  readonly candidates: Candidate[];
}

interface Row {
  address: string;
  exchange: string;
  outflows: number;
  outSat: number;
  inSat: number;
  senders: number;
  fromExchanges: number;
  firstOut: number;
  lastOut: number;
}

/**
 * Find deposit forwarders among the stored flows.
 *
 * @param labelled addresses with an applied label from any source other than
 *   `forwarder`/`forwarding` (exchanges, the Foundation, node operators): never claimed.
 */
export function detectDepositForwarders(
  db: Db,
  labelled: ReadonlyMap<string, string>
): ForwarderResult {
  const rows = db
    .prepare<[number], Row>(
      `WITH outs AS (
         SELECT from_address AS address,
                COUNT(*) AS outflows,
                SUM(sat) AS outSat,
                SUM(to_kind = 'exchange') AS toExchange,
                COUNT(DISTINCT CASE WHEN to_kind = 'exchange' THEN exchange END) AS exchanges,
                MAX(CASE WHEN to_kind = 'exchange' THEN exchange END) AS exchange,
                MIN(time) AS firstOut, MAX(time) AS lastOut
         FROM flows
         GROUP BY from_address
         HAVING outflows >= ? AND toExchange = outflows AND exchanges = 1
       )
       SELECT o.address, o.exchange, o.outflows, o.outSat, o.firstOut, o.lastOut,
              COALESCE(i.inSat, 0) AS inSat, COALESCE(i.senders, 0) AS senders,
              COALESCE(i.fromExchanges, 0) AS fromExchanges
       FROM outs o
       LEFT JOIN (
         SELECT to_address, SUM(sat) AS inSat, COUNT(DISTINCT from_address) AS senders,
                SUM(from_kind = 'exchange') AS fromExchanges
         FROM flows
         WHERE to_address IN (SELECT address FROM outs)
         GROUP BY to_address
       ) i ON i.to_address = o.address`
    )
    .all(FORWARDER.candidateOutflows);

  const labels: LabelInput[] = [];
  const candidates: Candidate[] = [];

  for (const row of rows) {
    const source = labelled.get(row.address);
    if (source !== undefined && !REDETECTABLE.has(source)) continue;
    if (row.fromExchanges > 0) continue;
    // Received before the window and swept inside it: out > in is fine; holding is not.
    if (row.inSat > 0 && row.outSat < row.inSat * FORWARDER.minPassThrough) continue;

    const evidence = {
      method: 'deposit_forwarder',
      exchange: row.exchange,
      outflows: row.outflows,
      fluxOut: row.outSat / 1e8,
      fluxIn: row.inSat / 1e8,
      senders: row.senders,
      firstOut: row.firstOut,
      lastOut: row.lastOut
    };

    if (row.outflows >= FORWARDER.autoOutflows) {
      labels.push({
        address: row.address,
        kind: 'exchange',
        name: row.exchange,
        confidence: FORWARDER.confidence,
        evidence
      });
    } else {
      candidates.push({
        address: row.address,
        kind: 'exchange',
        name: row.exchange,
        method: 'forwarder',
        confidence: FORWARDER.candidateConfidence,
        evidence
      });
    }
  }

  return { labels, candidates };
}
