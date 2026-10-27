import { describe, expect, it } from 'vitest';
import { inputsHash } from '@/modules/scoring/domain/inputs-hash';

const base = {
  now: new Date('2026-10-14T12:00:00Z'),
  account: { domain: 'acme.com', employees: 400, seen: new Date('2026-10-01T00:00:00Z') },
  signals: [{ id: 'a', value: 1 }],
};

describe('inputsHash', () => {
  it('is a sha256 hex string', () => {
    expect(inputsHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('ignores now', () => {
    expect(inputsHash({ ...base, now: new Date('2030-01-01T00:00:00Z') })).toBe(inputsHash(base));
  });
  it('ignores key order at every depth', () => {
    const reordered = {
      signals: [{ value: 1, id: 'a' }],
      account: { seen: new Date('2026-10-01T00:00:00Z'), employees: 400, domain: 'acme.com' },
      now: base.now,
    };
    expect(inputsHash(reordered)).toBe(inputsHash(base));
  });
  it('changes with one fact', () => {
    expect(inputsHash({ ...base, account: { ...base.account, employees: 401 } })).not.toBe(inputsHash(base));
  });
  it('keeps array order and writes dates as ISO strings', () => {
    expect(inputsHash({ ...base, signals: [{ id: 'b' }, { id: 'a' }] })).not.toBe(inputsHash({ ...base, signals: [{ id: 'a' }, { id: 'b' }] }));
    expect(inputsHash({ x: new Date('2026-10-01T00:00:00Z') })).toBe(inputsHash({ x: '2026-10-01T00:00:00.000Z' }));
  });
});
