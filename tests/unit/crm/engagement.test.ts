import { describe, expect, it } from 'vitest';
import { meetingHeld, nextMeeting, personStates, type EngagementActivity } from '@/modules/crm/domain/engagement';

const now = new Date('2026-11-10T12:00:00Z');
const day = (d: number) => new Date(`2026-11-${String(d).padStart(2, '0')}T15:00:00Z`);
let n = 0;
const act = (over: Partial<EngagementActivity>): EngagementActivity => ({
  externalId: `x-${++n}`,
  kind: 'meeting',
  occurredAt: over.startAt ?? day(1),
  contacts: [],
  subject: null,
  startAt: null,
  endAt: null,
  status: null,
  ...over,
});
const ct = (externalId: string, name: string | null = null) => ({ externalId, name });

describe('meetingHeld (Ruling 2)', () => {
  it('status held is held', () => {
    expect(meetingHeld(act({ status: 'held', startAt: day(20) }), now)).toBe(true);
  });

  it('scheduled with an end in the past is held', () => {
    expect(meetingHeld(act({ status: 'scheduled', startAt: day(9), endAt: day(9) }), now)).toBe(true);
  });

  it('scheduled in the future is not held', () => {
    expect(meetingHeld(act({ status: 'scheduled', startAt: day(12), endAt: day(12) }), now)).toBe(false);
  });

  it('cancelled in the past is not held, nor is a no-show or an email', () => {
    expect(meetingHeld(act({ status: 'cancelled', startAt: day(2), endAt: day(2) }), now)).toBe(false);
    expect(meetingHeld(act({ status: 'no_show', startAt: day(2), endAt: day(2) }), now)).toBe(false);
    expect(meetingHeld(act({ kind: 'email', occurredAt: day(2) }), now)).toBe(false);
  });

  it('a stored meeting with no status or times counts by when it happened', () => {
    expect(meetingHeld(act({ occurredAt: day(2) }), now)).toBe(true);
    expect(meetingHeld(act({ occurredAt: day(20) }), now)).toBe(false);
  });
});

describe('nextMeeting (Ruling 1)', () => {
  it('is the earliest future meeting that is not cancelled', () => {
    const rows = [
      act({ status: 'scheduled', startAt: day(20), subject: 'Later' }),
      act({ status: 'cancelled', startAt: day(11), subject: 'Cancelled' }),
      act({ status: 'no_show', startAt: day(11), subject: 'Missed' }),
      act({ status: 'scheduled', startAt: day(15), subject: 'Scoping call' }),
      act({ status: 'held', startAt: day(5), subject: 'Past' }),
    ];
    expect(nextMeeting(rows, now)).toEqual({ at: day(15).toISOString(), with: 'Scoping call' });
  });

  it('the title wins over the attendees', () => {
    expect(nextMeeting([act({ status: 'scheduled', startAt: day(15), subject: 'Transit Operations', contacts: [ct('c1', 'Pat Lee')] })], now)?.with).toBe(
      'Transit Operations',
    );
  });

  it('with no title it is the first attendee plus the others', () => {
    const contacts = [ct('c1', 'Pat Lee'), ct('c2', 'Sam Roe'), ct('c3', null)];
    expect(nextMeeting([act({ status: 'scheduled', startAt: day(15), contacts })], now)).toEqual({ at: day(15).toISOString(), with: 'Pat Lee +2' });
    expect(nextMeeting([act({ status: 'scheduled', startAt: day(15), contacts: [ct('c1', 'Pat Lee')] })], now)?.with).toBe('Pat Lee');
  });

  it('takes the first attendee with a name, and is with null when none has one', () => {
    expect(nextMeeting([act({ status: 'scheduled', startAt: day(15), contacts: [ct('c1'), ct('c2', 'Ben Ray')] })], now)?.with).toBe('Ben Ray +1');
    expect(nextMeeting([act({ status: 'scheduled', startAt: day(15), contacts: [ct('c1'), ct('c2')] })], now)).toEqual({ at: day(15).toISOString(), with: null });
    expect(nextMeeting([act({ status: 'scheduled', startAt: day(15) })], now)?.with).toBeNull();
  });

  it('is null when no meeting is coming up', () => {
    expect(nextMeeting([act({ status: 'held', startAt: day(5) }), act({ kind: 'email', occurredAt: day(20) })], now)).toBeNull();
    expect(nextMeeting([], now)).toBeNull();
  });
});

describe('personStates (Ruling 6)', () => {
  const contacts = new Map([
    ['per_ana', ['c-ana']],
    ['per_ben', ['c-ben']],
    ['per_cy', ['c-cy']],
    ['per_dee', []],
  ]);

  it('met beats replied beats emailed; a call counts as emailed; no link is not contacted', () => {
    const rows = [
      act({ kind: 'email', occurredAt: day(1), contacts: [ct('c-ana'), ct('c-ben')] }),
      act({ kind: 'reply', occurredAt: day(3), contacts: [ct('c-ana')] }),
      act({ status: 'held', startAt: day(4), endAt: day(4), contacts: [ct('c-ana')] }),
      act({ status: 'held', startAt: day(6), endAt: day(6), contacts: [ct('c-ana')] }),
      act({ status: 'cancelled', startAt: day(7), contacts: [ct('c-ben')] }),
      act({ kind: 'reply', occurredAt: day(2), contacts: [ct('c-ben')] }),
      act({ kind: 'reply', occurredAt: day(5), contacts: [ct('c-ben')] }),
      act({ kind: 'call', occurredAt: day(8), contacts: [ct('c-cy')] }),
      act({ kind: 'email', occurredAt: day(8), contacts: [] }),
    ];
    expect(personStates(rows, contacts, now)).toEqual([
      { personId: 'per_ana', state: 'met', at: day(6).toISOString() },
      { personId: 'per_ben', state: 'replied', at: day(5).toISOString() },
      { personId: 'per_cy', state: 'emailed', at: day(8).toISOString() },
      { personId: 'per_dee', state: 'not_contacted', at: null },
    ]);
  });

  it('a meeting coming up is meeting set at its start, the earliest one; it beats emailed, not replied', () => {
    const rows = [
      act({ status: 'scheduled', startAt: day(20), contacts: [ct('c-ana'), ct('c-ben')] }),
      act({ status: 'scheduled', startAt: day(15), contacts: [ct('c-ana')] }),
      act({ kind: 'email', occurredAt: day(8), contacts: [ct('c-ana'), ct('c-cy')] }),
      act({ kind: 'reply', occurredAt: day(9), contacts: [ct('c-ben')] }),
    ];
    expect(personStates(rows, contacts, now).slice(0, 3)).toEqual([
      { personId: 'per_ana', state: 'meeting_set', at: day(15).toISOString() },
      { personId: 'per_ben', state: 'replied', at: day(9).toISOString() },
      { personId: 'per_cy', state: 'emailed', at: day(8).toISOString() },
    ]);
  });

  it('a cancelled or missed meeting coming up is not meeting set', () => {
    const rows = [act({ status: 'cancelled', startAt: day(20), contacts: [ct('c-ana')] }), act({ status: 'no_show', startAt: day(21), contacts: [ct('c-ana')] })];
    expect(personStates(rows, new Map([['per_ana', ['c-ana']]]), now)).toEqual([{ personId: 'per_ana', state: 'not_contacted', at: null }]);
  });
});
