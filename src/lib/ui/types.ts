/** Row shapes shared by UI components. */

export interface DivergingRow {
  readonly key: string;
  readonly label: string;
  /** FLUX deposited to exchanges. */
  readonly sell: number;
  /** FLUX withdrawn from exchanges. */
  readonly buy: number;
}
