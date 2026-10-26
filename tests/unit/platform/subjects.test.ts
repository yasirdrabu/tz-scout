import { describe, expect, it } from 'vitest';
import { MODULE_SCHEMAS, eventSubject, jobSubject } from '@/platform/nats/subjects';

describe('subjects', () => {
  it('builds event subjects', () => {
    expect(eventSubject('t_A', 'tenancy.member.added')).toBe('scout.t_A.tenancy.member.added');
  });
  it('rejects reserved tokens and unknown modules', () => {
    expect(() => eventSubject('t_A', 'jobs.x.y')).toThrow(/reserved/);
    expect(() => eventSubject('t_A', 'webhooks.deliver')).toThrow(/reserved/);
    expect(() => eventSubject('t_A', 'nope.x.y')).toThrow(/module schema/);
  });
  it('rejects wildcards and spaces', () => {
    expect(() => eventSubject('t_*', 'tenancy.member.added')).toThrow();
    expect(() => eventSubject('t_A', 'tenancy.member.>')).toThrow();
  });
  it('builds job subjects', () => {
    expect(jobSubject('t_A', 'scoring.rescore')).toBe('scout.t_A.jobs.scoring.rescore');
  });
  it('lists the 14 module schemas', () => {
    expect(MODULE_SCHEMAS).toHaveLength(14);
  });
});
