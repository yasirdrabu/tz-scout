// Intent: is there a reason to buy now? Scores an offer's signal rules against dated signals (SCO-E1).

import { SIGNAL_TYPES } from '@/modules/accounts';
import type { RuleHit, ScoringAccount, ScoringProfile, ScoringRule, ScoringSignal } from '../contracts/types';
import { norm } from './fit';

const DAY_MS = 86400_000;
/** Types that describe the current state of the company, so they do not fade. */
const CURRENT_STATE = new Set(['tech', 'growth', 'workforce']);

/** Research scores arrive as 0 to 1 or 0 to 100. This is the one place that reads them as 0 to 1. */
export function researchScore(value: number): number {
  return value > 1 ? value / 100 : value;
}

/** Whole words only for short keywords (AI, VB6), so "AI" does not match "paid". */
function keywordHit(text: string, keyword: string): boolean {
  const k = norm(keyword);
  if (!k) return false;
  return k.length <= 3 ? ` ${text} `.includes(` ${k} `) : text.includes(k);
}

const matchesKeywords = (text: string, keywords: string[]) => keywords.length === 0 || keywords.some((k) => keywordHit(text, k));

/** When a signal happened; with no date, the day it was recorded. */
function signalDate(s: ScoringSignal): Date {
  if (s.occurredAt) return s.occurredAt;
  return new Date(Math.floor(s.recordedAt.getTime() / DAY_MS) * DAY_MS);
}

function recency(type: string, at: Date, now: Date, profile: ScoringProfile): number {
  if (CURRENT_STATE.has(type)) return 1;
  const age = (now.getTime() - at.getTime()) / DAY_MS;
  if (age > profile.maxSignalAgeDays) return 0;
  return Math.pow(0.5, Math.max(0, age) / profile.halfLifeDays);
}

/** A research score of 0.60 counts half, 0.80 or more counts fully. */
const intensity = (score: number) => Math.max(0, Math.min(1, (score - 0.4) / 0.4));

type Strength = { r: number; id: string | null; matched: string };

function signalStrengths(rule: ScoringRule, signals: ScoringSignal[], now: Date, profile: ScoringProfile): Strength[] {
  const out: Strength[] = [];
  for (const s of signals) {
    if (s.type !== rule.type) continue;
    const research = s.kind === 'research';
    const value = s.value == null ? null : research ? researchScore(s.value) : s.value;
    if (rule.minValue != null && (value == null || value < rule.minValue)) continue;
    if (!matchesKeywords(norm(`${s.title} ${s.detail ?? ''}`), rule.match)) continue;
    const r = recency(rule.type, signalDate(s), now, profile) * (research && value != null ? intensity(value) : 1);
    if (r > 0) out.push({ r, id: s.id, matched: s.title });
  }
  return out;
}

function strengthsFor(rule: ScoringRule, account: ScoringAccount, signals: ScoringSignal[], now: Date, profile: ScoringProfile): Strength[] {
  if (rule.type === 'growth' && rule.match.length === 0 && account.headcountGrowth6m != null) {
    // Growth is a current value on the account; an old growth signal must not outvote it.
    const g = account.headcountGrowth6m;
    const ok = rule.minValue != null ? g >= rule.minValue : g > 0;
    return ok ? [{ r: 1, id: null, matched: `Headcount up ${Math.round(g * 100)}% in six months` }] : [];
  }
  const out = signalStrengths(rule, signals, now, profile);
  if (rule.type === 'tech') {
    for (const t of account.technologies) {
      if (matchesKeywords(norm(t), rule.match)) out.push({ r: 1, id: null, matched: t });
    }
  }
  return out;
}

export function intent(
  account: ScoringAccount,
  signals: ScoringSignal[],
  rules: ScoringRule[],
  profile: ScoringProfile,
  now: Date,
): { intent: number; hits: RuleHit[] } {
  const hits: RuleHit[] = [];
  for (const rule of rules) {
    if (!rule.enabled || !Object.hasOwn(SIGNAL_TYPES, rule.type)) continue;
    const strengths = strengthsFor(rule, account, signals, now, profile).sort((x, y) => y.r - x.r);
    if (strengths.length === 0) continue;
    const kind = SIGNAL_TYPES[rule.type as keyof typeof SIGNAL_TYPES].kind;
    // The strongest signal counts fully; more of the same add a little (30%, then 15%).
    // Not for research: related topics ("AI strategy", "AI readiness") are one surge under several labels.
    const factor =
      kind === 'research' ? strengths[0]!.r : Math.min(1, strengths[0]!.r + 0.3 * (strengths[1]?.r ?? 0) + 0.15 * (strengths[2]?.r ?? 0));
    hits.push({
      ruleId: rule.id,
      label: rule.label,
      type: rule.type,
      kind,
      points: Math.round(rule.weight * factor * 10) / 10,
      max: rule.weight,
      signalIds: strengths.map((x) => x.id).filter((x): x is string => x !== null),
      matched: strengths.slice(0, 3).map((x) => x.matched),
      why: rule.why,
    });
  }
  hits.sort((x, y) => y.points - x.points);
  return { intent: Math.round(Math.min(100, hits.reduce((s, h) => s + h.points, 0))), hits };
}
