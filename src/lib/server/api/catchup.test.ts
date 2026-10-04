import { describe, expect, it } from 'vitest';
import { CATCH_UP_BLOCKS, catchUpState } from './catchup.js';

const base = { oldestHeight: 1_000, oldestTime: 1_700_000_000, latestTime: 1_700_100_000 };

describe('catchUpState', () => {
  it('reports a fresh sync half way through, with an estimate', () => {
    // Shape of a new deployment: 6 months stored oldest-first, tip far ahead.
    const state = catchUpState({
      ...base,
      latestHeight: 5_999,
      tip: 11_000,
      blocksPerMinute: 1_000
    });

    expect(state).toEqual({
      tip: 11_000,
      behindBlocks: 5_001,
      catchingUp: true,
      progress: 50,
      dataFrom: base.oldestTime,
      dataAsOf: base.latestTime,
      etaSeconds: 300
    });
  });

  it('is caught up within a few blocks of the tip', () => {
    const state = catchUpState({
      ...base,
      latestHeight: 11_000 - CATCH_UP_BLOCKS,
      tip: 11_000,
      blocksPerMinute: 2
    });

    expect(state).toMatchObject({ catchingUp: false, progress: 100, etaSeconds: null });
  });

  it('is catching up before anything is stored', () => {
    expect(
      catchUpState({
        oldestHeight: 0,
        oldestTime: 0,
        latestHeight: 0,
        latestTime: 0,
        tip: null,
        blocksPerMinute: 0
      })
    ).toMatchObject({ catchingUp: true, progress: 0, dataFrom: null, dataAsOf: null });
  });

  it('gives no estimate without a rate', () => {
    expect(
      catchUpState({ ...base, latestHeight: 2_000, tip: 9_000, blocksPerMinute: 0 }).etaSeconds
    ).toBeNull();
  });
});
