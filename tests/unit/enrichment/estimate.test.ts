import { describe, expect, it } from 'vitest';
import { estimate, estimateText } from '@/modules/enrichment/domain/estimate';
import { KINDS, kindLabel, operationsFor } from '@/modules/enrichment/domain/kinds';
import { DEFAULT_CENTS_PER_CREDIT } from '@/modules/enrichment/domain/prices';

describe('estimate (Rulings 4 and 5)', () => {
  it('people for 2 roles is 6 credits, about $0.60 at 10 cents a credit', () => {
    const est = estimate({ provider: 'apollo', kind: 'people_for_roles', roles: ['champion', 'economic_buyer'], centsPerCredit: 10 });
    expect(est).toEqual({ credits: 6, costCents: 60 });
    expect(estimateText(est, 'USD', false)).toBe('Up to 6 credits, about $0.60');
    expect(estimateText(est, 'USD', true)).toBe('Up to 6 credits, about $0.60 · Sample');
  });

  it('counts each kind', () => {
    expect(estimate({ provider: 'apollo', kind: 'company_firmographics', centsPerCredit: 10 })).toEqual({ credits: 1, costCents: 10 });
    expect(estimate({ provider: 'apollo', kind: 'email_reveal', personIds: ['per_1', 'per_2', 'per_3'], centsPerCredit: 10 })).toEqual({ credits: 3, costCents: 30 });
    expect(estimate({ provider: 'vibe', kind: 'signals_refresh', centsPerCredit: 10 })).toEqual({ credits: 2, costCents: 20 });
  });

  it('falls back to the provider default cents a credit', () => {
    expect(DEFAULT_CENTS_PER_CREDIT).toEqual({ apollo: 10, vibe: 10 });
    expect(estimate({ provider: 'vibe', kind: 'company_firmographics' })).toEqual({ credits: 1, costCents: 10 });
  });

  it('one credit reads singular', () => {
    expect(estimateText({ credits: 1, costCents: 10 }, 'USD', false)).toBe('Up to 1 credit, about $0.10');
  });

  it('a website read is free of credits and costs at most the Claude worst case', () => {
    const est = estimate({ provider: 'website', kind: 'website_read', aiWorstCents: 5 });
    expect(est).toEqual({ credits: 0, costCents: 5 });
    expect(estimateText(est, 'USD', false)).toBe('Free. Claude usage up to $0.05');
    expect(estimateText(est, 'USD', true)).toBe('Free. Claude usage up to $0.05 · Sample');
  });
});

describe('kinds (Ruling 4)', () => {
  it('labels every kind', () => {
    expect(KINDS.map(kindLabel)).toEqual(['Company facts', 'People for buying roles', 'Reveal emails', 'Read the website', 'Fresh signals']);
  });

  it('names the provider operations', () => {
    expect(operationsFor('apollo', 'company_firmographics')).toEqual(['organizations/enrich']);
    expect(operationsFor('apollo', 'people_for_roles')).toEqual(['mixed_people/api_search', 'people/match']);
    expect(operationsFor('apollo', 'email_reveal')).toEqual(['people/match']);
    expect(operationsFor('apollo', 'signals_refresh')).toEqual(['organizations/job_postings', 'news_articles/search']);
    expect(operationsFor('vibe', 'email_reveal')).toEqual(['people/match']);
    expect(operationsFor('website', 'website_read')).toEqual(['website.read']);
  });

  it('has no operations for a kind the provider does not do', () => {
    expect(operationsFor('website', 'email_reveal')).toEqual([]);
    expect(operationsFor('apollo', 'website_read')).toEqual([]);
    expect(operationsFor('hubspot', 'company_firmographics')).toEqual([]);
  });
});
