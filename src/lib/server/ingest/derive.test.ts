import { describe, expect, it } from 'vitest';
import { classifyFlow, deriveBlock, deriveFlows, type Resolver } from './derive.js';
import type { NormalisedBlock, NormalisedTx } from './datasource/types.js';

const SATS = 100_000_000;
const HOUR = 3_600;
const NOW = 1_756_000_000;

const EXCHANGE = 't1coinex1';
const KEEP: Resolver = {
  kindOf: (address) =>
    address === EXCHANGE ? 'exchange' : address === 't1foundation1' ? 'foundation' : 'unknown',
  nameOf: (address) =>
    address === EXCHANGE ? 'Coinex' : address === 't1foundation1' ? 'Flux Foundation' : null
};

function input(address: string | null, sat: number, vout = 0) {
  return { address, sat, vout };
}

function output(address: string | null, sat: number, n = 0, nulldata = false) {
  return { n, address, sat, nulldata };
}

function transfer(
  txid: string,
  ins: ReturnType<typeof input>[],
  outs: ReturnType<typeof output>[]
): NormalisedTx {
  return { txid, kind: 'transfer', inputs: ins, outputs: outs, complete: true };
}

function coinbase(txid: string, outs: ReturnType<typeof output>[]): NormalisedTx {
  return {
    txid,
    kind: 'coinbase',
    inputs: [
      input(
        null,
        outs.reduce((sum, o) => sum + o.sat, 0),
        -1
      )
    ],
    outputs: outs,
    complete: true
  };
}

function block(transactions: NormalisedTx[], height = 1_000): NormalisedBlock {
  return {
    height,
    hash: `hash-${height}`,
    prevHash: `hash-${height - 1}`,
    time: NOW,
    txCount: transactions.length,
    transactions
  };
}

describe('classifyFlow', () => {
  it('is buying when funds leave an exchange', () => {
    expect(classifyFlow('exchange', 'node_operator')).toBe('buying');
  });

  it('is selling when funds arrive at an exchange', () => {
    expect(classifyFlow('unknown', 'exchange')).toBe('selling');
  });

  it('is p2p when neither side is an exchange', () => {
    expect(classifyFlow('unknown', 'node_operator')).toBe('p2p');
  });

  it('is p2p for an exchange-to-exchange transfer, not buying or selling', () => {
    // An internal consolidation between two exchange wallets moves no FLUX to or from the
    // market, so counting it as flow would double-count.
    expect(classifyFlow('exchange', 'exchange')).toBe('p2p');
  });

  it('is p2p for foundation transfers', () => {
    expect(classifyFlow('foundation', 'unknown')).toBe('p2p');
  });
});

