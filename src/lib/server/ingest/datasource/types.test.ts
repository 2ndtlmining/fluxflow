import { describe, expect, it } from 'vitest';
import {
  SATS_PER_FLUX,
  checkConservation,
  formatFlux,
  isRelevantTx,
  toSat,
  toValueDeltas,
  type AddressKind,
  type NormalisedTx
} from './types';

describe('toSat', () => {
  it('passes satoshis through unchanged', () => {
    expect(toSat(100_000_000, 'sat')).toBe(100_000_000);
  });

  it('converts FLUX to satoshis', () => {
    expect(toSat(1, 'flux')).toBe(SATS_PER_FLUX);
    expect(toSat(2.5, 'flux')).toBe(250_000_000);
  });

  it('accepts numeric strings, which blockbook returns', () => {
    expect(toSat('100000000', 'sat')).toBe(100_000_000);
  });

  it('treats a missing value as zero rather than NaN', () => {
    expect(toSat(undefined, 'sat')).toBe(0);
    expect(toSat(null, 'flux')).toBe(0);
  });

  it('rounds fractional satoshis rather than storing a float', () => {
    expect(toSat(1.4, 'sat')).toBe(1);
    expect(toSat(1.6, 'sat')).toBe(2);
  });

  it.each([
    ['a string', 'not-a-number'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative amount', -1]
  ])('rejects %s', (_label, value) => {
    // A malformed value must fail loudly: writing a plausible-looking wrong number into
    // an integer satoshi column is exactly the silent failure #15 warns about.
    expect(() => toSat(value as number, 'sat')).toThrow(RangeError);
  });

  it('distinguishes the two units by 1e8, which is the whole point', () => {
    expect(toSat(1, 'sat')).not.toBe(toSat(1, 'flux'));
  });
});

describe('formatFlux', () => {
  it('renders satoshis with 8 decimals', () => {
    expect(formatFlux(SATS_PER_FLUX)).toBe('1.00000000');
    expect(formatFlux(1)).toBe('0.00000001');
    expect(formatFlux(0)).toBe('0.00000000');
  });
});

describe('toValueDeltas', () => {
  const tx: NormalisedTx = {
    txid: 'tx1',
    kind: 'transfer',
    // A consolidation: two inputs from the same address, which must collapse to one row.
    inputs: [
      { address: 'exchange', sat: 400_000_000, vout: 0 },
      { address: 'exchange', sat: 600_000_000, vout: 1 },
      { address: 'walletA', sat: 100_000_000, vout: 2 }
    ],
    outputs: [
      { n: 0, address: 'walletB', sat: 900_000_000, nulldata: false },
      { n: 1, address: 'walletC', sat: 100_000_000, nulldata: false },
      { n: 2, address: null, sat: 50_000_000, nulldata: true }
    ],
    complete: true
  };

  it('collapses multiple inputs from the same address into one row', () => {
    const deltas = toValueDeltas(tx);
    const exchange = deltas.find((delta) => delta.address === 'exchange');

    expect(deltas.filter((delta) => delta.address === 'exchange')).toHaveLength(1);
    expect(exchange).toEqual({ address: 'exchange', satIn: 1_000_000_000, satOut: 0 });
  });

  it('records both directions for an address that sends and receives', () => {
    const walletA = toValueDeltas(tx).find((delta) => delta.address === 'walletA');

    expect(walletA).toEqual({ address: 'walletA', satIn: 100_000_000, satOut: 0 });
  });

  it('ignores nulldata outputs, which are not counterparty transfers', () => {
    const deltas = toValueDeltas(tx);

    expect(deltas.map((delta) => delta.address)).not.toContain(null);
    expect(deltas.reduce((sum, delta) => sum + delta.satOut, 0)).toBe(1_000_000_000);
  });

  it('ignores inputs with no resolvable address', () => {
    const deltas = toValueDeltas({
      txid: 'tx2',
      kind: 'transfer',
      inputs: [{ address: null, sat: 500_000_000, vout: null }],
      outputs: [{ n: 0, address: 'walletA', sat: 500_000_000, nulldata: false }],
      complete: true
    });

    expect(deltas).toEqual([{ address: 'walletA', satIn: 0, satOut: 500_000_000 }]);
  });

  it('drops addresses that moved nothing', () => {
    const deltas = toValueDeltas({
      txid: 'tx3',
      kind: 'transfer',
      inputs: [{ address: 'walletA', sat: 0, vout: 0 }],
      outputs: [{ n: 0, address: 'walletA', sat: 0, nulldata: false }],
      complete: true
    });

    expect(deltas).toEqual([]);
  });
});

describe('isRelevantTx', () => {
  /** Named addresses stand in for labelled wallets; anything starting `unknown` is unlabelled. */
  const kindOf = (address: string): AddressKind => {
    if (address.startsWith('unknown')) return 'unknown';
    if (address === 'exchange') return 'exchange';
    if (address.startsWith('foundation')) return 'foundation';
    return 'node_operator';
  };

  function tx(overrides: Partial<NormalisedTx> = {}): NormalisedTx {
    return {
      txid: 'tx1',
      kind: 'transfer',
      inputs: [{ address: 'unknown1', sat: 1, vout: 0 }],
      outputs: [{ n: 0, address: 'unknown2', sat: 1, nulldata: false }],
      complete: true,
      ...overrides
    };
  }

  it('keeps a transfer that pays a known address', () => {
    expect(
      isRelevantTx(
        tx({ outputs: [{ n: 0, address: 'exchange', sat: 1, nulldata: false }] }),
        kindOf
      )
    ).toBe(true);
  });

  it('keeps a transfer funded by a known address', () => {
    expect(isRelevantTx(tx({ inputs: [{ address: 'exchange', sat: 1, vout: 0 }] }), kindOf)).toBe(
      true
    );
  });

  it('drops a transfer between two unknown wallets', () => {
    expect(isRelevantTx(tx(), kindOf)).toBe(false);
  });

  it('drops the coinbase, which has no counterparty worth naming', () => {
    expect(isRelevantTx(tx({ kind: 'coinbase' }), kindOf)).toBe(false);
  });

  it('drops node confirmations', () => {
    expect(isRelevantTx(tx({ kind: 'node_confirm' }), kindOf)).toBe(false);
  });

  it('drops a transfer whose outputs are all nulldata', () => {
    expect(
      isRelevantTx(tx({ outputs: [{ n: 0, address: null, sat: 1, nulldata: true }] }), kindOf)
    ).toBe(false);
  });

  it('keeps a transfer that a labelled wallet funds into an OP_RETURN', () => {
    expect(
      isRelevantTx(
        tx({
          inputs: [{ address: 'exchange', sat: 1, vout: 0 }],
          outputs: [{ n: 0, address: null, sat: 1, nulldata: true }]
        }),
        kindOf
      )
    ).toBe(true);
  });
});

describe('checkConservation', () => {
  function tx(inputSat: number, outputSat: number): NormalisedTx {
    return {
      txid: 'tx1',
      kind: 'transfer',
      inputs: [{ address: 'a', sat: inputSat, vout: 0 }],
      outputs: [{ n: 0, address: 'b', sat: outputSat, nulldata: false }],
      complete: true
    };
  }

  it('accepts a transaction where the difference is the fee', () => {
    expect(checkConservation(tx(1_000_000_000, 999_999_000))).toBeNull();
  });

  it('flags outputs exceeding inputs, which means a unit mismatch', () => {
    // If satoshis were read as FLUX, outputs would appear 1e8x too large. This is the
    // check that makes an off-by-1e8 loud instead of silent.
    expect(checkConservation(tx(1_000_000, 900_000_000))).toMatch(/value unit mismatch/);
  });

  it('flags outputs with no inputs at all', () => {
    expect(checkConservation(tx(0, 5_000_000))).toMatch(/no inputs/);
  });

  it('accepts an empty transaction', () => {
    expect(checkConservation(tx(0, 0))).toBeNull();
  });

  it('accepts outputs equal to inputs, a zero-fee transfer', () => {
    expect(checkConservation(tx(500, 500))).toBeNull();
  });
});
