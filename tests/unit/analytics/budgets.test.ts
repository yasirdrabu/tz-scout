import { describe, expect, it } from 'vitest';
import { budgetFor, levelOf, monthOf, monthsBack } from '@/modules/analytics/domain/budgets';

describe('levelOf', () => {
  it('ok below 90%, alert from 90%, over from 100%, paused from 110% when the category can pause', () => {
    expect(levelOf(899, 1000, true)).toBe('ok');
    expect(levelOf(900, 1000, true)).toBe('alert');
    expect(levelOf(999, 1000, true)).toBe('alert');
    expect(levelOf(1000, 1000, true)).toBe('over');
    expect(levelOf(1099, 1000, true)).toBe('over');
    expect(levelOf(1100, 1000, true)).toBe('paused');
  });

  it('a category that cannot pause tops out at over', () => {
    expect(levelOf(1100, 1000, false)).toBe('over');
    expect(levelOf(5000, 1000, false)).toBe('over');
  });

  it('no budget, or a budget of 0, is always ok', () => {
    expect(levelOf(1_000_000, null, true)).toBe('ok');
    expect(levelOf(1_000_000, 0, true)).toBe('ok');
  });
});

describe('budgetFor', () => {
  const rows = [
    { category: 'ai_usage', month: '2026-08', amountCents: 100 },
    { category: 'ai_usage', month: '2026-10', amountCents: 300 },
    { category: 'data_vendors', month: '2026-11', amountCents: 999 },
  ] as const;

  it("uses the month's own row", () => {
    expect(budgetFor(rows, 'ai_usage', '2026-10')).toBe(300);
  });

  it('carries forward the latest earlier month', () => {
    expect(budgetFor(rows, 'ai_usage', '2026-09')).toBe(100);
    expect(budgetFor(rows, 'ai_usage', '2027-02')).toBe(300);
  });

  it('none before the first row, and other categories never count', () => {
    expect(budgetFor(rows, 'ai_usage', '2026-07')).toBeNull();
    expect(budgetFor(rows, 'partner_fees', '2026-11')).toBeNull();
  });
});

describe('months', () => {
  it('the tenant-timezone month of an instant', () => {
    // 03:00 UTC on 1 December is still 30 November in New York.
    expect(monthOf(new Date('2026-12-01T03:00:00Z'), 'America/New_York')).toBe('2026-11');
    expect(monthOf(new Date('2026-12-01T06:00:00Z'), 'America/New_York')).toBe('2026-12');
  });

  it('the last n months, oldest first, across a year', () => {
    expect(monthsBack('2027-02', 6)).toEqual(['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02']);
  });
});
