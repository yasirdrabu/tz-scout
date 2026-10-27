import { describe, expect, it } from 'vitest';
import { cleanMapping, isAllowedTarget, synonymMapping } from '@/modules/intake/import/synonyms';

const targetOf = (headers: string[], header: string) =>
  synonymMapping({ headers, sampleRows: [] }).columns.find((c) => c.header === header)?.target;

describe('synonymMapping', () => {
  it('maps the common lead-sheet headers', () => {
    const headers = ['Website', 'Company', 'First Name', 'Email', 'Job Title'];
    expect(synonymMapping({ headers, sampleRows: [] }).columns.map((c) => c.target)).toEqual([
      'account.website',
      'account.name',
      'people[0].first_name',
      'people[0].email',
      'people[0].title',
    ]);
  });

  it('matches a header that contains an alias, and leaves unknown headers unmapped', () => {
    expect(targetOf(['Company Website URL', 'Favourite colour'], 'Company Website URL')).toBe('account.website');
    expect(targetOf(['Company Website URL', 'Favourite colour'], 'Favourite colour')).toBeNull();
  });

  it('uses each target once', () => {
    const cols = synonymMapping({ headers: ['Email', 'Work Email'], sampleRows: [] }).columns;
    expect(cols.map((c) => c.target)).toEqual(['people[0].email', null]);
  });

  it('knows which targets are allowed', () => {
    for (const t of ['account.name', 'people[2].email', 'signals[].title', 'research.hook', 'account.custom_fields.region_tag']) {
      expect(isAllowedTarget(t)).toBe(true);
    }
    for (const t of ['account.password', 'people.email', 'research.', 'tenant_id', '']) expect(isAllowedTarget(t)).toBe(false);
  });
});

describe('cleanMapping', () => {
  const col = (header: string, target: string | null, confidence: number) => ({ header, target, confidence, reason: 'r' });

  it('keeps only the highest confidence column per target, first header on a tie', () => {
    const out = cleanMapping({
      columns: [col('Company', 'account.name', 0.8), col('Account', 'account.name', 0.95), col('A', 'account.city', 0.7), col('B', 'account.city', 0.7)],
    });
    expect(out.columns.map((c) => c.target)).toEqual([null, 'account.name', 'account.city', null]);
  });

  it('keeps repeatable signal targets and later people groups', () => {
    const out = cleanMapping({
      columns: [col('A', 'signals[].title', 0.9), col('B', 'signals[].title', 0.9), col('C', 'people[1].email', 0.9)],
    });
    expect(out.columns.map((c) => c.target)).toEqual(['signals[].title', 'signals[].title', 'people[1].email']);
  });
});
