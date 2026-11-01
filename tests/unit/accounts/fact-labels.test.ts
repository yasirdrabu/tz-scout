import { describe, expect, it } from 'vitest';
import { FACT_KEYS } from '@/modules/accounts/contracts/types';
import { FACT_LABELS, factLabel } from '@/modules/accounts/contracts/fact-labels';

describe('factLabel', () => {
  it('has a label for every known fact key', () => {
    for (const key of FACT_KEYS) expect(FACT_LABELS[key], key).toBeTruthy();
  });

  it('names the common keys', () => {
    expect(factLabel('hq_city')).toBe('HQ city');
    expect(factLabel('revenue_cents')).toBe('Revenue');
    expect(factLabel('employees')).toBe('Employees');
    expect(factLabel('website_url')).toBe('Website');
  });

  it('gives a form answer its name in sentence case', () => {
    expect(factLabel('form.budget_range')).toBe('Budget range');
    expect(factLabel('form.Team size')).toBe('Team size');
  });

  it('falls back to the key in sentence case', () => {
    expect(factLabel('buying_process')).toBe('Buying process');
    expect(factLabel('some_NEW_key')).toBe('Some new key');
  });
});
