// The brief assembled from rules, with no Claude (Task 2). Every number it states carries a citation.
import type { BriefInput, BriefOutput, SectionOutput } from './brief-io';
import { OPENER_MAX, SUBJECT_MAX } from './brief-io';
import { isBuyerSafe } from './buyer-safe';
import { clip, datedSignals, hasRecentSignal, recommendation, signalLine } from './recommendation';

export const NO_DATED_SIGNALS = 'No dated signals yet.';
export const NOTHING_IN_DATA = 'Nothing in the data Scout has. Add what you know.';
const RECENT_DAYS = 90;

const article = (w: string) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
const firstSentence = (s: string) => (s.trim().match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim();
const ensureStop = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const hasNumber = (s: string) => /\d/.test(s);

/** A signal as a phrase that follows the company name: "is hiring a Director of AI" (v1 `signalPhrase`). */
export function signalPhrase(company: string, s: { type: string | null; title: string }): string {
  const t = s.title.trim();
  if (s.type === 'hiring') {
    const m = t.match(/^Hiring(?: in ([\w &]+))?:\s*(.+)$/i);
    if (!m) return t.toLowerCase().startsWith('hiring') ? `is ${t.replace(/^Hiring/i, 'hiring')}` : `is hiring ${article(t)} ${t}`;
    const role = m[2]!.split(',')[0]!.trim();
    return `is hiring ${article(role)} ${role}${m[1] ? ` in ${m[1].toLowerCase()}` : ''}`;
  }
  if (s.type === 'leadership' && /^New leader joined:\s*/i.test(t)) return `just brought on a new ${t.replace(/^New leader joined:\s*/i, '')}`;
  if (s.type === 'tech') return `runs ${t.replace(/^Uses\s+/i, '')}`;
  if (s.type === 'growth') {
    const pct = t.match(/(\d+)%/)?.[1];
    return pct ? `grew headcount ${pct}% in the last six months` : 'is growing fast';
  }
  if (s.type === 'funding') return t.replace(/^Raised/i, 'raised');
  // News and leadership titles usually start with the company name: "Keystone Ridge appoints first CIO".
  const rest = t.toLowerCase().startsWith(company.toLowerCase()) ? t.slice(company.length).trim() : `was in the news: "${t}"`;
  return rest.replace(/^(\w)/, (m) => m.toLowerCase());
}

/** Best public hooks first: a new leader, a deal or expansion, the stack. Research and risk signals are never hooks. */
export const HOOK_ORDER = ['leadership', 'funding', 'news', 'tech', 'growth'];

type Person = BriefInput['people'][number];

/** Primary person, else the first holding one of the offer's buying roles, else the offer's first target title (Task 2). */
export function whoFirst(input: BriefInput): BriefOutput['whoFirst'] & { person: Person | null } {
  const primary = input.people.find((p) => p.isPrimary);
  if (primary) return { person: primary, personId: primary.id, title: titleOf(primary), reason: 'Marked as the main contact.' };
  const roles = input.offer?.targetBuyingRoles ?? [];
  for (const p of input.people) {
    const i = p.roleKeys.findIndex((k) => roles.includes(k));
    if (i >= 0) return { person: p, personId: p.id, title: titleOf(p), reason: `Holds the ${p.roleLabels[i] ?? p.roleKeys[i]} buying role.` };
  }
  const title = input.offer?.targetTitles[0];
  if (title) return { person: null, personId: null, title, reason: `${title} is the offer's usual buyer.` };
  const p = input.people[0];
  if (p) return { person: p, personId: p.id, title: titleOf(p), reason: 'The first contact Scout has.' };
  return { person: null, personId: null, title: 'decision maker', reason: 'Scout has no contact for this account yet.' };
}
const titleOf = (p: Person) => p.title ?? p.roleLabels[0] ?? 'Contact';

const factIds = (input: BriefInput, keys: string[]) => input.facts.filter((f) => keys.includes(f.key)).map((f) => f.id);
const OVERVIEW_KEYS = ['name', 'domain', 'industry', 'hq_city', 'hq_state', 'hq_country', 'employees', 'description'];

function overview(input: BriefInput): SectionOutput {
  const a = input.account;
  const staffFact = input.facts.find((f) => f.key === 'employees');
  const parts = [a.name, a.industry, a.location ? `based in ${a.location}` : null, staffFact && a.employees !== null ? `about ${a.employees.toLocaleString('en-US')} staff` : null];
  const lines = [ensureStop(parts.filter(Boolean).join(', '))];
  if (a.description) lines.push(ensureStop(firstSentence(a.description)));
  const { priority, tierLabel } = input.score;
  lines.push(input.offer ? `Scout matched it to ${input.offer.name} with a priority of ${priority} (${tierLabel}).` : `Scout gave it a priority of ${priority} (${tierLabel}).`);
  // The score rests on the account's facts and its scored signals.
  return { text: lines.join(' '), citations: [...factIds(input, OVERVIEW_KEYS), ...input.signals.slice(0, 3).map((s) => s.id)] };
}

function approach(input: BriefInput, who: ReturnType<typeof whoFirst>): SectionOutput {
  const lines = [who.person ? `Start with ${who.person.name}, ${who.title}.` : `Start with the ${who.title}.`];
  if (input.warmIntro) lines.push(`Ask ${input.warmIntro.introducerName} for the intro.`);
  if (input.offer) lines.push(`Lead with: ${ensureStop(input.offer.promise)}`);
  return { text: lines.join(' '), citations: who.personId ? [who.personId] : [] };
}

function valueAngle(input: BriefInput): SectionOutput {
  if (!input.offer) return { text: 'No approved offer matched yet, so there is no value angle to lead with.', citations: [] };
  const lines = [ensureStop(input.offer.promise)];
  const cs = input.caseStudies[0];
  const proof = input.offer.proofPoints[0];
  if (cs) lines.push(ensureStop(`${cs.clientName ?? cs.title}: ${cs.result ?? cs.title}`));
  else if (proof) lines.push(ensureStop(proof));
  return { text: lines.join(' '), citations: factIds(input, ['industry']) };
}

function risks(input: BriefInput, now: Date): SectionOutput {
  const lines: string[] = [];
  const cites: string[] = [];
  if (input.crm?.lifecycle === 'open_deal') lines.push(`${input.crm.ownerName ?? 'Someone'} owns an open deal in HubSpot.`);
  if (input.people.length === 0) lines.push('No buyer contact yet.');
  if (!hasRecentSignal(input, now, RECENT_DAYS)) {
    lines.push('No dated signal in the last 90 days, so timing is a guess.');
    cites.push(...datedSignals(input).slice(0, 1).map((s) => s.id));
  }
  if (input.score.fit < 50) {
    lines.push('Fit is below 50.');
    cites.push(...factIds(input, ['industry', 'employees', 'revenue_cents', 'hq_country']));
  }
  return lines.length ? { text: lines.join('\n'), citations: cites } : { text: NOTHING_IN_DATA, citations: [] };
}

function whyNow(input: BriefInput): SectionOutput {
  const top = datedSignals(input).slice(0, 2);
  return top.length ? { text: top.map(signalLine).join('\n'), citations: top.map((s) => s.id) } : { text: NO_DATED_SIGNALS, citations: [] };
}

/** v1's public-hook opener: first name, one public signal, what the offer does. Never a research or risk signal. */
function opener(input: BriefInput, who: ReturnType<typeof whoFirst>): BriefOutput['opener'] {
  const name = input.account.name;
  const first = who.person?.name.split(' ')[0] ?? 'there';
  const pub = HOOK_ORDER.map((t) =>
    input.signals.find((s) => s.type === t && s.kind !== 'research' && s.title.length <= 90 && isBuyerSafe(s.title, input.signals)),
  ).find(Boolean);
  const industry = input.account.industry?.toLowerCase().replace(/:.*$/, '');
  const hook = pub ? `I noticed ${name} ${signalPhrase(name, pub)}.` : `I work with ${industry ?? 'companies'} teams a lot like yours.`;
  const value = input.offer ? ensureStop(input.offer.promise) : 'We help teams like yours get one hard workflow working in weeks.';
  let body = `Hi ${first}, ${hook} ${value}`;
  if (!isBuyerSafe(body, input.signals)) body = `Hi ${first}, I work with ${industry ?? 'companies'} teams a lot like yours. ${value}`;
  return { subject: clip(`A quick idea for ${name}`, SUBJECT_MAX), body: clip(body, OPENER_MAX) };
}

/**
 * A section with a number and no citation would fail the output check. When the input gives nothing to cite, the
 * sentences with numbers are left out; the section is never empty.
 */
function cited(s: SectionOutput, fallback: string[]): SectionOutput {
  if (!hasNumber(s.text) || s.citations.length > 0) return { ...s, citations: [...new Set(s.citations)] };
  if (fallback.length > 0) return { ...s, citations: fallback };
  const kept = s.text
    .split(/(?<=[.!?])\s+|\n/)
    .filter((x) => x && !hasNumber(x))
    .join(' ');
  return { text: kept || NOTHING_IN_DATA, citations: [] };
}

/** The whole brief from rules. Pure; `now` decides which signals are recent. */
export function rulesBrief(input: BriefInput, now: Date): BriefOutput {
  const who = whoFirst(input);
  const fallback = [...input.facts.map((f) => f.id), ...input.signals.map((s) => s.id)].slice(0, 3);
  return {
    recommendation: recommendation(input),
    sections: {
      overview: cited(overview(input), fallback),
      approach: cited(approach(input, who), fallback),
      valueAngle: cited(valueAngle(input), fallback),
      risks: cited(risks(input, now), fallback),
      whyNow: cited(whyNow(input), fallback),
    },
    opener: opener(input, who),
    whoFirst: { personId: who.personId, title: who.title, reason: who.reason },
  };
}
