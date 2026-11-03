// Vibe Prospecting (Explorium) data to arrival-shaped values (Ruling 2). The v1 mapping (events, crime and M&A rules,
// export and prospect rows, seniority) lives once, in intake's Vibe import layout, and is used from there. What is
// here is only what that layout does not have: v1's `rangeMid` and `industryFor`, and the step to enrichment's
// arrival values (signal kinds, account fields, people with the accounts email status).

import {
  fromVibeExportRow,
  fromVibeProspectRow,
  isParty,
  mapEvent,
  nameKey,
  seniority,
  topicLabel,
  vibeSignals,
  type VibeCompany,
  type VibePerson,
} from '@/modules/intake';
import type { CompanyFacts, EmailStatus, Person, Signal } from '../../contracts/adapter';

export { fromVibeExportRow, fromVibeProspectRow, isParty, mapEvent, nameKey, seniority, topicLabel, vibeSignals, type VibeCompany, type VibePerson };

/** "501-1000" -> 708 (geometric middle), "10001+" -> 10001. */
export function rangeMid(range: string | null | undefined, unit = 1): number | null {
  if (!range) return null;
  const m = range.replace(/,/g, '').match(/^(\d+(?:\.\d+)?)([KMBT])?(?:-(\d+(?:\.\d+)?)([KMBT])?)?\+?$/i);
  if (!m) return null;
  const mult = (s?: string) => ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 })[(s ?? '').toUpperCase() as 'K'] ?? 1;
  const lo = Number(m[1]) * mult(m[2] ?? m[4]);
  const hi = m[3] ? Number(m[3]) * mult(m[4]) : lo;
  return Math.round(Math.sqrt(Math.max(lo, 1) * Math.max(hi, 1)) * unit);
}

// NAICS prefix to the industry words our offers use. Longest prefix wins.
const NAICS_INDUSTRY: [string, string][] = [
  ['5311', 'Commercial real estate'], ['5312', 'Real estate brokerage'], ['5313', 'Property management'], ['531', 'Real estate'],
  ['524', 'Insurance'], ['52', 'Financial services'],
  ['621', 'Healthcare services: clinics and outpatient'], ['622', 'Healthcare services: hospitals'], ['623', 'Healthcare services: nursing and residential care'], ['62', 'Healthcare services'],
  ['493', 'Logistics: warehousing'], ['484', 'Logistics: trucking'], ['488', 'Logistics: freight'], ['48', 'Logistics and transportation'], ['49', 'Logistics and transportation'],
  ['31', 'Manufacturing'], ['32', 'Manufacturing'], ['33', 'Manufacturing'], ['42', 'Wholesale distribution'],
  ['5411', 'Legal services'], ['54', 'Professional services'], ['23', 'Construction'], ['92', 'Government services'],
];

/** Our industry label from a NAICS code, falling back to Vibe's description. */
export function industryFor(naics: string | null | undefined, description?: string | null): string | null {
  const code = (naics ?? '').trim();
  const hit = NAICS_INDUSTRY.filter(([p]) => code.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0];
  return hit ? hit[1] : (description ?? null);
}

/** The signal kind each fine type has in Accounts (`SIGNAL_TYPES`). */
const KIND: Record<string, 'research' | 'trigger' | 'pain'> = {
  intent: 'research',
  leadership: 'trigger',
  funding: 'trigger',
  news: 'trigger',
  risk: 'trigger',
  hiring: 'pain',
  workforce: 'pain',
};

/** Seniority words as Apollo spells them, from `seniority`'s score. */
const SENIORITY_LABEL: Record<number, string> = { 40: 'c_suite', 35: 'c_suite', 30: 'vp', 25: 'head', 20: 'director' };

const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) as T;

export function toCompanyFacts(c: VibeCompany): CompanyFacts {
  const revenue = rangeMid(c.revenueRange);
  return defined({
    name: c.name || null,
    domain: c.domain || null,
    website: c.website,
    linkedin_url: c.linkedin,
    city: c.city,
    region: c.region,
    country: c.country,
    industry: industryFor(c.naics, c.naicsDescription),
    employees: rangeMid(c.employeesRange),
    employees_range: c.employeesRange,
    revenue_cents: revenue === null ? null : revenue * 100,
    revenue_range: c.revenueRange,
    description: c.description,
    technologies: c.techStack.length ? c.techStack : null,
    provider_ref: c.businessId || null,
  });
}

/** Intake's Vibe signals with the kind each fine type has, and a date on each (an undated intent is dated `now`). */
export function toSignals(signals: Signal[], now: Date): Signal[] {
  return signals.map((s) => defined({ type: KIND[s.fine_type ?? ''] ?? null, ...s, occurred_at: s.occurred_at ?? now.toISOString().slice(0, 10) }));
}

/** Vibe's email statuses ("valid", "catch-all", "invalid", ...) as the accounts fact values. */
function emailStatusOf(email: string | null, status: string | null): EmailStatus {
  if (!email) return 'unavailable';
  const s = (status ?? '').toLowerCase();
  if (s === 'valid' || s === 'verified') return 'verified';
  if (s === 'invalid' || s === 'bounced') return 'bounced';
  return 'guessed';
}

export function toPerson(p: VibePerson): Person {
  return {
    name: [p.firstName, p.lastName].filter(Boolean).join(' '),
    first_name: p.firstName,
    last_name: p.lastName,
    title: p.title,
    email: p.email,
    email_status: emailStatusOf(p.email, p.emailStatus),
    seniority: SENIORITY_LABEL[seniority(p.title)] ?? null,
    phone: p.phone,
    linkedin_url: p.linkedin,
    provider_ref: p.prospectId,
  };
}
