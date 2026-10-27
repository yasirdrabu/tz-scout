import { describe, expect, it } from 'vitest';
import { SENIORITY_RANK, seniorityFromTitle } from '@/modules/accounts/domain/seniority';
import { pickPrimary } from '@/modules/accounts/domain/primary';

describe('seniorityFromTitle', () => {
  it('reads each category from a title', () => {
    expect(seniorityFromTitle('Owner')).toBe('owner');
    expect(seniorityFromTitle('Co-Founder')).toBe('founder');
    expect(seniorityFromTitle('Chief Operating Officer')).toBe('chief');
    expect(seniorityFromTitle('CIO')).toBe('chief');
    expect(seniorityFromTitle('President')).toBe('president');
    expect(seniorityFromTitle('Vice President of Sales')).toBe('vp');
    expect(seniorityFromTitle('SVP Engineering')).toBe('vp');
    expect(seniorityFromTitle('Head of Data')).toBe('head');
    expect(seniorityFromTitle('Director of IT')).toBe('director');
    expect(seniorityFromTitle('Project Manager')).toBe('manager');
    expect(seniorityFromTitle('Staff Accountant')).toBe('other');
    expect(seniorityFromTitle(null)).toBe('other');
  });
  it('keeps the v1 ordering: chief > president > vp > head > director > other', () => {
    const r = (t: string) => SENIORITY_RANK[seniorityFromTitle(t)];
    expect(r('CEO')).toBeGreaterThan(r('President'));
    expect(r('President')).toBeGreaterThan(r('Vice President'));
    expect(r('Vice President')).toBeGreaterThan(r('Head of Ops'));
    expect(r('Head of Ops')).toBeGreaterThan(r('Director'));
    expect(r('Director')).toBeGreaterThan(r('Analyst'));
  });
  it('treats vice president as vp, not president, and puts owner on top', () => {
    expect(seniorityFromTitle('Vice President')).toBe('vp');
    expect(SENIORITY_RANK.owner).toBeGreaterThan(SENIORITY_RANK.founder);
    expect(SENIORITY_RANK.manager).toBeGreaterThan(SENIORITY_RANK.other);
    expect(seniorityFromTitle('Product Owner')).not.toBe('owner');
  });
});

describe('pickPrimary', () => {
  const p = (id: string, title: string | null, emailStatus: string | null = null, pinnedPrimary = false) => ({
    id,
    title,
    seniority: null as string | null,
    emailStatus,
    pinnedPrimary,
  });
  it('returns null for no people', () => {
    expect(pickPrimary([], ['CIO'])).toBeNull();
  });
  it('a pinned person wins over everything', () => {
    const people = [p('a', 'CIO', 'verified'), p('b', 'Analyst', null, true)];
    expect(pickPrimary(people, ['CIO'])).toBe('b');
  });
  it('a target title beats seniority', () => {
    const people = [p('ceo', 'Chief Executive Officer'), p('cio', 'Director, CIO Office')];
    expect(pickPrimary(people, ['CIO'])).toBe('cio');
  });
  it('seniority beats a verified email', () => {
    const people = [p('dir', 'Director of IT', 'unverified'), p('mgr', 'IT Manager', 'verified')];
    expect(pickPrimary(people, [])).toBe('dir');
  });
  it('a verified email breaks a tie', () => {
    const people = [p('a', 'Director of IT', 'unverified'), p('b', 'Director of Ops', 'verified')];
    expect(pickPrimary(people, [])).toBe('b');
  });
  it('uses a stated seniority over the title', () => {
    const people = [{ ...p('a', 'Analyst'), seniority: 'owner' }, p('b', 'Director')];
    expect(pickPrimary(people, [])).toBe('a');
  });
});
