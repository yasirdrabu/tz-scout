import { describe, expect, it } from 'vitest';
import { declineProblems, statusChangeProblems, type ReasonDef } from '@/modules/routing/domain/status-rules';

const reason = (key: string, appliesTo: ReasonDef['appliesTo'], over: Partial<ReasonDef> = {}): ReasonDef => ({
  key,
  label: key === 'other' ? 'Other' : key,
  appliesTo,
  noteRequired: false,
  archivedAt: null,
  ...over,
});
const reasonDefs = [
  reason('not_a_fit', 'both'),
  reason('duplicate', 'review'),
  reason('not_my_territory', 'assignment'),
  reason('wrong_timing', 'review', { archivedAt: new Date('2026-01-01') }),
  reason('other', 'both', { noteRequired: true }),
  reason('wrong_practice', 'send_back'),
  reason('bad_contact', 'send_back', { noteRequired: true }),
];
const plain = { isDeclined: false, returnsToSource: false };
const declined = { isDeclined: true, returnsToSource: false };
const sendBack = { isDeclined: false, returnsToSource: true };

const problems = (def: typeof plain, over: { note?: string | null; reasonKey?: string | null } = {}) =>
  statusChangeProblems(def, { note: null, reasonKey: null, reasonDefs, ...over });

describe('statusChangeProblems', () => {
  it('has nothing to say about a plain status', () => {
    expect(problems(plain)).toEqual([]);
  });

  it('asks for a reason when declining', () => {
    expect(problems(declined)).toEqual(['Pick a reason']);
    expect(problems(declined, { reasonKey: '  ' })).toEqual(['Pick a reason']);
  });

  it('accepts a review reason, including ones that apply to both', () => {
    expect(problems(declined, { reasonKey: 'duplicate' })).toEqual([]);
    expect(problems(declined, { reasonKey: 'not_a_fit' })).toEqual([]);
  });

  it('refuses unknown, archived, assignment-only and send-back reasons for a decline', () => {
    for (const reasonKey of ['nope', 'wrong_timing', 'not_my_territory', 'wrong_practice']) expect(problems(declined, { reasonKey })).toEqual(['Pick a reason']);
  });

  it('needs a note only for a reason marked note required', () => {
    expect(problems(declined, { reasonKey: 'other' })).toEqual(['Add a note for Other.']);
    expect(problems(declined, { reasonKey: 'other', note: '   ' })).toEqual(['Add a note for Other.']);
    expect(problems(declined, { reasonKey: 'other', note: 'Out of scope' })).toEqual([]);
  });

  it('a send back needs a send-back reason (Decision 1)', () => {
    expect(problems(sendBack)).toEqual(['Pick a reason']);
    expect(problems(sendBack, { note: 'Add the website' })).toEqual(['Pick a reason']);
    expect(problems(sendBack, { reasonKey: 'duplicate' })).toEqual(['Pick a reason']);
    expect(problems(sendBack, { reasonKey: 'other' })).toEqual(['Pick a reason']);
  });

  it('a send back takes the note as optional unless the reason needs one', () => {
    expect(problems(sendBack, { reasonKey: 'wrong_practice' })).toEqual([]);
    expect(problems(sendBack, { reasonKey: 'bad_contact' })).toEqual(['Say what the source should fix.']);
    expect(problems(sendBack, { reasonKey: 'bad_contact', note: 'The email bounces' })).toEqual([]);
  });
});

describe('declineProblems', () => {
  it('needs a reason, and a note when the reason says so', () => {
    expect(declineProblems(undefined, 'x')).toEqual(['Pick a reason']);
    expect(declineProblems({ label: 'Not my territory', noteRequired: false }, null)).toEqual([]);
    expect(declineProblems({ label: 'Other', noteRequired: true }, ' ')).toEqual(['Add a note for Other.']);
    expect(declineProblems({ label: 'Other', noteRequired: true }, 'Busy')).toEqual([]);
  });
});
