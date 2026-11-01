import { describe, expect, it } from 'vitest';
import { activityEntry, afterCursor, newestFirst, scoutEntries, undoReason } from '@/modules/crm/domain/activity';

const at = (d: string) => new Date(`2026-10-${d}T12:00:00Z`);
const handoff = (over: Partial<Parameters<typeof scoutEntries>[0]> = {}) => ({
  id: 'hof_1',
  status: 'completed',
  ownershipAction: 'assign',
  completedAt: at('10'),
  undone: null,
  ...over,
});
const names = { seller: 'Ash Patel', owner: 'Vijay Kumar', returnedTo: 'Rita Gomez' };

describe('activity entries', () => {
  it('words each CRM kind', () => {
    const kinds = ['email', 'reply', 'call', 'meeting', 'task_done'];
    expect(kinds.map((kind) => activityEntry({ id: `cac_${kind}`, kind, occurredAt: at('11') }).summary)).toEqual([
      'Email sent',
      'Reply received',
      'Call logged',
      'Meeting held',
      'Task done',
    ]);
  });

  it("words Scout's push with the seller as owner, or the owner it left", () => {
    expect(scoutEntries(handoff(), names)).toEqual([
      { id: 'hof_1:sent', kind: 'scout', at: at('10'), summary: 'Scout sent the account to HubSpot with Ash Patel as owner and logged the brief.' },
    ]);
    expect(scoutEntries(handoff({ ownershipAction: 'keep' }), names)[0]!.summary).toBe('Scout sent the account to HubSpot and left Vijay Kumar as owner.');
    expect(scoutEntries(handoff({ status: 'failed', completedAt: null }), names)).toEqual([]);
  });

  it('words an undo from what it did', () => {
    const undone = { tasksClosed: ['t1', 't2'], tasksLeftDone: [], ownerReturnedTo: 'own_9', noteExternalId: 'n1', ownerNote: null, at: at('12').toISOString() };
    const rows = scoutEntries(handoff({ undone }), names);
    expect(rows[1]).toEqual({ id: 'hof_1:undone', kind: 'scout', at: at('12'), summary: 'Scout took the account back: closed 2 tasks and gave the company back to Rita Gomez.' });
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
      { id: 'b', kind: 'email', at: at('10'), summary: '' },
      { id: 'a', kind: 'email', at: at('10'), summary: '' },
      { id: 'c', kind: 'email', at: at('12'), summary: '' },
    ].sort(newestFirst);
    expect(rows.map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(rows.filter(afterCursor({ at: at('10').toISOString(), id: 'b' })).map((r) => r.id)).toEqual(['a']);
    expect(rows.filter(afterCursor(null)).map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });
});
