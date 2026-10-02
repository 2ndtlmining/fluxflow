import { describe, expect, it } from 'vitest';
import {
  BLOCK_TIME_SECONDS,
  DEFAULT_PERIOD,
  PERIODS,
  PERIOD_IDS,
  blocksToTime,
  getPeriodBlocks,
  hasEnoughBlocks,
  isPeriodId,
  timeToBlocks,
  type PeriodId
} from './constants';

describe('PERIODS', () => {
  it('exposes the five dashboard periods', () => {
    expect(PERIOD_IDS).toEqual(['24H', '7D', '30D', '90D', '6M']);
  });

  it('converts each period to blocks at the nominal block time', () => {
    expect(PERIODS['24H']).toBe(2_880);
    expect(PERIODS['7D']).toBe(20_160);
    expect(PERIODS['30D']).toBe(86_400);
    expect(PERIODS['6M']).toBe(518_400);
  });

  it('keeps periods in ascending order of length', () => {
    const lengths = PERIOD_IDS.map((id: PeriodId) => PERIODS[id]);
    expect([...lengths].sort((a, b) => a - b)).toEqual(lengths);
  });

  it('uses a default period that exists in the map', () => {
    expect(PERIODS[DEFAULT_PERIOD]).toBeDefined();
  });
});

describe('isPeriodId', () => {
  it('accepts known ids', () => {
    expect(isPeriodId('24H')).toBe(true);
    expect(isPeriodId('6M')).toBe(true);
  });

  it('rejects unknown ids and inherited object properties', () => {
    expect(isPeriodId('1Y')).toBe(false);
    expect(isPeriodId('constructor')).toBe(false);
    expect(isPeriodId('toString')).toBe(false);
  });
});

describe('getPeriodBlocks', () => {
  it('returns the block count for a known period', () => {
    expect(getPeriodBlocks('7D')).toBe(PERIODS['7D']);
  });

  it('falls back to the default period for unknown input', () => {
    expect(getPeriodBlocks('nope')).toBe(PERIODS[DEFAULT_PERIOD]);
  });
});

describe('hasEnoughBlocks', () => {
  it('is false below the period length and true at or above it', () => {
    expect(hasEnoughBlocks(PERIODS['24H'] - 1, '24H')).toBe(false);
    expect(hasEnoughBlocks(PERIODS['24H'], '24H')).toBe(true);
    expect(hasEnoughBlocks(PERIODS['24H'] + 1, '24H')).toBe(true);
  });
});

describe('blocksToTime', () => {
  it('formats days and hours', () => {
    expect(blocksToTime(PERIODS['24H'])).toBe('1d 0h');
  });

  it('formats hours and minutes', () => {
    expect(blocksToTime(60)).toBe('30m');
    expect(blocksToTime(120)).toBe('1h 0m');
  });

  it('formats sub-hour durations in minutes', () => {
    expect(blocksToTime(1)).toBe('0m');
  });
});

describe('timeToBlocks', () => {
  it('converts hours to blocks', () => {
    expect(timeToBlocks(1)).toBe(Math.floor(3_600 / BLOCK_TIME_SECONDS));
  });

  it('round-trips whole-day conversions', () => {
    expect(timeToBlocks(24)).toBe(PERIODS['24H']);
    expect(timeToBlocks(24 * 7)).toBe(PERIODS['7D']);
  });
});