describe('deriveFlows', () => {
  it('records an exchange withdrawal as buying', () => {
    const tx = transfer(
      'tx1',
      [input(EXCHANGE, 10 * SATS)],
      [output('t1whale', 10 * SATS - 1_000)]
    );

    const flows = deriveFlows(tx, 1_000, NOW, KEEP);

    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({
      fromAddress: EXCHANGE,
      fromKind: 'exchange',
      toAddress: 't1whale',
      toKind: 'unknown',
      flowType: 'buying',
      exchange: 'Coinex',
      sat: 10 * SATS - 1_000
    });
  });

  it('records a deposit as selling', () => {
    const tx = transfer('tx1', [input('t1whale', 5 * SATS)], [output(EXCHANGE, 5 * SATS - 1_000)]);

    const [flow] = deriveFlows(tx, 1_000, NOW, KEEP);

    expect(flow).toMatchObject({ flowType: 'selling', exchange: 'Coinex', fromAddress: 't1whale' });
  });

  it('records the amount received, not the amount sent, so a fee cannot inflate it', () => {
    const tx = transfer('tx1', [input(EXCHANGE, 10 * SATS)], [output('t1whale', 7 * SATS)]);

    expect(deriveFlows(tx, 1_000, NOW, KEEP)[0]!.sat).toBe(7 * SATS);
  });

  it('collapses two inputs from the same exchange into one funder', () => {
    const tx = transfer(
      'tx1',
      [input(EXCHANGE, 4 * SATS, 0), input(EXCHANGE, 6 * SATS, 1)],
      [output('t1whale', 10 * SATS - 1_000)]
    );

    const flows = deriveFlows(tx, 1_000, NOW, KEEP);

    expect(flows).toHaveLength(1);
    expect(flows[0]!.sat).toBe(10 * SATS - 1_000);
  });

  it('records one flow per recipient in a fan-out', () => {
    const tx = transfer(
      'tx1',
      [input(EXCHANGE, 10 * SATS)],
      [output('t1a', 3 * SATS, 0), output('t1b', 3 * SATS, 1), output('t1c', 4 * SATS, 2)]
    );

    const flows = deriveFlows(tx, 1_000, NOW, KEEP);

    expect(flows.map((flow) => flow.toAddress)).toEqual(['t1a', 't1b', 't1c']);
    // vout must be unique: (txid, vout) is the flows primary key.
    expect(new Set(flows.map((flow) => flow.vout)).size).toBe(3);
  });

  it('attributes a consolidation to the named funder, not the stranger', () => {
    // An exchange consolidating its own deposit with a stranger's coins is still an
    // exchange withdrawal; v1 used "whichever input address came first".
    const tx = transfer(
      'tx1',
      [input('t1stranger', 5 * SATS, 0), input(EXCHANGE, 5 * SATS, 1)],
      [output('t1destination', 10 * SATS)]
    );

    expect(deriveFlows(tx, 1_000, NOW, KEEP)[0]).toMatchObject({
      fromAddress: EXCHANGE,
      flowType: 'buying'
    });
  });

  it('picks the smallest sufficient funder when several are known', () => {
    const tx = transfer(
      'tx1',
      [input(EXCHANGE, 100 * SATS, 0), input(EXCHANGE, 2 * SATS, 1)],
      [output('t1destination', 2 * SATS)]
    );

    expect(deriveFlows(tx, 1_000, NOW, KEEP)[0]!.sat).toBe(2 * SATS);
  });

  it('ignores a wallet paying itself', () => {
    const tx = transfer(
      'tx1',
      [input('t1wallet', 10 * SATS)],
      [output('t1wallet', 6 * SATS, 0), output('t1other', 4 * SATS, 1)]
    );

    const flows = deriveFlows(tx, 1_000, NOW, KEEP);

    // Only the genuinely external part is a flow.
    expect(flows.map((flow) => flow.toAddress)).toEqual(['t1other']);
    expect(flows[0]!.sat).toBe(4 * SATS);
  });

  it('records nothing for a nulldata-only output', () => {
    const tx = transfer('tx1', [input(EXCHANGE, SATS)], [output(null, SATS - 1_000, 0, true)]);

    expect(deriveFlows(tx, 1_000, NOW, KEEP)).toHaveLength(0);
  });

  it('records nothing when there is no funder', () => {
    const tx = transfer('tx1', [], [output('t1a', SATS)]);

    expect(deriveFlows(tx, 1_000, NOW, KEEP)).toHaveLength(0);
  });

  it('records nothing when there is no recipient', () => {
    const tx = transfer('tx1', [input(EXCHANGE, SATS)], []);

    expect(deriveFlows(tx, 1_000, NOW, KEEP)).toHaveLength(0);
  });

  it('carries no exchange name when neither side is known', () => {
    const tx = transfer('tx1', [input('t1a', SATS)], [output('t1b', SATS - 1)]);

    expect(deriveFlows(tx, 1_000, NOW, KEEP)[0]!.exchange).toBeNull();
  });
});

describe('exchange attribution', () => {
  const NAMED: Resolver = {
    kindOf: (address) =>
      (({ t1kucoin: 'exchange', t1girder: 'node_operator', t1foundation1: 'foundation' })[
        address
      ] as never) ?? 'unknown',
    nameOf: (address) =>
      ({ t1kucoin: 'Kucoin', t1girder: 'Girder Works', t1foundation1: 'Flux Foundation' })[
        address
      ] ?? null
  };

  it('credits a sale to the exchange, not to a named sender of another kind', () => {
    const [flow] = deriveFlows(
      transfer('tx1', [input('t1girder', 10 * SATS)], [output('t1kucoin', 10 * SATS - 1_000)]),
      1,
      NOW,
      NAMED
    );

    expect(flow!.flowType).toBe('selling');
    expect(flow!.exchange).toBe('Kucoin');
  });

  it('carries no exchange for a foundation transfer to a stranger', () => {
    const [flow] = deriveFlows(
      transfer('tx1', [input('t1foundation1', 10 * SATS)], [output('t1someone', 10 * SATS)]),
      1,
      NOW,
      NAMED
    );

    expect(flow!.flowType).toBe('p2p');
    expect(flow!.exchange).toBeNull();
  });
});

