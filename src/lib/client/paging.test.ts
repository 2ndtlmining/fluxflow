import { describe, expect, it } from 'vitest';
import { boardPath, isAddress, isTxid, normaliseBoard } from './endpoints';
import { evidenceText, sourceText } from './format';
import { compareEvents, MergedPager, type PageFetcher } from './pager';
import type { FlowEvent, FlowType } from './types';
import {
  EMPTY_FILTERS,
  directionsFor,
  eventsPath,
  hasFilters,
  readState,
  writeState
} from './urlState';

describe('URL state (#26, #27, #28)', () => {
  const DEFAULTS = {
    period: '24H' as const,
    who: '' as const,
    sure: '' as const,
    noHops: false,
    filters: EMPTY_FILTERS
  };

  it('round-trips the period, the leaderboard filter and every transaction filter', () => {
    const state = {
      period: '30D' as const,
      who: 'node_operator' as const,
      sure: 'likely' as const,
      noHops: true,
      filters: {
        type: 'selling' as const,
        kind: 'node_operator' as const,
        exchange: 'Kucoin',
        min: 500
      }
    };
    expect(readState(new URLSearchParams(writeState(state)))).toEqual(state);
  });

  it('keeps defaults out of the URL, with exchange flows as the default view', () => {
    expect(writeState(DEFAULTS)).toBe('');
    expect(readState(new URLSearchParams('')).filters.type).toBe('exchange');
    expect(writeState({ ...DEFAULTS, filters: { ...EMPTY_FILTERS, type: 'all' } })).toBe(
      'type=all'
    );
  });

  it('opens a malformed link on safe defaults instead of failing', () => {
    const state = readState(new URLSearchParams('period=1Y&type=hack&kind=x&who=exchange&min=-5'));
    expect(state).toEqual(DEFAULTS);
    expect(readState(new URLSearchParams('period=7d')).period).toBe('7D');
  });

  it('keeps the hops toggle and a confidence filter, but only for a labelled kind', () => {
    const parsed = readState(
      new URLSearchParams('who=node_operator&minConfidence=confirmed&hops=exclude')
    );
    expect(parsed).toMatchObject({ who: 'node_operator', sure: 'confirmed', noHops: true });
    expect(writeState(parsed)).toBe('who=node_operator&minConfidence=confirmed&hops=exclude');

    // A confidence filter on unlabelled wallets would always be empty, so it is dropped.
    expect(readState(new URLSearchParams('who=unknown&minConfidence=likely')).sure).toBe('');
    expect(readState(new URLSearchParams('minConfidence=likely')).sure).toBe('');
    expect(readState(new URLSearchParams('who=foundation&minConfidence=0.9')).sure).toBe('');
  });

  it('asks for both directions for exchange flows, and no filter for all transfers', () => {
    expect(directionsFor('exchange')).toEqual(['buying', 'selling']);
    expect(directionsFor('all')).toEqual([null]);
    expect(directionsFor('p2p')).toEqual(['p2p']);
  });

  it('builds the events path the API expects', () => {
    expect(
      eventsPath(
        '7D',
        'buying',
        { type: 'exchange', kind: '', exchange: 'GateIO', min: 100 },
        { cursor: '3004268:abc:0', limit: 50 }
      )
    ).toBe(
      '/flow/7D/events?type=buying&exchange=GateIO&minAmount=100&limit=50&cursor=3004268%3Aabc%3A0'
    );
    expect(eventsPath('24H', null, EMPTY_FILTERS)).toBe('/flow/24H/events?limit=50');
    expect(hasFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasFilters({ ...EMPTY_FILTERS, min: 1 })).toBe(true);
    expect(hasFilters({ ...EMPTY_FILTERS, type: 'all' })).toBe(true);
  });
});

