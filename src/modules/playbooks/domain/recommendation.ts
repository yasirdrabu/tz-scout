// Scout's recommendation from rules (Task 2): the first case that matches wins.
import type { BriefInput, BriefOutput } from './brief-io';
import { DETAIL_MAX, HEADLINE_MAX } from './brief-io';

const DAY_MS = 86_400_000;

/** `Oct 3, 2026`. */
export const dayText = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

type Signal = BriefInput['signals'][number];

/** Signals with a date, newest first. */
export function datedSignals(input: BriefInput): (Signal & { at: Date })[] {
  return input.signals
    .flatMap((s) => (s.occurredAt ? [{ ...s, at: new Date(s.occurredAt) }] : []))
    .filter((s) => !Number.isNaN(s.at.getTime()))
    .sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id));
}

/** True when a dated signal happened in the last `days` days. */
export const hasRecentSignal = (input: BriefInput, now: Date, days: number) =>
  datedSignals(input).some((s) => now.getTime() - s.at.getTime() <= days * DAY_MS);

/** `{title} ({Mon D, YYYY}, {source})`. */
export const signalLine = (s: Signal & { at: Date }) => `${s.title} (${dayText(s.at)}${s.sourceName ? `, ${s.sourceName}` : ''})`;

/** The newest dated signal as one sentence, or `No dated signals yet.` */
export function whyNowLine(input: BriefInput): { text: string; signalId: string | null } {
  const [newest] = datedSignals(input);
  return newest ? { text: `Why now: ${signalLine(newest)}.`, signalId: newest.id } : { text: 'No dated signals yet.', signalId: null };
}

export const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 3).trimEnd()}...`);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function recommendation(input: BriefInput): BriefOutput['recommendation'] {
  const why = whyNowLine(input).text;
  const out = (headline: string, detail: string) => ({ headline: clip(headline, HEADLINE_MAX), detail: clip(detail.trim(), DETAIL_MAX) });
  const crm = input.crm;
  if (crm && (crm.lifecycle === 'open_deal' || crm.lifecycle === 'customer')) {
    const owner = crm.ownerName ?? 'the HubSpot owner';
    const what = crm.lifecycle === 'open_deal' ? 'an open deal' : 'a customer record';
    return out(`Check with ${owner} before assigning.`, `${capital(owner)} owns ${what} on this company in HubSpot. ${why}`);
  }
  const { tier, fit, intent } = input.score;
  if (tier === 'act_now' || tier === 'good_fit') {
    const warm = input.warmIntro ? ` Warm intro available through ${input.warmIntro.introducerName}.` : '';
    return out(`Approve and assign to someone who covers ${input.practiceName ?? 'this offer'}.`, `${why}${warm}`);
  }
  if (tier === 'watch') {
    const raise = input.score.wouldRaise[0];
    return out('Keep it in review until a stronger signal arrives.', `Fit is ${fit} and buying intent is ${intent}.${raise ? ` ${raise}` : ''}`);
  }
  const lowest = [...input.score.fitParts].sort((a, b) => a.points / (a.max || 1) - b.points / (b.max || 1))[0];
  return out('Send it back or decline it.', lowest?.note ?? `Fit is ${fit}.`);
}
