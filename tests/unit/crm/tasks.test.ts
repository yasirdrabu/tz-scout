import { describe, expect, it } from 'vitest';
import { buildTasks } from '@/modules/crm/domain/tasks';

const base = {
  account: { name: 'Acme' },
  buyer: { name: 'Dana Lee', title: 'CTO', email: 'dana@acme.com' },
  offerName: 'AI Audit',
  followUpDays: [3, 7, 14],
  handoffAt: new Date('2026-10-30T18:00:00Z'), // Friday 14:00 in New York
  timezone: 'America/New_York',
  pkg: null,
};

describe('buildTasks', () => {
  it('builds the first touch due on the handoff day', () => {
    const { firstTouch } = buildTasks(base);
    expect(firstTouch.subject).toBe('First touch: Dana Lee at Acme');
    expect(firstTouch.body).toBe('Start with Dana Lee, CTO (dana@acme.com).');
    expect(firstTouch.dueAt).toBe('2026-10-30T21:00:00.000Z'); // 17:00 EDT
  });

  it('says so when there is no buyer', () => {
    const { firstTouch, followUps } = buildTasks({ ...base, buyer: null });
    expect(firstTouch.subject).toBe('First touch: Acme');
    expect(firstTouch.body).toBe('No buyer contact yet; the note lists who to look for.');
    expect(followUps[0]!.subject).toBe('Follow-up 1 of 3 (day 3): email Acme');
  });

  it('builds follow-ups for days 3, 7 and 14 in the tenant timezone across the DST change', () => {
    const { followUps } = buildTasks(base);
    expect(followUps.map((f) => f.subject)).toEqual([
      'Follow-up 1 of 3 (day 3): email Dana Lee',
      'Follow-up 2 of 3 (day 7): email Dana Lee',
      'Follow-up 3 of 3 (day 14): email Dana Lee',
    ]);
    expect(followUps[0]!.body).toBe('No follow-up email written yet. Write to Dana Lee about AI Audit.');
    expect(followUps.map((f) => f.dueAt)).toEqual(['2026-11-02T22:00:00.000Z', '2026-11-06T22:00:00.000Z', '2026-11-13T22:00:00.000Z']);
  });

  it('uses the package tasks instead of the defaults', () => {
    const { firstTouch, followUps } = buildTasks({
      ...base,
      pkg: { firstTouch: { subject: 'Call Dana', body: 'Mention the audit' }, followUps: [{ day: 2, subject: 'Nudge', body: 'Short email' }] },
    });
    expect(firstTouch).toEqual({ subject: 'Call Dana', body: 'Mention the audit', dueAt: '2026-10-30T21:00:00.000Z' });
    expect(followUps).toEqual([{ day: 2, subject: 'Nudge', body: 'Short email', dueAt: '2026-11-01T22:00:00.000Z' }]);
  });
});
