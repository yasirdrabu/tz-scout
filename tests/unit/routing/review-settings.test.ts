import { describe, expect, it } from 'vitest';
import { keyFor, reasonEditProblems, statusEditProblems, type ReasonEdit, type ReasonRow, type StatusEdit, type StatusRow } from '@/modules/routing/domain/review-settings';

const row = (key: string, label: string, over: Partial<StatusRow> = {}): StatusRow => ({
  key,
  label,
  countsAsReviewed: false,
  isDeclined: false,
  isInitial: false,
  returnsToSource: false,
  archivedAt: null,
  ...over,
});
const statuses = [
  row('unvetted', 'Ready for review', { isInitial: true }),
  row('needs_review', 'In review'),
  row('reviewed', 'Approved', { countsAsReviewed: true }),
  row('declined', 'Not pursued', { countsAsReviewed: true, isDeclined: true }),
  row('sent_back', 'Sent back to source', { countsAsReviewed: true, returnsToSource: true }),
];
const edit = (s: StatusRow, over: Partial<StatusEdit> = {}): StatusEdit => ({ key: s.key, label: s.label, color: 'gray', setBy: 'reviewer', flagAfterHours: null, ...over });
const all = (over: Record<string, Partial<StatusEdit>> = {}) => statuses.map((s) => edit(s, over[s.key]));

describe('statusEditProblems', () => {
  it('accepts the list as it is, renamed, recolored and reordered', () => {
    expect(statusEditProblems(statuses, all())).toEqual([]);
    expect(statusEditProblems(statuses, all({ unvetted: { label: 'New', color: 'plum', flagAfterHours: 48 } }).reverse())).toEqual([]);
  });

  it('adds a status without a key, and archives one Scout does not need', () => {
    expect(statusEditProblems(statuses, [...all({ needs_review: { archived: true } }), { label: 'Waiting on legal', color: 'amber', setBy: 'reviewer', flagAfterHours: 72 }])).toEqual([]);
  });

  it('refuses archiving a status Scout needs, and removing any status', () => {
    expect(statusEditProblems(statuses, all({ sent_back: { archived: true } }))).toEqual([{ path: 'statuses.4.archived', message: "Sent back to source can't be archived. Scout needs it." }]);
    expect(statusEditProblems(statuses, all().slice(0, 4))).toEqual([{ path: 'statuses', message: 'Archive Sent back to source instead of removing it.' }]);
  });

  it('checks names, colors, who sets it and flag after', () => {
    const problems = statusEditProblems(statuses, [
      ...all({ unvetted: { label: ' ' }, needs_review: { color: 'pink', setBy: 'robot' }, reviewed: { flagAfterHours: 24 } }),
      { label: 'in REVIEW', color: 'gray', setBy: 'reviewer', flagAfterHours: 0 },
    ]);
    expect(problems).toEqual([
      { path: 'statuses.0.label', message: 'Give it a name.' },
      { path: 'statuses.1.color', message: 'Pick plum, amber, green, red or gray.' },
      { path: 'statuses.1.set_by', message: 'Pick Scout or a reviewer.' },
      { path: 'statuses.2.flag_after_hours', message: 'Approved is final, so it is never flagged.' },
      { path: 'statuses.5.flag_after_hours', message: 'Flag after 1 to 720 hours, or never.' },
      { path: 'statuses.5.label', message: 'Two statuses are called in REVIEW.' },
    ]);
  });

  it('refuses unknown and repeated keys, and an empty list', () => {
    expect(statusEditProblems(statuses, [...all(), { key: 'nope', label: 'X', color: 'gray', setBy: 'reviewer', flagAfterHours: null }])[0]?.path).toBe('statuses.5.key');
    expect(statusEditProblems(statuses, [...all(), edit(statuses[1]!, { label: 'Again' })])[0]).toEqual({ path: 'statuses.5.key', message: 'Each one can appear once.' });
    expect(statusEditProblems(statuses, [])).toEqual([{ path: 'statuses', message: 'Keep 1 to 30 statuses.' }]);
  });
});

const reasons: ReasonRow[] = [
  { key: 'not_a_fit', label: 'Not a fit', appliesTo: 'both', archivedAt: null },
  { key: 'wrong_practice', label: 'Wrong practice', appliesTo: 'send_back', archivedAt: null },
];
const r = (over: Partial<ReasonEdit>): ReasonEdit => ({ label: 'X', appliesTo: 'review', noteRequired: false, ...over });

describe('reasonEditProblems', () => {
  it('accepts the lists with a new reason and a note-required switch', () => {
    expect(reasonEditProblems(reasons, [r({ key: 'not_a_fit', label: 'Not a fit', appliesTo: 'both' }), r({ key: 'wrong_practice', label: 'Wrong practice', appliesTo: 'send_back', noteRequired: true }), r({ label: 'Already a customer', appliesTo: 'send_back' })])).toEqual([]);
  });

  it('keeps at least one reason in each list', () => {
    expect(reasonEditProblems(reasons, [r({ key: 'not_a_fit', label: 'Not a fit', appliesTo: 'review' }), r({ key: 'wrong_practice', label: 'Wrong practice', appliesTo: 'send_back', archived: true })])).toEqual([
      { path: 'reasons', message: 'Keep at least one send-back reason.' },
      { path: 'reasons', message: 'Keep at least one decline reason for AEs.' },
    ]);
  });

  it('refuses removing a reason, a repeated name in one list and an unknown list', () => {
    const problems = reasonEditProblems(reasons, [r({ key: 'not_a_fit', label: 'Not a fit', appliesTo: 'both' }), r({ label: 'not a fit', appliesTo: 'both' }), r({ label: 'Y', appliesTo: 'elsewhere' })]);
    expect(problems).toEqual([
      { path: 'reasons', message: 'Archive Wrong practice instead of removing it.' },
      { path: 'reasons.1.label', message: 'not a fit is in this list twice.' },
      { path: 'reasons.2.applies_to', message: 'Pick review, assignment, both or send_back.' },
      { path: 'reasons', message: 'Keep at least one send-back reason.' },
    ]);
  });
});

describe('keyFor', () => {
  it('makes a key from the label that is not taken', () => {
    expect(keyFor('Waiting on legal!', new Set())).toBe('waiting_on_legal');
    expect(keyFor('In review', new Set(['in_review', 'in_review_2']))).toBe('in_review_3');
    expect(keyFor('***', new Set())).toBe('item');
  });
});