describe('merged pager (exchange flows = buying + selling)', () => {
  const ev = (height: number, txid: string, flowType: FlowType, vout = 0): FlowEvent => ({
    txid,
    vout,
    height,
    time: height,
    fromAddress: 'a',
    fromKind: 'unknown',
    toAddress: 'b',
    toKind: 'exchange',
    exchange: 'X',
    flowType,
    amount: 1
  });

  /** A server-like stream: newest first, keyset pages of `size`. */
  function stream(events: FlowEvent[], size: number, calls: string[] = []): PageFetcher {
    const sorted = [...events].sort(compareEvents);
    return async (cursor) => {
      calls.push(cursor ?? 'start');
      const start = cursor ? Number(cursor) : 0;
      const next = start + size < sorted.length ? String(start + size) : null;
      return { events: sorted.slice(start, start + size), nextCursor: next };
    };
  }

  it('orders like the server: height, then txid, then vout, all descending', () => {
    const list = [
      ev(5, 'aa', 'buying'),
      ev(7, 'aa', 'buying'),
      ev(7, 'bb', 'buying', 0),
      ev(7, 'bb', 'buying', 2)
    ];
    expect(list.sort(compareEvents).map((e) => `${e.height}:${e.txid}:${e.vout}`)).toEqual([
      '7:bb:2',
      '7:bb:0',
      '7:aa:0',
      '5:aa:0'
    ]);
  });

  it('pages two interleaved streams with nothing skipped or repeated', async () => {
    const buys = Array.from({ length: 37 }, (_, i) => ev(1000 - i * 3, `b${i}`, 'buying'));
    const sells = Array.from({ length: 23 }, (_, i) => ev(1000 - i * 5, `s${i}`, 'selling'));
    const pager = new MergedPager([stream(buys, 10), stream(sells, 10)]);

    const seen: FlowEvent[] = [];
    while (pager.hasMore) {
      const page = await pager.next(15);
      if (page.length === 0) break;
      seen.push(...page);
    }

    const expected = [...buys, ...sells].sort(compareEvents);
    expect(seen.map((e) => e.txid)).toEqual(expected.map((e) => e.txid));
    expect(pager.hasMore).toBe(false);
  });

  it('never places an event before every stream has shown its next one', async () => {
    // Selling's next event (98) sits between buying's events; merging only what had arrived
    // would put it in the wrong place.
    const buys = Array.from({ length: 5 }, (_, i) => ev(100 - i, `b${i}`, 'buying'));
    const sells = [ev(98, 's0', 'selling'), ev(50, 's1', 'selling')];
    const pager = new MergedPager([stream(buys, 2), stream(sells, 2)]);

    expect((await pager.next(3)).map((e) => e.txid)).toEqual(['b0', 'b1', 's0']);
    expect((await pager.next(3)).map((e) => e.txid)).toEqual(['b2', 'b3', 'b4']);
    expect((await pager.next(3)).map((e) => e.txid)).toEqual(['s1']);
    expect(pager.hasMore).toBe(false);
  });

  it('fetches no more than one page for a single stream', async () => {
    const calls: string[] = [];
    const events = Array.from({ length: 120 }, (_, i) => ev(500 - i, `t${i}`, 'p2p'));
    const pager = new MergedPager([stream(events, 50, calls)]);

    expect(await pager.next(50)).toHaveLength(50);
    expect(calls).toEqual(['start']);
    expect(pager.hasMore).toBe(true);
  });
});

describe('address and txid checks', () => {
  it('accepts FLUX transparent addresses and 64-hex txids only', () => {
    expect(isAddress('t1Tohzrk8nLjkEkD5YdtcTs1DHRXcsocehj')).toBe(true);
    expect(isAddress('t3NryfAQLGeFs9jEoeqsxmBN2QLRaRKFLUX')).toBe(true);
    expect(isAddress('t1Tohzrk8nLjkEkD5YdtcTs1DHRXcsoceh')).toBe(false);
    // 0 and l are not base58.
    expect(isAddress('t1Tohzrk8nLjkEkD5YdtcTs1DHRXcsoce0l')).toBe(false);
    expect(isTxid('d14913841c43881a7203c0c64de0a9ff5e9a55b3d2e90c4dc23ce4fb8b607922')).toBe(true);
    expect(isTxid('d149')).toBe(false);
  });
});

describe('leaderboard normalisation', () => {
  it('reads an older server shape as "not known" rather than undefined or NaN text', () => {
    const old = {
      period: '7D' as const,
      flowType: 'selling' as const,
      sellers: [
        { address: 't1a', kind: 'unknown', total: 30, count: 1, exchanges: ['Kucoin'] },
        { address: 't1b', kind: 'unknown', total: 10, count: 2, exchanges: ['GateIO', 'Coinex'] }
      ]
    } as never;

    const board = normaliseBoard(old, 'sellers');
    const [first, second] = board.sellers!;

    expect(board.total).toBe(40);
    expect(first).toMatchObject({ rank: 1, name: null, share: 0.75, lastSeen: null });
    expect(second!.rank).toBe(2);
    expect(first!.exchanges[0]).toMatchObject({ name: 'Kucoin', count: 0 });
    expect(Number.isFinite(first!.change)).toBe(false);
  });

  it('passes the current shape through untouched', () => {
    const row = {
      rank: 1,
      address: 't1a',
      name: 'Coinex hot wallet',
      kind: 'exchange' as const,
      total: 5,
      count: 1,
      share: 1,
      exchanges: [{ name: 'Coinex', total: 5, count: 1 }],
      lastSeen: 100,
      previousTotal: 2,
      change: 3,
      confidence: 0.98,
      level: 'confirmed' as const,
      labelSource: 'config'
    };
    const board = normaliseBoard(
      { period: '24H', flowType: 'buying', total: 5, buyers: [row] },
      'buyers'
    );
    expect(board.buyers).toEqual([row]);
  });
});

describe('labels and confidence (#19)', () => {
  it('asks the leaderboard API for the chosen confidence', () => {
    expect(boardPath('7D', 'sellers', 'node_operator', 'likely')).toBe(
      '/flow/7D/sellers?limit=10&kind=node_operator&minConfidence=likely'
    );
    expect(boardPath('7D', 'buyers', '')).toBe('/flow/7D/buyers?limit=10');
  });

  it('explains a label source in plain words, with a fallback for new ones', () => {
    expect(sourceText('node_list')).toBe('Runs nodes on the current FluxNode list');
    expect(sourceText('some_new_method')).toBe('Labelled from some new method');
    expect(sourceText(null)).toBe('No label on record');
  });

  it('turns evidence into readable lines and skips internals', () => {
    expect(
      evidenceText({
        method: 'node_list',
        nodes: 8,
        tiers: { NIMBUS: 8 },
        rewards: 104,
        lastRewardHeight: 3004249
      })
    ).toEqual(['8 nodes', '8 Nimbus', '104 rewards received', 'last reward at block 3,004,249']);
    expect(evidenceText(null)).toEqual([]);
  });
});
