import { describe, expect, it } from 'vitest';
import { followThroughCounts } from '@/modules/crm/domain/follow-through';

const now = new Date('2026-10-30T12:00:00Z');
const latest = (o: Partial<Parameters<typeof followThroughCounts>[0]> = {}) => ({
  counts: { emails: 0, calls: 0, meetings: 0, deals: 0, openDeals: 0 },
  tasks: [] as { status: string; due: string | null }[],
  stage: null,
  ownerExternalId: null,
  lastActivityAt: null,
  ...o,
});

describe('followThroughCounts', () => {
  it('counts since the handoff and never below 0', () => {
    const r = followThroughCounts(
      latest({ counts: { emails: 5, calls: 3, meetings: 1, deals: 2, openDeals: 1 }, stage: 'lead', ownerExternalId: 'o1', lastActivityAt: new Date('2026-10-29T00:00:00Z') }),
      { emails: 2, calls: 5, meetings: 1, deals: 1 },
      now,
    );
    expect(r).toMatchObject({ emails: 3, calls: 0, meetings: 0, deals: 1, openDeals: 1, stage: 'lead', ownerExternalId: 'o1' });
    expect(r.lastActivityAt).toEqual(new Date('2026-10-29T00:00:00Z'));
  });

  it('counts tasks done, total and overdue at now', () => {
    const r = followThroughCounts(
      latest({
        tasks: [
          { status: 'completed', due: '2026-10-01T00:00:00Z' },
          { status: 'open', due: '2026-10-29T00:00:00Z' },
          { status: 'open', due: '2026-11-02T00:00:00Z' },
          { status: 'open', due: null },
        ],
      }),
      {},
      now,
    );
    expect(r).toMatchObject({ tasksDone: 1, tasksTotal: 4, overdue: 1 });
  });
});
