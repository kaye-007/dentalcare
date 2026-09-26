import { GENESIS_HASH, eventHash, verifyChain, type EventFacts, type StoredEvent } from './drawer-ledger';

const SESSION = '5f0c7b6e-1d2a-4c3b-9e8f-7a6b5c4d3e2f';
const ACTOR = '0a1b2c3d-4e5f-4061-8a9b-0c1d2e3f4a5b';

function facts(seq: number, over: Partial<EventFacts> = {}): EventFacts {
  return {
    sessionId: SESSION,
    seq,
    type: 'cash_sale',
    currency: 'ALL',
    amount: 850_000,
    paymentId: `00000000-0000-4000-8000-00000000000${seq}`,
    fiscalCashDepositId: null,
    approvalId: null,
    reason: null,
    actorUserId: ACTOR,
    occurredAt: `2026-09-17T08:0${seq}:00.000Z`,
    ...over,
  };
}

function chain(list: EventFacts[]): StoredEvent[] {
  let prev = GENESIS_HASH;
  return list.map((f) => {
    const hash = eventHash(prev, f);
    const e = { ...f, prevHash: prev, hash };
    prev = hash;
    return e;
  });
}

describe('drawer event chain', () => {
  const events = chain([
    facts(1, { type: 'open', paymentId: null, amount: 1_000_000 }),
    facts(2),
    facts(3, { type: 'drop', paymentId: null, amount: 500_000 }),
  ]);
  const head = { lastSeq: 3, lastHash: events[2]!.hash };

  it('hashes to 64 lowercase hex characters, deterministically', () => {
    const h = eventHash(GENESIS_HASH, facts(1));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(eventHash(GENESIS_HASH, facts(1))).toBe(h);
  });

  it('changes the hash when any recorded fact changes', () => {
    const base = eventHash(GENESIS_HASH, facts(1));
    for (const over of [
      { amount: 850_001 },
      { currency: 'EUR' as const },
      { type: 'payout' as const },
      { actorUserId: SESSION },
      { reason: 'x' },
      { occurredAt: '2026-09-17T08:01:00.001Z' },
    ]) {
      expect(eventHash(GENESIS_HASH, facts(1, over))).not.toBe(base);
    }
    expect(eventHash('f'.repeat(64), facts(1))).not.toBe(base);
  });

  it('verifies an intact chain against the session head', () => {
    expect(verifyChain(events, head)).toEqual({ valid: true });
  });

  it('finds an amount edited after the fact', () => {
    const tampered = events.map((e) => (e.seq === 2 ? { ...e, amount: 1 } : e));
    expect(verifyChain(tampered, head)).toEqual({ valid: false, brokenAtSeq: 2 });
  });

  it('finds a deleted event', () => {
    const missing = [events[0]!, events[2]!];
    expect(verifyChain(missing, head)).toEqual({ valid: false, brokenAtSeq: 2 });
  });

  it('finds the last event deleted together with a rewound head', () => {
    const truncated = events.slice(0, 2);
    expect(verifyChain(truncated, head)).toEqual({ valid: false, brokenAtSeq: 3 });
  });

  it('treats an empty session with a genesis head as valid', () => {
    expect(verifyChain([], { lastSeq: 0, lastHash: GENESIS_HASH })).toEqual({ valid: true });
  });
});
