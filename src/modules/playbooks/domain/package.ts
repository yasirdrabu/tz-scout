// The handoff package CRM puts in the HubSpot note and tasks (PLB-E3-S4, Task 4). Pure: it reads what it is given.
import { AI_LABEL } from '@/modules/ai-tasks';
import type { HandoffPackage } from '@/modules/crm/contracts/types';
import type { BriefKey } from '../contracts/types';
import type { BriefInput, BriefOutput } from './brief-io';
import { isBuyerSafe } from './buyer-safe';
import { followUps } from './follow-ups';
import { clip, dayText } from './recommendation';

type Labelled = { label: string };

/** The brief as the package uses it: the stored one, or rules assembled in memory. Each piece carries its label. */
export type PackageBrief = {
  recommendation: { headline: string; detail: string } & Labelled;
  whoFirst: { personId: string | null; title: string; reason: string } & Labelled;
  opener: { subject: string; body: string } & Labelled;
  sections: Record<BriefKey, { text: string } & Labelled>;
  /** The rules opener, used when the stored one is not buyer safe. */
  rulesOpener?: { subject: string; body: string };
};

/** A signal of the account, with its link and, when it was scored, the rule's text. */
export type PackageSignal = BriefInput['signals'][number] & { url: string | null; ruleText: string | null };

export type PackageInput = {
  brief: PackageBrief;
  /** Account, offer, practice, case studies and score, as the brief task reads them. */
  input: BriefInput;
  signals: PackageSignal[];
  /** Other offers that fit, best first. */
  matches: { name: string; total: number }[];
  followUpDays: readonly number[];
  buyer: { name: string; title: string | null; email: string | null } | null;
};

