import { describe, expect, it } from 'vitest';
import { csvField, eventsToCsv } from './csv';
import { formatFlux, formatSigned, kindLabel, flowLabel, shortAddress, timeAgo } from './format';
import type { FlowEvent } from './types';
import { EMPTY_FILTERS, eventsPath, hasFilters, readState, writeState } from './urlState';
import { readWatchlist, toggleWatch } from './watchlist';

describe('formatFlux', () => {
  it('keeps small amounts exact and compacts large ones', () => {
    expect(formatFlux(0.02)).toBe('0.02');
    expect(formatFlux(0.00004)).toBe('<0.01');
    expect(formatFlux(0)).toBe('0');
    expect(formatFlux(912.456)).toBe('912.46');
    expect(formatFlux(4_321.9)).toBe('4,322');
    expect(formatFlux(48_700)).toBe('48.7K');
    expect(formatFlux(1_250_000)).toBe('1.3M');
  });

  it('signs with a true minus sign', () => {
    expect(formatSigned(-69_885)).toBe('−69.9K');
    expect(formatSigned(1_200)).toBe('+1,200');
    expect(formatSigned(0)).toBe('0');
  });
});

describe('labels', () => {
  it('names kinds and flows in plain words', () => {
    expect(kindLabel('node_operator')).toBe('Node operator');
    expect(kindLabel('unknown')).toBe('Unlabelled wallet');
    expect(flowLabel('selling')).toBe('Deposited to exchange');
    expect(flowLabel('buying')).toBe('Withdrawn from exchange');
  });

  it('shortens an address to both recognisable ends', () => {
    expect(shortAddress('t1Tohzrk8nLjkEkD5YdtcTs1DHRXcsocehj')).toBe('t1Tohz…ocehj');
    expect(shortAddress('t1short')).toBe('t1short');
  });

  it('describes time relative to now', () => {
    const now = 1_000_000_000_000;
    expect(timeAgo(now / 1000 - 30, now)).toBe('30s ago');
    expect(timeAgo(now / 1000 - 600, now)).toBe('10m ago');
    expect(timeAgo(now / 1000 - 5 * 3600, now)).toBe('5h ago');
    expect(timeAgo(now / 1000 - 3 * 86_400, now)).toBe('3d ago');
    // A block timestamp slightly ahead of the browser clock is "now", not negative.
    expect(timeAgo(now / 1000 + 20, now)).toBe('0s ago');
  });
});

describe('URL state (#26, #27)', () => {
  it('round-trips the period and every filter', () => {
    const state = {
      period: '30D' as const,
      filters: {
        type: 'selling' as const,
        kind: 'node_operator' as const,
        exchange: 'Kucoin',
        min: 500
      }
    };
    expect(readState(new URLSearchParams(writeState(state)))).toEqual(state);
  });

  it('keeps defaults out of the URL', () => {
    expect(writeState({ period: '24H', filters: EMPTY_FILTERS })).toBe('');
  });

  it('opens a malformed link on safe defaults instead of failing', () => {
    const state = readState(new URLSearchParams('period=1Y&type=hack&kind=x&min=-5'));
    expect(state).toEqual({ period: '24H', filters: EMPTY_FILTERS });
    expect(readState(new URLSearchParams('period=7d')).period).toBe('7D');
  });

  it('builds the events path the API expects', () => {
    expect(
      eventsPath(
        '7D',
        { type: 'buying', kind: '', exchange: 'GateIO', min: 100 },
        {
          cursor: '3004268:abc:0',
          limit: 50
        }
      )
    ).toBe(
      '/flow/7D/events?type=buying&exchange=GateIO&minAmount=100&limit=50&cursor=3004268%3Aabc%3A0'
    );
    expect(hasFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasFilters({ ...EMPTY_FILTERS, min: 1 })).toBe(true);
  });
});

describe('CSV export (#27)', () => {
  const event: FlowEvent = {
    txid: 'd149',
    vout: 0,
    height: 3_004_271,
    time: 1_791_018_394,
    fromAddress: 't1from',
    fromKind: 'unknown',
    toAddress: 't1to',
    toKind: 'exchange',
    exchange: 'Kucoin',
    flowType: 'selling',
    amount: 607.99890265
  };

  it('writes a header and one line per event, with satoshi precision', () => {
    const csv = eventsToCsv([event]);
    const [header, row] = csv.trim().split('\r\n');
    expect(header).toBe(
      'time_utc,height,txid,vout,flow_type,from_address,from_kind,to_address,to_kind,exchange,amount_flux'
    );
    expect(row).toBe(
      '2026-10-03T09:06:34.000Z,3004271,d149,0,selling,t1from,unknown,t1to,exchange,Kucoin,607.99890265'
    );
  });

  it('quotes fields that need it and defuses spreadsheet formulas', () => {
    expect(csvField('Gate, Inc')).toBe('"Gate, Inc"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField(null)).toBe('');
    expect(csvField(-5)).toBe('-5');
  });
});

describe('watchlist (#30)', () => {
  function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
    const data = new Map<string, string>();
    return {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value)
    };
  }

  it('toggles an address in and out', () => {
    const storage = memoryStorage();
    expect(toggleWatch('t1a', storage)).toBe(true);
    expect(toggleWatch('t1b', storage)).toBe(true);
    expect(readWatchlist(storage)).toEqual(['t1b', 't1a']);
    expect(toggleWatch('t1a', storage)).toBe(false);
    expect(readWatchlist(storage)).toEqual(['t1b']);
  });

  it('treats corrupt or missing storage as an empty list', () => {
    expect(readWatchlist({ getItem: () => '{not json' })).toEqual([]);
    expect(readWatchlist({ getItem: () => '{"a":1}' })).toEqual([]);
    expect(readWatchlist(null)).toEqual([]);
  });
});
