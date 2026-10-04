/** CSV export of flow events (#27). */

import type { FlowEvent } from './types';

const COLUMNS = [
  'time_utc',
  'height',
  'txid',
  'vout',
  'flow_type',
  'from_address',
  'from_kind',
  'to_address',
  'to_kind',
  'exchange',
  'amount_flux'
] as const;

/**
 * Quote a field when it needs it (RFC 4180), and neutralise a leading `=`, `+`, `-` or `@`
 * so a spreadsheet never evaluates a cell as a formula. Addresses and txids never start with
 * those, but labels and exchange names come from editable config.
 */
export function csvField(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function eventsToCsv(events: readonly FlowEvent[]): string {
  const rows = events.map((event) =>
    [
      new Date(event.time * 1000).toISOString(),
      event.height,
      event.txid,
      event.vout,
      event.flowType,
      event.fromAddress,
      event.fromKind,
      event.toAddress,
      event.toKind,
      event.exchange,
      // Satoshi precision: the API's amount is FLUX with up to 8 decimals.
      Number(event.amount.toFixed(8))
    ]
      .map(csvField)
      .join(',')
  );

  return [COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}

/** Offer a CSV string to the browser as a download. */
export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
