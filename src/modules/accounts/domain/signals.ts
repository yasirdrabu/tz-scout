// Signal types, kinds and duplicate keys (ACC-E4). Labels, kinds and explainers carried from v1 matching.ts.

import type { SignalKind } from '../contracts/types';

export type SignalType = 'intent' | 'leadership' | 'funding' | 'news' | 'risk' | 'hiring' | 'growth' | 'workforce' | 'tech';

export const SIGNAL_TYPES: Record<SignalType, { label: string; kind: SignalKind; what: string; read: string }> = {
  intent: {
    label: 'Researching',
    kind: 'research',
    what: 'People at this company are reading about this topic across business sites, well above their normal level. Source: Vibe Prospecting research-intent data.',
    read: "Scores run 0 to 100. 60 or more means active research and earns half the rule's points; 80 or more is a strong spike and earns them all. It's the closest thing to a company telling us what it's trying to buy.",
  },
  leadership: {
    label: 'Leadership change',
    kind: 'trigger',
    what: 'A new executive joined, or a key leader is leaving.',
    read: 'New leaders review what\'s working in their first 90 days and have room to start new work. A retirement or departure puts knowledge and systems at risk.',
  },
  funding: {
    label: 'Funding',
    kind: 'trigger',
    what: 'New investment, a funding round, or a private equity deal.',
    read: 'Fresh money comes with a plan to grow or improve margins, and a board asking how. Budgets are open.',
  },
  news: {
    label: 'Company event',
    kind: 'trigger',
    what: 'A company event: acquisition or merger, new office, new product, new partnership, or cost cutting.',
    read: 'Mergers mean systems and teams to combine. Expansion means processes that have to scale. Cost cutting means a mandate to do more with less.',
  },
  risk: {
    label: 'Risk event',
    kind: 'trigger',
    what: 'A security breach, outage, or lawsuit was reported.',
    read: 'Risk events force leadership to ask how safe their systems and AI use really are. Short windows; act within weeks.',
  },
  hiring: {
    label: 'Hiring',
    kind: 'pain',
    what: 'Open job posts, or a hiring push in one department.',
    read: 'Hiring people for repetitive work, or to keep old systems running, shows a problem a workflow or a rebuild could solve.',
  },
  growth: {
    label: 'Headcount growth',
    kind: 'pain',
    what: 'How fast headcount grew over the last six months.',
    read: 'Fast growth strains processes built for a smaller company. Ten percent or more in six months is meaningful.',
  },
  workforce: {
    label: 'Team makeup',
    kind: 'pain',
    what: "How the company's people are split across departments, and which departments are growing.",
    read: 'A large or growing operations team usually means manual work at scale, which is where automation pays back fastest.',
  },
  tech: {
    label: 'Tech stack',
    kind: 'pain',
    what: 'Software the company runs, detected from its websites, job posts and other public sources.',
    read: 'Old systems point to modernization. AI tools already in use, without governance, point to a readiness review.',
  },
};

export function kindFor(type: string): SignalKind | null {
  return Object.hasOwn(SIGNAL_TYPES, type) ? SIGNAL_TYPES[type as SignalType].kind : null;
}

const TITLE_RULES: { type: SignalType; pattern: RegExp }[] = [
  { type: 'funding', pattern: /\b(raised|series [a-z])\b/i },
  { type: 'leadership', pattern: /\b(named|appointed|joins as)\b/i },
  { type: 'hiring', pattern: /\b(hiring|job posting)\b/i },
];

/** A fine type guessed from the title, only when that type has the given kind. */
export function fineTypeFromTitle(kind: SignalKind, title: string): SignalType | null {
  const rule = TITLE_RULES.find((r) => r.pattern.test(title));
  return rule && SIGNAL_TYPES[rule.type].kind === kind ? rule.type : null;
}

export type DedupInput = {
  source: string;
  externalId: string | null;
  url: string | null;
  kind: SignalKind;
  title: string;
  /** For an undated research signal, the arrival date. */
  occurredAt: Date;
};

/** Two signals on one account with any key in common are the same signal. */
export function signalDedupKeys(s: DedupInput): string[] {
  const day = s.occurredAt.toISOString().slice(0, 10);
  const keys: string[] = [];
  if (s.externalId) keys.push(`ext:${s.source}:${s.externalId}`);
  const url = s.url?.trim().replace(/\/+$/, '').toLowerCase();
  if (url) keys.push(`url:${url}:${day}`);
  const title = s.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  keys.push(`title:${s.kind}:${title}:${day}`);
  return keys;
}
