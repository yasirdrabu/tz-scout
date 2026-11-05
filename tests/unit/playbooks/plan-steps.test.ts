import { describe, expect, it } from 'vitest';
import { insertOrder, missingRoles, type PlanPerson } from '@/modules/playbooks/domain/plan';

const person = (id: string, roles: PlanPerson['roles']): PlanPerson => ({ id, firstName: id, roles });

describe('insertOrder', () => {
  const steps = [
    { order: 1, day: 0 },
    { order: 2, day: 3 },
    { order: 3, day: 3 },
    { order: 4, day: 7 },
  ];

  it('is 1 for an empty plan and for a day before every step', () => {
    expect(insertOrder([], 5)).toBe(1);
    expect(insertOrder(steps, -1)).toBe(1);
  });

  it('goes right after the last step on or before the day', () => {
    expect(insertOrder(steps, 0)).toBe(2);
    expect(insertOrder(steps, 2)).toBe(2);
    expect(insertOrder(steps, 3)).toBe(4);
    expect(insertOrder(steps, 5)).toBe(4);
  });

  it('goes last for a day past every step', () => {
    expect(insertOrder(steps, 7)).toBe(5);
    expect(insertOrder(steps, 100)).toBe(5);
  });

  it('does not depend on the order the steps are listed in', () => {
    expect(insertOrder([...steps].reverse(), 3)).toBe(4);
  });
});

describe('missingRoles', () => {
  it('lists the target roles nobody holds, in target order', () => {
    const people = [person('a', [{ key: 'business_owner', origin: 'stated' }])];
    expect(missingRoles(people, ['technical_buyer', 'business_owner', 'procurement'])).toEqual(['technical_buyer', 'procurement']);
  });

  it('counts stated and person-set roles but not a guess from the title', () => {
    const people = [person('a', [{ key: 'cio', origin: 'guessed_from_title' }]), person('b', [{ key: 'cfo', origin: 'set_by_person' }])];
    expect(missingRoles(people, ['cio', 'cfo'])).toEqual(['cio']);
  });

  it('is empty with no target roles and everything with no people', () => {
    expect(missingRoles([person('a', [{ key: 'x', origin: 'stated' }])], [])).toEqual([]);
    expect(missingRoles([], ['x', 'y'])).toEqual(['x', 'y']);
  });
});
