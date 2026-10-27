import { describe, expect, it } from 'vitest';
import { pickCurrent } from '@/modules/accounts/domain/current-value';

const day = (n: number) => new Date(Date.UTC(2026, 0, n));
const fact = (id: string, source: string, observedAt: Date, value: unknown, key = 'employees', pinned = false) => ({
  id,
  key,
  value,
  observedAt,
  pinned,
  sourceChain: { vendorSourceId: source },
});
const trust = (t: Record<string, number>) => (f: { sourceChain: { vendorSourceId?: string } }) =>
  t[f.sourceChain.vendorSourceId!] ?? 0.6;

describe('pickCurrent', () => {
  it('returns null for no facts', () => {
    expect(pickCurrent([], () => 0.6)).toEqual({ currentId: null, supersededIds: [], value: null });
  });
  it('pinned beats trust', () => {
    const facts = [fact('hi', 'a', day(5), 100), fact('pin', 'b', day(1), 90, 'employees', true)];
    expect(pickCurrent(facts, trust({ a: 0.9, b: 0.1 })).currentId).toBe('pin');
  });
  it('higher trust beats newer', () => {
    const facts = [fact('old-hi', 'a', day(1), 100), fact('new-lo', 'b', day(9), 90)];
    const r = pickCurrent(facts, trust({ a: 0.9, b: 0.5 }));
    expect(r.currentId).toBe('old-hi');
    expect(r.supersededIds).toEqual([]);
  });
  it('equal trust: the more recent observation wins', () => {
    const facts = [fact('a1', 'a', day(1), 1), fact('b1', 'b', day(2), 2)];
    expect(pickCurrent(facts, () => 0.6).currentId).toBe('b1');
  });
  it('a newer fact from the same source supersedes that source older fact', () => {
    const facts = [fact('old', 'a', day(1), 100), fact('new', 'a', day(5), 120)];
    expect(pickCurrent(facts, () => 0.6)).toEqual({ currentId: 'new', supersededIds: ['old'], value: 120 });
  });
  it('list facts take the union of each source latest', () => {
    const facts = [
      fact('a-old', 'a', day(1), ['x'], 'technologies'),
      fact('a-new', 'a', day(3), ['y', 'z'], 'technologies'),
      fact('b', 'b', day(2), ['z', 'w'], 'technologies'),
    ];
    const r = pickCurrent(facts, trust({ a: 0.5, b: 0.9 }));
    expect(r.value).toEqual(['y', 'z', 'w']);
    expect(r.supersededIds).toEqual(['a-old']);
    expect(r.currentId).toBe('b');
  });
  it('free text takes the newest regardless of trust and supersedes the rest', () => {
    const facts = [fact('t', 'a', day(1), 'old', 'description'), fact('n', 'b', day(4), 'new', 'description')];
    const r = pickCurrent(facts, trust({ a: 0.9, b: 0.1 }));
    expect(r).toEqual({ currentId: 'n', supersededIds: ['t'], value: 'new' });
  });
});