describe('deriveBlock', () => {
  it('records the block header with its source', () => {
    const derived = deriveBlock(
      block([transfer('t', [input(EXCHANGE, SATS)], [output('w', SATS)])]),
      'blockbook',
      KEEP
    );

    expect(derived).toMatchObject({
      height: 1_000,
      hash: 'hash-1000',
      prevHash: 'hash-999',
      txCount: 1,
      source: 'blockbook'
    });
  });

  it('emits one delta per address, not per input', () => {
    const derived = deriveBlock(
      block([
        transfer(
          'tx1',
          [input(EXCHANGE, 4 * SATS, 0), input(EXCHANGE, 6 * SATS, 1)],
          [output('t1whale', 10 * SATS)]
        )
      ]),
      'blockbook',
      KEEP
    );

    const forExchange = derived.deltas.filter((delta) => delta.address === EXCHANGE);

    expect(forExchange).toHaveLength(1);
    expect(forExchange[0]!.satIn).toBe(10 * SATS);
  });

  it('captures node rewards from the coinbase', () => {
    const derived = deriveBlock(
      block([coinbase('cb', [output('t1miner1', 5 * SATS), output('t1miner2', 5 * SATS)])]),
      'blockbook',
      KEEP
    );

    expect(derived.nodeRewards).toHaveLength(2);
    expect(derived.nodeRewards[0]).toMatchObject({
      address: 't1miner1',
      height: 1_000,
      rewardCount: 1,
      sat: 5 * SATS
    });
  });

  it('floors the reward day so rewards group by calendar day', () => {
    const derived = deriveBlock(
      block([coinbase('cb', [output('t1miner', SATS)])], 1_000),
      'blockbook',
      KEEP
    );

    expect(derived.nodeRewards[0]!.day).toBe(Math.floor(NOW / 86_400) * 86_400);
  });

  it('excludes a nulldata coinbase output from rewards', () => {
    const derived = deriveBlock(
      block([coinbase('cb', [output('t1miner', SATS), output(null, SATS, 1, true)])]),
      'blockbook',
      KEEP
    );

    expect(derived.nodeRewards).toHaveLength(1);
  });

  it('keys rewards by height so a re-synced block overwrites rather than adds', () => {
    const cb = block([coinbase('cb', [output('t1miner', SATS)])], 1_000);
    const first = deriveBlock(cb, 'blockbook', KEEP);
    const second = deriveBlock(cb, 'blockbook', KEEP);

    expect(first.nodeRewards).toEqual(second.nodeRewards);
  });

  it('does not turn a coinbase into a flow', () => {
    const derived = deriveBlock(
      block([coinbase('cb', [output('t1miner', SATS)])]),
      'blockbook',
      KEEP
    );

    expect(derived.flows).toHaveLength(0);
  });

  it('skips an incomplete transfer and says so', () => {
    const incomplete: NormalisedTx = {
      txid: 'tx1',
      kind: 'transfer',
      inputs: [],
      outputs: [],
      complete: false
    };

    const derived = deriveBlock(block([incomplete]), 'blockbook', KEEP);

    expect(derived.deltas).toHaveLength(0);
    expect(derived.flows).toHaveLength(0);
    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toMatch(/incomplete/);
  });

  it('marks a block with an incomplete transfer as incomplete, so it is not committed', () => {
    const incomplete: NormalisedTx = {
      txid: 'tx1',
      kind: 'transfer',
      inputs: [],
      outputs: [],
      complete: false
    };

    // Committing it would mark the height done with a transfer missing for good (#14).
    expect(deriveBlock(block([incomplete]), 'flux-indexer', KEEP).incomplete).toBe(true);
    expect(deriveBlock(block([]), 'flux-indexer', KEEP).incomplete).toBe(false);
  });

  it('warns when a transaction does not conserve value', () => {
    const broken = transfer('tx1', [input('a', 1_000)], [output('b', 999 * SATS)]);

    const derived = deriveBlock(block([broken]), 'blockbook', KEEP);

    expect(derived.warnings.join()).toMatch(/value unit mismatch/);
  });

  it('records nothing for an empty block', () => {
    const derived = deriveBlock(block([]), 'blockbook', KEEP);

    expect(derived).toMatchObject({ deltas: [], flows: [], nodeRewards: [], warnings: [] });
  });

  it('handles a block spread over several hours without mixing up times', () => {
    const transactions = [
      transfer('a', [input(EXCHANGE, SATS)], [output('w', SATS - 1)]),
      transfer('b', [input('w', SATS)], [output(EXCHANGE, SATS - 1)])
    ];

    const derived = deriveBlock(
      { ...block(transactions), time: NOW - 5 * HOUR },
      'blockbook',
      KEEP
    );

    expect(derived.flows.every((flow) => flow.time === NOW - 5 * HOUR)).toBe(true);
  });
});
