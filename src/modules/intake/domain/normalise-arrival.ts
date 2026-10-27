// SRC-E3 step 2 and the pure rules around it: an `arrival.v1` body as Accounts needs it, a person's
// answer applied over it, the waiting checks and the resolve lock key. No database, no network.

import { isKnownFactKey, matchName, splitName } from '@/modules/accounts';
import type { ArrivalAccountFields, ArrivalFact, ArrivalPerson, ArrivalSignal } from '@/modules/accounts/contracts/types';
import type { ArrivalV1 } from '../contracts/arrival';
import { industryKey } from './industry';
import { countryCode, domainFromEmail, normaliseDomain, parseRange } from './normalise';
import { relationshipKey } from './warm-intro';

/** A declared intro after normalising: the relationship key is already mapped (else `other`). */
export type WarmIntroInput = {
  introducerName?: string;
  introducerEmail?: string;
  relationshipText?: string;
  relationshipKey: string;
  note?: string;
};

/** Step 2's output, saved on `arrival.normalised` (dates as ISO strings in the database). */
export type Normalised = {
  account: ArrivalAccountFields;
  people: ArrivalPerson[];
  signals: ArrivalSignal[];
  facts: ArrivalFact[];
  research: Record<string, unknown>;
  practiceHint?: string;
  offerHint?: string;
  soleProprietor: boolean;
  warmIntro?: WarmIntroInput;
};

export type WaitingOn = 'needs_website' | 'needs_company' | 'possible_duplicate';

/** What a person decided while the arrival waited (written by the waiting services). */
export type ResolutionInput = {
  website?: string;
  company?: { name: string; website?: string };
  soleProprietor?: boolean;
  /** The sole proprietor's name, for a person who came with none. */
  personName?: string;
  duplicate?: { kind: 'same_as'; accountId: string } | { kind: 'new_company' };
};

/** Keys the AI task found for text no rule maps. */
export type AiKeys = { industryKey: string | null; relationshipKey: string | null };

const str = (s: string | null | undefined): string | undefined => s?.trim() || undefined;
const num = (v: number | null | undefined): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
export const defined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const relationshipRule = (a: ArrivalV1) =>
  a.warm_intro ? (relationshipKey(a.warm_intro.relationship_key) ?? relationshipKey(a.warm_intro.relationship)) : null;

/** The industry and relationship text that no rule maps: what to ask the AI task, if anything. */
export function unmapped(a: ArrivalV1): { industry?: string; relationship?: string } | null {
  const industry = str(a.account?.industry);
  const relationship = str(a.warm_intro?.relationship);
  const out = defined({
    industry: industry && !industryKey(industry) ? industry : undefined,
    relationship: relationship && !relationshipRule(a) ? relationship : undefined,
  });
  return Object.keys(out).length ? out : null;
}

function normaliseAccount(a: ArrivalV1, industry: string | undefined): ArrivalAccountFields {
  const acc = a.account ?? {};
  const website = normaliseDomain(acc.website) ? str(acc.website) : undefined;
  // A sole proprietor's email names a person, not a company.
  const emailDomain = a.sole_proprietor ? null : a.people.map((p) => normaliseDomain(domainFromEmail(p.email))).find(Boolean);
  const employees = parseRange(acc.employees_range);
  const revenue = parseRange(acc.revenue_range);
  const cents = (v: number | null | undefined) => (v == null ? undefined : v * 100);
  return defined({
    name: str(acc.name),
    domain: normaliseDomain(acc.domain) ?? normaliseDomain(acc.website) ?? emailDomain ?? undefined,
    websiteUrl: website,
    linkedinUrl: str(acc.linkedin_url),
    industry: str(acc.industry),
    industryKey: industry,
    employees: num(acc.employees),
    employeesMin: employees?.min ?? undefined,
    employeesMax: employees?.max ?? undefined,
    revenueCents: num(acc.revenue_cents),
    revenueMinCents: cents(revenue?.min),
    revenueMaxCents: cents(revenue?.max),
    hqCity: str(acc.city),
    hqState: str(acc.region),
    hqCountry: countryCode(acc.country) ?? undefined,
    description: str(acc.description),
    technologies: acc.technologies?.length ? acc.technologies : undefined,
    keywords: acc.keywords?.length ? acc.keywords : undefined,
    parentDomain: normaliseDomain(acc.parent_domain) ?? undefined,
  });
}

function normalisePeople(a: ArrivalV1): ArrivalPerson[] {
  return a.people.map((p) => {
    const split = !str(p.first_name) && !str(p.last_name) && str(p.name) ? splitName(p.name!) : null;
    const roleKeys = [...new Set([p.buying_role, ...(p.buying_roles ?? [])].map((r) => str(r)).filter((r): r is string => !!r))];
    return defined({
      firstName: str(p.first_name) ?? split?.firstName,
      lastName: str(p.last_name) ?? split?.lastName ?? undefined,
      title: str(p.title),
      email: str(p.email)?.toLowerCase(),
      phone: str(p.phone),
      linkedinUrl: str(p.linkedin_url),
      roleKeys: roleKeys.length ? roleKeys : undefined,
      decisionNote: str(p.notes),
    });
  });
}