export const WHY_NOW_MAX = 1000;
const OTHER_OFFERS = 3;

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const heading = (t: string) => `<p><strong>${esc(t)}</strong></p>`;
const paragraphs = (text: string) =>
  text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<p>${esc(l)}</p>`)
    .join('');
const labelLine = (label: string) => `<p><em>${esc(label)}</em></p>`;
const list = (items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const money = (c: number) => `$${Math.round(c / 100).toLocaleString('en-US')}`;
const safeUrl = (u: string | null) => (u && /^https?:\/\//i.test(u) ? u : null);
const date = (iso: string | null) => (iso && !Number.isNaN(new Date(iso).getTime()) ? dayText(new Date(iso)) : null);

/** `{source}` as a link when the signal has one. */
function source(s: PackageSignal): string {
  const url = safeUrl(s.url);
  const name = esc(s.sourceName ?? 'source');
  return url ? `<a href="${esc(url)}">${name}</a>` : s.sourceName ? name : '';
}

const dated = (signals: PackageSignal[]) =>
  signals.filter((s) => date(s.occurredAt)).sort((a, b) => new Date(b.occurredAt!).getTime() - new Date(a.occurredAt!).getTime() || a.id.localeCompare(b.id));

const topic = (title: string) => title.replace(/^Researching:\s*/i, '').trim();

/** A rules brief with every piece labelled `Assembled from rules`. */
export function rulesPackageBrief(o: BriefOutput): PackageBrief {
  const label = AI_LABEL.rules;
  const s = o.sections;
  return {
    recommendation: { ...o.recommendation, label },
    whoFirst: { ...o.whoFirst, label },
    opener: { ...o.opener, label },
    sections: {
      overview: { text: s.overview.text, label },
      approach: { text: s.approach.text, label },
      value_angle: { text: s.valueAngle.text, label },
      risks: { text: s.risks.text, label },
      why_now: { text: s.whyNow.text, label },
    },
    rulesOpener: o.opener,
  };
}

/** The opener to send: the brief's, unless it quotes something it must not; then the rules one. */
function sendableOpener(p: PackageInput): { subject: string; body: string; label: string } {
  const o = p.brief.opener;
  if (isBuyerSafe(`${o.subject}\n${o.body}`, p.input.signals) && isBuyerSafe(`${o.subject}\n${o.body}`, p.signals)) return o;
  return { ...(p.brief.rulesOpener ?? { subject: o.subject, body: '' }), label: AI_LABEL.rules };
}

export function buildPackage(p: PackageInput): HandoffPackage {
  const { brief, input } = p;
  const sec = brief.sections;
  const offer = input.offer;
  const score = input.score;
  const opener = sendableOpener(p);
  const out: HandoffPackage['sections'] = [];
  const add = (key: string, label: string, body: string | null) => {
    if (body) out.push({ key, label, html: `${heading(label)}${body}` });
  };
  const piece = (text: string, label: string) => `${paragraphs(text)}${labelLine(label)}`;

  add('score', 'Score', `<p>${esc(`${score.tierLabel}: priority ${score.priority}, fit ${score.fit}, buying intent ${score.intent}.`)}</p>`);
  add('recommendation', "Scout's recommendation", `<p><strong>${esc(brief.recommendation.headline)}</strong></p>${paragraphs(brief.recommendation.detail)}${labelLine(brief.recommendation.label)}`);

  const datedSignals = dated(p.signals);
  const whyList = datedSignals.length
    ? list(datedSignals.map((s) => `${esc(date(s.occurredAt)!)}: ${esc(s.title)}${source(s) ? ` (${source(s)})` : ''}`))
    : '';
  add('why_now', 'Why now', `${paragraphs(sec.why_now.text)}${whyList}${labelLine(sec.why_now.label)}`);

  const who = p.buyer ? `${p.buyer.name}${p.buyer.title ? `, ${p.buyer.title}` : ''}` : `the ${brief.whoFirst.title}`;
  add(
    'how_to_approach',
    'How to approach',
    [
      `<p>${esc(`Who first: ${who}. ${brief.whoFirst.reason}`)}</p>${labelLine(brief.whoFirst.label)}`,
      piece(sec.approach.text, sec.approach.label),
      opener.body ? `<p>${esc(`Opener: ${opener.subject}`)}</p>${paragraphs(opener.body)}${labelLine(opener.label)}` : '',
    ].join(''),
  );
  add('overview', 'Overview', piece(sec.overview.text, sec.overview.label));
  add('value_angle', 'Our value angle', piece(sec.value_angle.text, sec.value_angle.label));
  add('risks', 'Risks and watch-outs', piece(sec.risks.text, sec.risks.label));

  if (offer) {
    const rows = [`<strong>${esc(offer.name)}</strong>: ${esc(offer.promise)}`];
    if (offer.priceMinCents !== null || offer.priceMaxCents !== null) {
      const range = [offer.priceMinCents, offer.priceMaxCents].filter((c): c is number => c !== null).map(money).join(' to ');
      rows.push(`Price range: ${esc(range)}`);
    }
    if (offer.salesCycleDays !== null) rows.push(`Sales cycle: ${offer.salesCycleDays} days`);
    if (offer.targetTitles.length) rows.push(`Usual buyers: ${esc(offer.targetTitles.join(', '))}`);
    for (const proof of offer.proofPoints) rows.push(`Proof: ${esc(proof)}`);
    for (const c of input.caseStudies) rows.push(`Case study: ${esc(c.clientName ?? c.title)}${c.result ? `: ${esc(c.result)}` : ''}`);
    add('offer', 'The offer', list(rows));
  }
  if (score.fitParts.length) add('fit', 'Why it fits', list(score.fitParts.map((f) => esc(`${f.label}: ${f.points} of ${f.max}. ${f.note}`.trim()))));
  const scored = p.signals.filter((s) => s.ruleText !== null);
  if (scored.length) {
    add(
      'signals',
      'Signals',
      list(
        scored.map((s) => {
          const d = date(s.occurredAt);
          const src = source(s);
          return `${d ? `${esc(d)} ` : ''}${esc(s.title)}${src ? ` (${src})` : ''}<br>${esc(s.ruleText!)}`;
        }),
      ),
    );
  }
  const topics = [...new Set(p.signals.filter((s) => s.kind === 'research').map((s) => topic(s.title)).filter(Boolean))];
  if (topics.length) add('research_topics', 'Research topics', list(topics.map(esc)));
  const others = p.matches.slice(0, OTHER_OFFERS);
  if (others.length) add('other_offers', 'Other offers that fit', list(others.map((m) => esc(`${m.name}: ${m.total}`))));
  if (score.wouldRaise.length) add('would_raise', 'What would make it stronger', list(score.wouldRaise.map(esc)));

  const buyer = p.buyer;
  const firstTouch = {
    subject: buyer ? `First touch: ${buyer.name} at ${input.account.name}` : `First touch: ${input.account.name}`,
    body: [
      buyer ? `Start with ${buyer.name}${buyer.title ? `, ${buyer.title}` : ''}${buyer.email ? ` (${buyer.email})` : ''}.` : `Start with the ${brief.whoFirst.title}.`,
      '',
      ...(opener.body ? [`Opener (${opener.label}):`, `Subject: ${opener.subject}`, opener.body] : []),
    ]
      .join('\n')
      .trim(),
  };

  return {
    sections: out,
    properties: {
      practice: input.practiceName,
      best_offer: offer?.name ?? null,
      tier: score.tier,
      fit: score.fit,
      intent: score.intent,
      priority: score.priority,
      why_now: clip(sec.why_now.text.replace(/\s*\n\s*/g, '; ').trim(), WHY_NOW_MAX),
      top_signals: datedSignals.slice(0, 3).map((s) => s.title).join('; ') || null,
      research_topics: topics.join(', ') || null,
    },
    firstTouch,
    followUps: followUps({ account: input.account, offer, signals: [...new Map([...input.signals, ...p.signals].map((s) => [s.id, s])).values()], buyer, days: p.followUpDays }),
    planSteps: [],
  };
}
