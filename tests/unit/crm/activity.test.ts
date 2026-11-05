import { describe, expect, it } from 'vitest';
import { activityEntry, afterCursor, newestFirst, planStartEntry, scoutEntries, undoReason } from '@/modules/crm/domain/activity';

const at = (d: string) => new Date(`2026-10-${d}T12:00:00Z`);
const handoff = (over: Partial<Parameters<typeof scoutEntries>[0]> = {}) => ({
  id: 'hof_1',
  status: 'completed',
  ownershipAction: 'assign',
  completedAt: at('10'),
  undone: null,
  ...over,
});
const row = { id: 'cac_1', kind: 'email', occurredAt: at('11'), contacts: [], subject: null, startAt: null, endAt: null, status: null };
const ctx = { who: 'Ash Patel', now: new Date('2026-11-04T12:00:00Z'), timeZone: 'UTC' };
const people = ['Pat Lee', 'Sam Roe', 'Kim Fay', 'Lou Day'].map((name, i) => ({ externalId: `c${i}`, name }));
const names = { seller: 'Ash Patel', owner: 'Vijay Kumar', returnedTo: 'Rita Gomez' };

describe('activity entries', () => {
  it('words each CRM kind with nothing else known', () => {
    const kinds = ['email', 'reply', 'call', 'meeting', 'task_done'];
    expect(kinds.map((kind) => activityEntry({ ...row, id: `cac_${kind}`, kind }, ctx).summary)).toEqual([
      'Email sent',
      'Reply received',
      'Call logged',
      'Meeting held',
      'Task done',
    ]);
  });

  it('names the people on a row as A, A and B, or A, B and n others', () => {
    const sent = (n: number) => activityEntry({ ...row, kind: 'email', contacts: people.slice(0, n) }, ctx).summary;
    expect(sent(1)).toBe('Sent an email to Pat Lee');
    expect(sent(2)).toBe('Sent an email to Pat Lee and Sam Roe');
    expect(sent(3)).toBe('Sent an email to Pat Lee, Sam Roe and 1 other');
    expect(sent(4)).toBe('Sent an email to Pat Lee, Sam Roe and 2 others');
    expect(activityEntry({ ...row, kind: 'email', contacts: [{ externalId: 'x', name: null }] }, ctx).summary).toBe('Email sent');
  });

  it('words an email and a reply, who sent them, and without a subject or contacts', () => {
    const email = { ...row, kind: 'email', subject: 'Pilot scope', contacts: people.slice(0, 2) };
    expect(activityEntry(email, ctx)).toMatchObject({ who: 'Ash Patel', actor: 'person', summary: 'Sent "Pilot scope" to Pat Lee and Sam Roe' });
    expect(activityEntry({ ...email, subject: null }, ctx).summary).toBe('Sent an email to Pat Lee and Sam Roe');
    expect(activityEntry({ ...email, contacts: [] }, ctx).summary).toBe('Sent "Pilot scope"');
    expect(activityEntry(email, { ...ctx, who: null }).who).toBeNull();
    const reply = { ...row, kind: 'reply', subject: 'Re: Pilot scope', contacts: people.slice(0, 2) };
    expect(activityEntry(reply, ctx)).toMatchObject({ who: 'Pat Lee', actor: 'contact', summary: 'Replied: "Re: Pilot scope"' });
    expect(activityEntry({ ...reply, subject: null }, ctx).summary).toBe('Replied');
    expect(activityEntry({ ...reply, contacts: [] }, ctx)).toMatchObject({ who: null, actor: 'contact', summary: 'Replied: "Re: Pilot scope"' });
  });

  it('words a call', () => {
    expect(activityEntry({ ...row, kind: 'call', contacts: people.slice(0, 1) }, ctx)).toMatchObject({ who: 'Ash Patel', actor: 'person', summary: 'Call with Pat Lee' });
    expect(activityEntry({ ...row, kind: 'call' }, ctx).summary).toBe('Call logged');
  });

  it('words a held meeting with its duration only when start and end are known', () => {
    const held = { ...row, kind: 'meeting', status: 'held', startAt: at('11'), endAt: new Date(at('11').getTime() + 45 * 60_000), contacts: people.slice(0, 1) };
    expect(activityEntry(held, ctx).summary).toBe('Meeting held with Pat Lee, 45 minutes');
    expect(activityEntry({ ...held, endAt: null }, ctx).summary).toBe('Meeting held with Pat Lee');
    expect(activityEntry({ ...held, startAt: null }, ctx).summary).toBe('Meeting held with Pat Lee');
    expect(activityEntry({ ...held, contacts: [] }, ctx).summary).toBe('Meeting held, 45 minutes');
    // Scheduled and over counts as held.
    expect(activityEntry({ ...held, status: 'scheduled' }, ctx).summary).toBe('Meeting held with Pat Lee, 45 minutes');
  });

  it('words a booked, cancelled and missed meeting, dated by its start', () => {
    const start = new Date('2026-11-18T15:00:00Z');
    const booked = { ...row, kind: 'meeting', status: 'scheduled', occurredAt: at('11'), startAt: start, endAt: new Date(start.getTime() + 3_600_000), contacts: people.slice(0, 1) };
    expect(activityEntry(booked, ctx)).toMatchObject({ summary: 'Meeting booked for Nov 18 with Pat Lee', at: start });
    expect(activityEntry({ ...booked, contacts: [] }, ctx).summary).toBe('Meeting booked for Nov 18');
    expect(activityEntry({ ...booked, status: 'cancelled' }, ctx).summary).toBe('Meeting cancelled');
    expect(activityEntry({ ...booked, status: 'no_show' }, ctx).summary).toBe('Meeting missed');
  });

  it("words the start of a plan as Scout's row", () => {
    expect(planStartEntry({ planId: 'apl_1', playbookName: 'Logistics intro', startedAt: at('13').toISOString() })).toEqual({
      id: 'apl_1:started',
      kind: 'scout',
      at: at('13'),
      who: 'Scout',
      actor: 'scout',
      summary: 'Started the Logistics intro playbook',
    });
  });

  it("words Scout's push with the seller as owner, or the owner it left", () => {
    expect(scoutEntries(handoff(), names)).toEqual([
      { id: 'hof_1:sent', kind: 'scout', at: at('10'), who: 'Scout', actor: 'scout', summary: 'Scout sent the account to HubSpot with Ash Patel as owner and logged the brief.' },
    ]);
    expect(scoutEntries(handoff({ ownershipAction: 'keep' }), names)[0]!.summary).toBe('Scout sent the account to HubSpot and left Vijay Kumar as owner.');
    expect(scoutEntries(handoff({ status: 'failed', completedAt: null }), names)).toEqual([]);
  });

  it('words an undo from what it did', () => {
    const undone = { tasksClosed: ['t1', 't2'], tasksLeftDone: [], ownerReturnedTo: 'own_9', noteExternalId: 'n1', ownerNote: null, at: at('12').toISOString() };
    const rows = scoutEntries(handoff({ undone }), names);
    expect(rows[1]).toEqual({ id: 'hof_1:undone', kind: 'scout', at: at('12'), who: 'Scout', actor: 'scout', summary: 'Scout took the account back: closed 2 tasks and gave the company back to Rita Gomez.' });
    expect(undoReason({ ...undone, tasksClosed: [], ownerReturnedTo: null }, null)).toBe('nothing else had to change in HubSpot');
    expect(undoReason({ ...undone, failed: true, reason: 'HubSpot was busy and every retry failed.' }, null)).toBe('HubSpot was busy and every retry failed');
  });

  it('words an undo with its cause: who declined it and why, or who withdrew it', () => {
    const base = { tasksClosed: ['t1', 't2'], tasksLeftDone: [], ownerReturnedTo: 'own_9', noteExternalId: 'n1', ownerNote: null, at: at('12').toISOString() };
    const declined = { ...base, cause: { kind: 'declined' as const, reasonLabel: 'Not my territory', byName: 'Ash' } };
    expect(scoutEntries(handoff({ undone: declined }), names)[1]!.summary).toBe(
      'Scout took the account back: Ash declined it (Not my territory). Closed 2 tasks and gave the company back to Rita Gomez.',
    );
    const withdrawn = { ...base, tasksClosed: [], ownerReturnedTo: null, cause: { kind: 'withdrawn' as const, reasonLabel: null, byName: 'Zach Wiant' } };
    expect(scoutEntries(handoff({ undone: withdrawn }), names)[1]!.summary).toBe(
      'Scout took the account back: Zach Wiant withdrew the assignment. Nothing else had to change in HubSpot.',
    );
    const noReason = { ...base, cause: { kind: 'declined' as const, reasonLabel: null, byName: null } };
    expect(scoutEntries(handoff({ undone: noReason }), names)[1]!.summary).toBe(
      'Scout took the account back: the seller declined it. Closed 2 tasks and gave the company back to Rita Gomez.',
    );
  });

  it('sorts newest first and pages after a cursor', () => {
    const rows = [
      { id: 'b', kind: 'email', at: at('10'), who: null, actor: 'person' as const, summary: '' },
      { id: 'a', kind: 'email', at: at('10'), who: null, actor: 'person' as const, summary: '' },
      { id: 'c', kind: 'email', at: at('12'), who: null, actor: 'person' as const, summary: '' },
    ].sort(newestFirst);
    expect(rows.map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(rows.filter(afterCursor({ at: at('10').toISOString(), id: 'b' })).map((r) => r.id)).toEqual(['a']);
    expect(rows.filter(afterCursor(null)).map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });
});
