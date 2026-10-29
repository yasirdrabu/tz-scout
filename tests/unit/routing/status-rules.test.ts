import { describe, expect, it } from 'vitest';
import { statusChangeProblems } from '@/modules/routing/domain/status-rules';

const reasonDefs = [
  { key: 'not_a_fit', appliesTo: 'both' as const, archivedAt: null },
  { key: 'duplicate', appliesTo: 'review' as const, archivedAt: null },
  { key: 'not_my_territory', appliesTo: 'assignment' as const, archivedAt: null },
  { key: 'wrong_timing', appliesTo: 'review' as const, archivedAt: new Date('2026-01-01') },
  { key: 'other', appliesTo: 'both' as const, archivedAt: null },
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

  it('refuses unknown, archived and assignment-only reasons', () => {
    expect(problems(declined, { reasonKey: 'nope' })).toEqual(['Pick a reason']);
    expect(problems(declined, { reasonKey: 'wrong_timing' })).toEqual(['Pick a reason']);
    expect(problems(declined, { reasonKey: 'not_my_territory' })).toEqual(['Pick a reason']);
  });

  it('needs a note for Other', () => {
    expect(problems(declined, { reasonKey: 'other' })).toEqual(['Add a note for Other.']);
    expect(problems(declined, { reasonKey: 'other', note: '   ' })).toEqual(['Add a note for Other.']);
    expect(problems(declined, { reasonKey: 'other', note: 'Out of scope' })).toEqual([]);
  });

  it('needs a note to send back', () => {
    expect(problems(sendBack)).toEqual(['Say what the source should fix']);
    expect(problems(sendBack, { note: ' ' })).toEqual(['Say what the source should fix']);
    expect(problems(sendBack, { note: 'Add the website' })).toEqual([]);
  });
});
