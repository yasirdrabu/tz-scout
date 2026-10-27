// Fit: does the account look like this offer's buyer? Pure, carried from v1 matching.ts (SCO-E1).

import type { FitPart, FitPartKey, ScoringAccount, ScoringOffer, ScoringProfile } from '../contracts/types';

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 /]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Loose industry match: containment either way, or a shared meaningful word. */
export function industryMatches(target: string, actual: string | null | undefined): boolean {
  if (!actual) return false;
  const a = norm(target);
  const b = norm(actual);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const stop = new Set(['services', 'and', 'the', 'of', 'group', 'industry']);
  const words = (s: string) => s.split(' ').filter((w) => w.length > 3 && !stop.has(w));
  const bw = new Set(words(b));
  return words(a).some((w) => bw.has(w));
}

const titleFn = (s: string) =>
  norm(s)
    .replace(/\b(chief|officer|vice|president|vp|head|of|director|senior|svp|evp|the|and)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const ABBR: Record<string, string> = {
  ceo: 'executive',
  coo: 'operating operations',
  cio: 'information technology',
  cto: 'technology',
  cfo: 'financial finance',
  ciso: 'security',
  cdo: 'data',
};
const expandTitle = (s: string) =>
  norm(s)
    .split(' ')
    .map((w) => ABBR[w] ?? w)
    .join(' ');
const functionWords = (s: string) => titleFn(expandTitle(s)).split(' ').filter((w) => w.length > 2);

/** Does a contact's title match any target title (by function words)? */
export function titleMatches(title: string | null, targets: string[]): boolean {
  if (!title) return false;
  const t = new Set(functionWords(title));
  return targets.some((target) => functionWords(target).some((w) => t.has(w)));
}

const US = new Set(['united states', 'united states of america', 'usa', 'us', 'u s', 'u s a']);
const sameCountry = (a: string, b: string) => norm(a) === norm(b) || (US.has(norm(a)) && US.has(norm(b)));

export type FitResult = { fit: number; parts: FitPart[]; disqualifiedReason: string | null; hardMiss: boolean };

const PART_LABELS: Record<FitPartKey, string> = { industry: 'Industry', size: 'Company size', revenue: 'Revenue', region: 'Region', buyer: 'Buyer contact' };

/** Fit 0, with all five parts at 0 points so each says why. */
const disqualified = (reason: string, profile: ScoringProfile): FitResult => ({
  fit: 0,
  parts: (Object.keys(PART_LABELS) as FitPartKey[]).map((key) => ({ key, label: PART_LABELS[key], points: 0, max: profile.fitParts[key], note: reason })),
  disqualifiedReason: reason,
  hardMiss: false,
});

export function fit(account: ScoringAccount, offer: ScoringOffer, profile: ScoringProfile): FitResult {
  if (account.excluded) return disqualified(account.excluded.label, profile);
  if (offer.excludedDomains.some((d) => d.toLowerCase() === account.domain.toLowerCase())) {
    return disqualified(`${account.domain} is on the excluded list.`, profile);
  }
  const category = offer.excludedCategories.find((c) => industryMatches(c, account.industry));
  if (category) return disqualified(`${account.industry} is in the excluded category ${category}.`, profile);

  const parts: FitPart[] = [];
  const misses = new Set<FitPartKey>();
  /** `share` is the part of the max earned; 0 with `miss` means known and wrong. */
  const add = (key: FitPartKey, label: string, share: number, note: string, miss = false) => {
    const max = profile.fitParts[key];
    parts.push({ key, label, points: max * share, max, note });
    if (miss) misses.add(key);
  };

  const a = account;
  // Industry
  if (offer.industries.length === 0) add('industry', 'Industry', 1, 'No industry limit on this offer.');
  else if (!a.industry) add('industry', 'Industry', 0.5, 'Industry unknown.');
  else {
    const hit = offer.industries.find((i) => industryMatches(i, a.industry));
    add('industry', 'Industry', hit ? 1 : 0, hit ? `${a.industry} matches ${hit}.` : `${a.industry} isn't a target industry.`, !hit);
  }

  // Company size
  const { companySizeMin: lo, companySizeMax: hi } = offer;
  if (lo == null && hi == null) add('size', 'Company size', 1, 'No size limit.');
  else if (a.employees == null) add('size', 'Company size', 12 / 25, 'Headcount unknown.');
  else {
    const e = a.employees;
    const inRange = (lo == null || e >= lo) && (hi == null || e <= hi);
    const near = !inRange && ((lo != null && e >= lo * 0.7 && e < lo) || (hi != null && e <= hi * 1.3 && e > hi));
    const note = `${e.toLocaleString('en-US')} employees${inRange ? ', in range' : near ? ', just outside range' : ', out of range'}.`;
    add('size', 'Company size', inRange ? 1 : near ? 10 / 25 : 0, note, !inRange && !near);
  }

  // Revenue
  const rlo = offer.revenueMinCents;
  const rhi = offer.revenueMaxCents;
  if (rlo == null && rhi == null) add('revenue', 'Revenue', 1, 'No revenue limit.');
  else if (a.revenueCents == null) add('revenue', 'Revenue', 0.5, 'Revenue unknown.');
  else {
    const ok = (rlo == null || a.revenueCents >= rlo) && (rhi == null || a.revenueCents <= rhi);
    add('revenue', 'Revenue', ok ? 1 : 0, `About $${Math.round(a.revenueCents / 100_000_000)}M${ok ? ', in band' : ', out of band'}.`);
  }

  // Region
  if (offer.regions.length === 0) add('region', 'Region', 1, 'No region limit.');
  else if (!a.country) add('region', 'Region', 0.5, 'Location unknown.');
  else {
    const country = a.country;
    const ok = offer.regions.some((r) => sameCountry(r, country));
    add('region', 'Region', ok ? 1 : 0, ok ? `Based in ${country}.` : `${country} is outside the target regions.`);
  }

  // Buyer on file: a matching title, or one of the offer's target buying roles
  const buyer = a.people.find((p) => titleMatches(p.title, offer.targetTitles) || p.roleKeys.some((r) => offer.targetBuyingRoles.includes(r)));
  add(
    'buyer',
    'Buyer contact',
    buyer ? 1 : 0,
    buyer ? `${buyer.title ?? 'A buyer'} on file.` : a.people.length ? 'No contact with a target title or role yet.' : 'No contacts pulled yet.',
  );

  let score = Math.round(parts.reduce((s, p) => s + p.points, 0));
  // A known wrong industry or a size well outside the range caps fit: right size alone isn't a buyer.
  const hardMiss = misses.has('industry') || misses.has('size');
  if (hardMiss) score = Math.min(score, 45);
  return { fit: score, parts, disqualifiedReason: null, hardMiss };
}
