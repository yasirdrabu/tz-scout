import { describe, expect, it } from 'vitest';
import type { ScoringView } from '@/modules/accounts';
import { fit } from '@/modules/scoring/domain/fit';
import { toScoringAccount } from '@/modules/scoring/services/score';
import { account, offer, profile } from './fixtures';

const role = (key: string, origin: string) => ({ key, origin, label: key, setByName: null, setAt: null });
const view = (roles: ReturnType<typeof role>[]) =>
  ({ people: [{ title: 'Head of Engineering Ops', roles }], industry: 'Logistics', technologies: [] }) as unknown as ScoringView;
const buyer = (roles: ReturnType<typeof role>[]) =>
  fit(
    { ...account(), people: toScoringAccount(view(roles)).people },
    offer({ targetTitles: ['CEO'], targetBuyingRoles: ['technical_buyer'] }),
    profile,
  ).parts.find((p) => p.key === 'buyer')!;

describe('guessed roles in scoring', () => {
  it('a role guessed from a title does not count as a confirmed buying role', () => {
    expect(toScoringAccount(view([role('technical_buyer', 'guessed_from_title')])).people[0]!.roleKeys).toEqual([]);
    expect(buyer([role('technical_buyer', 'guessed_from_title')]).points).toBe(0);
  });
  it('confirming it (set_by_person) earns the Buyer contact point', () => {
    expect(buyer([role('technical_buyer', 'set_by_person')]).points).toBeGreaterThan(0);
    expect(buyer([role('technical_buyer', 'stated')]).points).toBeGreaterThan(0);
  });
});
