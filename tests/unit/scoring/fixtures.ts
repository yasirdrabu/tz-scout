import { DEFAULT_PROFILE } from '@/modules/scoring/defaults';
import type { ScoringAccount, ScoringOffer, ScoringProfile, ScoringRule, ScoringSignal } from '@/modules/scoring/contracts/types';

export const NOW = new Date('2026-10-14T12:00:00Z');
export const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400_000);
export const M = 100_000_000;

export const profile: ScoringProfile = DEFAULT_PROFILE;

export const offer = (o: Partial<ScoringOffer> = {}): ScoringOffer => ({
  id: 'off_1',
  industries: ['Commercial real estate', 'Healthcare services', 'Logistics'],
  excludedCategories: ['Gambling'],
  excludedDomains: ['taazaa.com'],
  companySizeMin: 100,
  companySizeMax: 2500,
  revenueMinCents: 50 * M,
  revenueMaxCents: 500 * M,
  regions: ['United States'],
  targetTitles: ['CEO', 'COO', 'VP Operations'],
  targetBuyingRoles: [],
  rules: [],
  ...o,
});

export const account = (a: Partial<ScoringAccount> = {}): ScoringAccount => ({
  domain: 'acme.com',
  industry: 'Logistics',
  industryKey: null,
  employees: 400,
  revenueCents: 90 * M,
  country: 'United States',
  technologies: [],
  headcountGrowth6m: null,
  excluded: null,
  people: [],
  ...a,
});

export const person = (title: string | null, roleKeys: string[] = []) => ({ title, roleKeys });

export const rule = (r: Partial<ScoringRule> & Pick<ScoringRule, 'id' | 'type' | 'weight'>): ScoringRule => ({
  label: r.id,
  match: [],
  minValue: null,
  why: null,
  enabled: true,
  ...r,
});

const KIND = { intent: 'research', leadership: 'trigger', funding: 'trigger', news: 'trigger', risk: 'trigger' } as const;

export const signal = (s: Partial<ScoringSignal> & Pick<ScoringSignal, 'id' | 'type' | 'title'>): ScoringSignal => ({
  kind: KIND[s.type as keyof typeof KIND] ?? 'pain',
  detail: null,
  value: null,
  occurredAt: NOW,
  recordedAt: NOW,
  ...s,
});