function normaliseSignals(a: ArrivalV1): ArrivalSignal[] {
  return a.signals.map(
    (s) =>
      defined({
        kind: s.type ?? (s.fine_type === 'intent' ? 'research' : 'trigger'),
        type: str(s.fine_type),
        title: s.title.trim(),
        occurredAt: s.occurred_at ? new Date(s.occurred_at) : undefined,
        detail: str(s.detail),
        url: str(s.url),
        confidence: num(s.confidence),
      }) as ArrivalSignal,
  );
}

/** Known fact keys only: unknown keys stay in the raw payload. */
function normaliseFacts(a: ArrivalV1): ArrivalFact[] {
  const list: ArrivalFact[] = Array.isArray(a.facts)
    ? a.facts.map((f) => ({
        key: f.key,
        value: f.value,
        ...defined({ url: str(f.url), note: str(f.note), observedAt: f.observed_at ? new Date(f.observed_at) : undefined }),
      }))
    : Object.entries(a.facts).map(([key, value]) => ({ key, value }));
  return list.filter((f) => isKnownFactKey(f.key) && f.value !== undefined);
}

/**
 * SRC-E3 step 2. Rules first, then the AI task's keys (null when it was not asked or found
 * nothing). An unmapped relationship becomes `other`.
 */
export function normaliseArrival(a: ArrivalV1, ai: AiKeys | null): Normalised {
  const acc = a.account ?? {};
  const intro = a.warm_intro;
  const rule = relationshipRule(a);
  const hasIntro = !!intro && [intro.introducer_name, intro.introducer_email, intro.relationship, intro.relationship_key].some((v) => str(v));
  const research = defined(Object.fromEntries(Object.entries(a.research ?? {}).map(([k, v]) => [k, v ?? undefined])));
  return defined({
    account: normaliseAccount(a, industryKey(acc.industry) ?? (str(acc.industry) ? (ai?.industryKey ?? undefined) : undefined)),
    people: normalisePeople(a),
    signals: normaliseSignals(a),
    facts: normaliseFacts(a),
    research,
    practiceHint: str(acc.practice_hint),
    offerHint: str(acc.offer_hint),
    soleProprietor: a.sole_proprietor,
    warmIntro: hasIntro
      ? defined({
          introducerName: str(intro!.introducer_name),
          introducerEmail: str(intro!.introducer_email),
          relationshipText: str(intro!.relationship),
          relationshipKey: rule ?? relationshipKey(ai?.relationshipKey) ?? 'other',
          note: str(intro!.note),
        })
      : undefined,
  });
}

/** The saved step 2 output with its dates restored. */
export function revive(saved: unknown): Normalised {
  const n = saved as Normalised;
  const date = (d: unknown) => (typeof d === 'string' ? new Date(d) : (d as Date | undefined));
  return {
    ...n,
    signals: n.signals.map((s) => defined({ ...s, occurredAt: date(s.occurredAt) }) as ArrivalSignal),
    facts: n.facts.map((f) => defined({ ...f, observedAt: date(f.observedAt) })),
  };
}

/** Gives the first person the name, keeping their other fields. */
function named(people: ArrivalPerson[], full: string): ArrivalPerson[] {
  const { firstName, lastName } = splitName(full);
  const first = { ...people[0], firstName, ...(lastName ? { lastName } : {}) };
  return [first, ...people.slice(1)];
}

/** A person's answer, applied over the saved normalising (the website, the company, or "sole proprietor"). */
export function withInput(n: Normalised, input: ResolutionInput | null): Normalised {
  if (!input) return n;
  const website = input.website ?? input.company?.website;
  const domain = normaliseDomain(website);
  return {
    ...n,
    account: defined({
      ...n.account,
      name: str(input.company?.name) ?? n.account.name,
      ...(domain ? { domain, websiteUrl: website!.trim() } : {}),
    }),
    soleProprietor: n.soleProprietor || !!input.soleProprietor,
    people: input.personName ? named(n.people, input.personName) : n.people,
  };
}

const isShell = (n: Normalised) => n.soleProprietor && !n.account.name;
const personName = (n: Normalised) => [n.people[0]?.firstName, n.people[0]?.lastName].some((v) => !!v);

/** The person's email a shell account matches on. */
export const shellEmail = (n: Normalised): string | undefined => (isShell(n) ? n.people.find((p) => p.email)?.email : undefined);

/**
 * SRC-E3 step 3. A targeted arrival never waits. Otherwise the account must be findable (a domain or
 * LinkedIn page, or a shell) and must have a name (the company's, the domain, or a shell's person):
 * - no domain or LinkedIn page: `needs_company` when only a person's email came, else `needs_website`;
 * - a LinkedIn page but no name, or a shell whose person has no name: `needs_company`, since a person
 *   can always supply the company.
 */
export function waitingFor(n: Normalised, targeted: boolean): WaitingOn | null {
  if (targeted) return null;
  if (n.soleProprietor) return n.account.name || personName(n) ? null : 'needs_company';
  if (!n.account.domain && !n.account.linkedinUrl) {
    return !n.account.name && n.people.some((p) => p.email) ? 'needs_company' : 'needs_website';
  }
  return n.account.name || n.account.domain ? null : 'needs_company';
}

/** The resolve lock key: the domain, else the matching name and country, else the shell email, else the arrival. */
export function lockKeyOf(n: Normalised, arrivalId: string): string {
  if (n.account.domain) return n.account.domain;
  if (n.account.name) return `name:${matchName(n.account.name)}|${n.account.hqCountry ?? ''}`;
  const email = shellEmail(n);
  return email ? `email:${email}` : arrivalId;
}
