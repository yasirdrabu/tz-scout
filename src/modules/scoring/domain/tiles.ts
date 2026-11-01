// The account page's score strip (screens.md §4a item 3): five tiles, each a value out of 100 or none, and a note.
import type { TierThresholds } from '../contracts/types';
import type { ExplanationLine } from './explain';

export type ScoreTile = { key: string; label: string; value: number | null; max: 100 | null; note: string };

export const NO_DATED_SIGNALS = 'No dated signals yet.';

/** The newest dated intent line; without one, why: no dated signals at all, or dated signals that matched no intent rule. */
function intentNote(lines: ExplanationLine[], offer: string | null, datedSignals: number): string {
  const intent = lines.filter((l) => l.group === 'intent');
  const newest = intent.filter((l) => l.ageDays !== undefined).reduce<ExplanationLine | null>((best, l) => (!best || l.ageDays! < best.ageDays! ? l : best), null);
  if (newest?.text) return newest.text;
  if (datedSignals === 0) return NO_DATED_SIGNALS;
  return intent.find((l) => l.text)?.text ?? (offer ? `No signal matched an intent rule for ${offer}.` : 'No signal matched an intent rule.');
}

/**
 * Priority, Fit, Buying intent, then Revenue potential and Source trust, which have no value in R1.
 * `offer` is the explained offer's name; `datedSignals` counts the account's signals that have a date.
 */
export function scoreTiles(
  e: { priority: number; fit: number; intent: number; lines: ExplanationLine[]; offer: string | null; datedSignals: number },
  thresholds: TierThresholds,
): ScoreTile[] {
  const fitTop = e.lines.filter((l) => l.group === 'fit').reduce<ExplanationLine | null>((best, l) => (!best || (l.points ?? 0) > (best.points ?? 0) ? l : best), null);
  const a = thresholds.actNow;
  return [
    { key: 'priority', label: 'Priority', value: e.priority, max: 100, note: `Act now needs a priority of ${a.total}, fit ${a.fit} and buying intent ${a.intent}.` },
    { key: 'fit', label: 'Fit', value: e.fit, max: 100, note: fitTop?.text ?? '' },
    { key: 'intent', label: 'Buying intent', value: e.intent, max: 100, note: intentNote(e.lines, e.offer, e.datedSignals) },
    { key: 'revenue_potential', label: 'Revenue potential', value: null, max: null, note: 'Arrives with enrichment' },
    { key: 'source_trust', label: 'Source trust', value: null, max: null, note: 'Not enough data yet' },
  ];
}

/** The warm intro the score counted, with who offered it (null when the declaration named nobody). */
export function warmIntro(lines: ExplanationLine[]): { introducerName: string | null; points: number } | null {
  const l = lines.find((x) => x.group === 'adjust' && x.label.startsWith('Warm intro'));
  if (!l) return null;
  return { introducerName: l.label === 'Warm intro' ? null : l.label.slice('Warm intro from '.length), points: l.points ?? 0 };
}
