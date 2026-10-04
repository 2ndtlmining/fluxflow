import { describe, expect, it } from 'vitest';
import {
  activityText,
  candidateId,
  clearToken,
  decisionPreview,
  evidenceItems,
  groupCandidates,
  methodText,
  readToken,
  saveToken,
  TOKEN_KEY,
  type ReviewCandidate
} from './review';

const ADDRESS = 't1Y5LHWLYVnJQUPK1ftApMqNxBvKr3cRGB3';
const TXID = 'de60f1c9492b8afe9e45f89accd4891d15f6a635702690c465d3cc942941a594';

function candidate(overrides: Partial<ReviewCandidate> & { address: string }): ReviewCandidate {
  return {
    kind: 'exchange',
    name: 'GateIO',
    method: 'sweep',
    confidence: 0.5,
    evidence: null,
    status: 'pending',
    createdAt: 0,
    decidedAt: null,
    strength: 0.5,
    currentLabel: null,
    activity: {
      txs: 1,
      firstSeen: 1,
      lastSeen: 2,
      received: { flux: 0, transfers: 0, senders: 0, fromNodeOperators: 0 },
      sent: { flux: 0, transfers: 0, toClaimed: 0, toClaimedShare: null, exchanges: [] }
    },
    ...overrides
  };
}

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

describe('admin token', () => {
  it('round-trips through the given storage, trimmed', () => {
    const storage = new MemoryStorage();
    expect(readToken(storage)).toBeNull();
    saveToken('  secret  ', storage);
    expect(storage.getItem(TOKEN_KEY)).toBe('secret');
    expect(readToken(storage)).toBe('secret');
    clearToken(storage);
    expect(readToken(storage)).toBeNull();
  });

  it('survives storage that throws or is missing', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      }
    } as unknown as Storage;
    expect(readToken(broken)).toBeNull();
    expect(() => saveToken('x', broken)).not.toThrow();
    expect(() => clearToken(broken)).not.toThrow();
    expect(readToken(null)).toBeNull();
  });
});

describe('groupCandidates', () => {
  it('groups by party and method, strongest first inside and across groups', () => {
    const groups = groupCandidates([
      candidate({ address: 'a', name: 'NonKYC', strength: 0.3 }),
      candidate({ address: 'b', strength: 0.4 }),
      candidate({ address: 'c', strength: 0.6 }),
      candidate({ address: 'd', name: 'NonKYC', method: 'common_input', strength: 0.9 })
    ]);

    expect(groups.map((g) => g.key)).toEqual([
      'NonKYC|common_input|exchange',
      'GateIO|sweep|exchange',
      'NonKYC|sweep|exchange'
    ]);
    expect(groups[1]!.items.map((c) => c.address)).toEqual(['c', 'b']);
    expect(groups[1]!.strongest).toBe(0.6);
  });

  it('breaks strength ties by how much the address moved', () => {
    const moved = (flux: number) => ({
      ...candidate({ address: 'x' }).activity,
      sent: { flux, transfers: 1, toClaimed: flux, toClaimedShare: 1, exchanges: [] }
    });
    const [group] = groupCandidates([
      candidate({ address: 'small', activity: moved(10) }),
      candidate({ address: 'big', activity: moved(1_000) })
    ]);
    expect(group!.items.map((c) => c.address)).toEqual(['big', 'small']);
    expect(group!.sentFlux).toBe(1_010);
  });

  it('identifies a candidate by address, kind and name', () => {
    expect(candidateId({ address: ADDRESS, kind: 'exchange', name: 'GateIO' })).toBe(
      `${ADDRESS}|exchange|GateIO`
    );
  });
});

describe('describing candidates', () => {
  it('explains known methods and names unknown ones instead of hiding them', () => {
    expect(methodText('forwarder')).toMatch(/deposit address/);
    expect(methodText('sweep')).toMatch(/Swept/);
    expect(methodText('dust_pattern')).toBe('Proposed by dust pattern');
  });

  it('links transactions and addresses in evidence, whatever the method', () => {
    const items = evidenceItems({
      method: 'sweep',
      sweepTx: TXID,
      into: ADDRESS,
      inputs: 10,
      anchors: [ADDRESS, ADDRESS],
      note: 'hand checked'
    });

    expect(items.find((i) => i.label === 'sweep tx')).toMatchObject({
      href: `https://explorer.runonflux.io/tx/${TXID}`,
      external: true
    });
    expect(items.find((i) => i.label === 'into')).toMatchObject({ href: `/wallet/${ADDRESS}` });
    expect(items.filter((i) => i.label === 'anchors')).toHaveLength(2);
    expect(items.find((i) => i.label === 'inputs')).toMatchObject({ text: '10' });
    expect(items.find((i) => i.label === 'note')).toMatchObject({ text: 'hand checked' });
    expect(items.some((i) => i.label === 'method')).toBe(false);
    expect(evidenceItems(null)).toEqual([]);
  });

  it('caps long lists of links', () => {
    const items = evidenceItems({ sharedTxs: Array.from({ length: 8 }, () => TXID) });
    expect(items).toHaveLength(6);
    expect(items.at(-1)!.text).toBe('and 3 more');
  });

  it('states what the address did', () => {
    expect(activityText(candidate({ address: 'a' }))).toBe(
      'No transfers stored for this address yet.'
    );

    const active = candidate({
      address: 'a',
      activity: {
        txs: 20,
        firstSeen: 1,
        lastSeen: 2,
        received: { flux: 46_413, transfers: 13, senders: 7, fromNodeOperators: 5 },
        sent: {
          flux: 46_413,
          transfers: 13,
          toClaimed: 46_413,
          toClaimedShare: 1,
          exchanges: [{ name: 'GateIO', flux: 46_413 }]
        }
      }
    });
    expect(activityText(active)).toBe(
      'Received 46.4K FLUX from 7 wallets (5 from node operators); sent 46.4K FLUX, 100% of it to GateIO.'
    );
  });

  it('previews a decision', () => {
    const picked = [
      candidate({ address: 'a', activity: { ...candidate({ address: 'a' }).activity, txs: 3 } }),
      candidate({ address: 'b', activity: { ...candidate({ address: 'b' }).activity, txs: 4 } })
    ];
    expect(decisionPreview('accepted', picked)).toBe(
      'Label 2 addresses as GateIO. About 7 transactions are re-derived.'
    );
    expect(decisionPreview('rejected', picked.slice(0, 1))).toMatch(/^Reject 1 address for GateIO/);
  });
});
