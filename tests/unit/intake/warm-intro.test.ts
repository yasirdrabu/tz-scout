import { describe, expect, it } from 'vitest';
import { isConfirmed, relationshipKey, strongest, warmIntroPoints } from '@/modules/intake/domain/warm-intro';

const defaults = {
  customer_referral: 15,
  partner_referral: 10,
  board_or_investor: 12,
  employee_network: 8,
  event_meeting: 5,
  other: 3,
};

describe('warmIntroPoints', () => {
  it('uses the relationship default', () => {
    expect(warmIntroPoints({ relationshipKey: 'employee_network', defaults, confirmed: true })).toBe(8);
  });
  it('lets an introducer rule beat the default', () => {
    expect(warmIntroPoints({ relationshipKey: 'employee_network', introducerRule: 12, defaults, confirmed: true })).toBe(12);
  });
  it('halves unconfirmed points and rounds down', () => {
    expect(warmIntroPoints({ relationshipKey: 'employee_network', defaults, confirmed: false })).toBe(4);
    expect(warmIntroPoints({ relationshipKey: 'event_meeting', defaults, confirmed: false })).toBe(2);
  });
  it('clamps to 0 to 20', () => {
    expect(warmIntroPoints({ relationshipKey: 'other', introducerRule: 40, defaults, confirmed: true })).toBe(20);
    expect(warmIntroPoints({ relationshipKey: 'other', introducerRule: -3, defaults, confirmed: true })).toBe(0);
    expect(warmIntroPoints({ relationshipKey: 'other', introducerRule: 40, defaults, confirmed: false })).toBe(10);
  });
  it('falls back to other for a key the tenant removed', () => {
    expect(warmIntroPoints({ relationshipKey: 'gone', defaults, confirmed: true })).toBe(3);
  });
});

describe('strongest', () => {
  it('picks the highest points, not the sum', () => {
    const b = { id: 'b', points: 12 };
    expect(strongest([{ id: 'a', points: 4 }, b, { id: 'c', points: 5 }])).toBe(b);
  });
  it('is null for none', () => {
    expect(strongest([])).toBeNull();
  });
});

describe('relationshipKey', () => {
  it.each([
    ['knows the CTC director from FPTA', 'employee_network'],
    ['met at FPTA 2026', 'event_meeting'],
    ['Customer', 'customer_referral'],
    ['one of our partners', 'partner_referral'],
    ['board member', 'board_or_investor'],
    ['investor intro', 'board_or_investor'],
    ['friend of a friend', 'employee_network'],
    ['former colleague', 'employee_network'],
    ['met at a conference', 'event_meeting'],
    ['employee_network', 'employee_network'],
    ['Event Meeting', 'event_meeting'],
    ['saw them on a podcast', null],
    ['', null],
  ])('%s gives %s', (text, expected) => {
    expect(relationshipKey(text)).toBe(expected);
  });
});

describe('isConfirmed', () => {
  it('trusts a person and a person key with warm_intro:declare', () => {
    expect(isConfirmed({ declaredBy: 'person' })).toBe(true);
    expect(isConfirmed({ declaredBy: 'person_key' })).toBe(true);
    expect(isConfirmed({ declaredBy: 'agent' })).toBe(false);
    expect(isConfirmed({ declaredBy: 'vendor' })).toBe(false);
  });
});
