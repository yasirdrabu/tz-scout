import { describe, expect, it } from 'vitest';
import { coverage } from '@/modules/accounts/domain/committee';

const ROLES = [
  { key: 'business_owner', label: 'Business owner', sort: 1, archived: false },
  { key: 'commercial_buyer', label: 'Commercial buyer', sort: 2, archived: false },
  { key: 'technical_buyer', label: 'Technical buyer', sort: 3, archived: false },
  { key: 'procurement', label: 'Procurement', sort: 6, archived: false },
];
const who = (id: string, roles: { key: string; origin: 'stated' | 'guessed_from_title' | 'set_by_person' }[]) => ({ id, name: id, title: null, roles });

describe('coverage', () => {
  it('uses the core three when there is no offer', () => {
    const c = coverage(ROLES, [], null);
    expect(c.roles.map((r) => [r.key, r.required, r.status])).toEqual([
      ['business_owner', true, 'gap'],
      ['commercial_buyer', true, 'gap'],
      ['technical_buyer', true, 'gap'],
    ]);
    expect(c.summary).toEqual({ covered: 0, required: 3, text: '0 of 3 roles covered' });
    expect(c.gaps).toEqual(['business_owner', 'commercial_buyer', 'technical_buyer']);
  });

  it('counts required roles only and keeps optional gaps out of the summary', () => {
    const c = coverage(ROLES, [who('ana', [{ key: 'technical_buyer', origin: 'stated' }])], {
      requiredRoles: ['technical_buyer'],
      optionalRoles: ['procurement'],
    });
    expect(c.summary).toEqual({ covered: 1, required: 1, text: '1 of 1 role covered' });
    expect(c.roles.map((r) => [r.key, r.required, r.status])).toEqual([
      ['technical_buyer', true, 'covered'],
      ['procurement', false, 'gap'],
    ]);
    expect(c.gaps).toEqual([]);
  });

  it('a guessed role only is guessed, not covered, and not a gap', () => {
    const c = coverage(ROLES, [who('ana', [{ key: 'technical_buyer', origin: 'guessed_from_title' }])], {
      requiredRoles: ['technical_buyer'],
      optionalRoles: [],
    });
    expect(c.roles[0]).toMatchObject({ status: 'guessed', people: [{ id: 'ana', origin: 'guessed_from_title' }] });
    expect(c.summary.covered).toBe(0);
    expect(c.gaps).toEqual([]);
  });

  it('a person-set role covers; a stated one wins over a guess', () => {
    const c = coverage(
      ROLES,
      [
        who('ana', [{ key: 'business_owner', origin: 'set_by_person' }]),
        who('ben', [{ key: 'technical_buyer', origin: 'guessed_from_title' }]),
        who('cy', [{ key: 'technical_buyer', origin: 'stated' }]),
      ],
      null,
    );
    expect(c.roles.map((r) => r.status)).toEqual(['covered', 'gap', 'covered']);
  });

  it('drops an archived role', () => {
    const roles = ROLES.map((r) => (r.key === 'technical_buyer' ? { ...r, archived: true } : r));
    const c = coverage(roles, [], { requiredRoles: ['technical_buyer', 'business_owner'], optionalRoles: [] });
    expect(c.roles.map((r) => r.key)).toEqual(['business_owner']);
    expect(c.summary.required).toBe(1);
  });

  it('shows a person holding two roles under both', () => {
    const c = coverage(
      ROLES,
      [who('ana', [{ key: 'business_owner', origin: 'stated' }, { key: 'technical_buyer', origin: 'stated' }])],
      null,
    );
    expect(c.roles.filter((r) => r.people.length).map((r) => r.key)).toEqual(['business_owner', 'technical_buyer']);
  });

  it('falls back to the core three for an offer with no required roles', () => {
    expect(coverage(ROLES, [], { requiredRoles: [], optionalRoles: ['procurement'] }).summary.required).toBe(3);
  });
});

describe('coverage fallback', () => {
  it('uses the core three when every required role of the offer is archived', () => {
    const roles = ROLES.map((r) => (r.key === 'technical_buyer' ? { ...r, archived: true } : r));
    const c = coverage(roles, [], { requiredRoles: ['technical_buyer'], optionalRoles: ['procurement'] });
    expect(c.summary.required).toBe(2);
    expect(c.summary.text).not.toContain('0 of 0');
    expect(c.roles.every((r) => r.required)).toBe(true);
  });
});
