import { describe, expect, it } from 'vitest';
import { scoreTiles, warmIntro } from '@/modules/scoring/domain/tiles';
import type { ExplanationLine } from '@/modules/scoring/domain/explain';

const thresholds = { notFitBelow: 30, actNow: { fit: 70, intent: 50, total: 75 }, goodFit: { fit: 60 } };
const lines: ExplanationLine[] = [
  { group: 'fit', label: 'Industry', points: 20, max: 25, text: 'Logistics is on the offer list.' },
  { group: 'fit', label: 'Size', points: 24, max: 25, text: 'County transit agency with 3,000+ staff.' },
  { group: 'intent', label: 'Fresh funding', points: 30, max: 40, text: 'Series B, 40 days ago.', ageDays: 40 },
  { group: 'intent', label: 'New leader', points: 20, max: 30, text: 'RFP re-issue expected in December.', ageDays: 3 },
  { group: 'adjust', label: 'Warm intro from Ash Patel', points: 5, max: 10 },
  { group: 'combine', label: 'Match', points: 66, text: 'Fit 44, intent 50.' },
];

describe('scoreTiles', () => {
  it('gives five tiles in order with values, maxes and notes', () => {
    expect(scoreTiles({ priority: 66, fit: 44, intent: 50, lines, offer: 'Modernization Blueprint', datedSignals: 2 }, thresholds)).toEqual([
      { key: 'priority', label: 'Priority', value: 66, max: 100, note: 'Act now needs a priority of 75, fit 70 and buying intent 50.' },
      { key: 'fit', label: 'Fit', value: 44, max: 100, note: 'County transit agency with 3,000+ staff.' },
      { key: 'intent', label: 'Buying intent', value: 50, max: 100, note: 'RFP re-issue expected in December.' },
      { key: 'revenue_potential', label: 'Revenue potential', value: null, max: null, note: 'Arrives with enrichment' },
      { key: 'source_trust', label: 'Source trust', value: null, max: null, note: 'Not enough data yet' },
    ]);
  });

  it('says No dated signals yet. without dated signals, and has an empty fit note without fit lines', () => {
    const undated: ExplanationLine[] = [{ group: 'intent', label: 'Undated', points: 5, max: 10, text: 'Undated.' }];
    const tiles = scoreTiles({ priority: 10, fit: 0, intent: 0, lines: undated, offer: 'FDE Sprint', datedSignals: 0 }, thresholds);
    expect(tiles[1]!.note).toBe('');
    expect(tiles[2]!.note).toBe('No dated signals yet.');
  });

  it('says no signal matched an intent rule when dated signals matched none', () => {
    const fitOnly = lines.filter((l) => l.group === 'fit');
    expect(scoreTiles({ priority: 30, fit: 45, intent: 0, lines: fitOnly, offer: 'FDE Sprint', datedSignals: 1 }, thresholds)[2]!.note).toBe(
      'No signal matched an intent rule for FDE Sprint.',
    );
    expect(scoreTiles({ priority: 30, fit: 45, intent: 0, lines: fitOnly, offer: null, datedSignals: 1 }, thresholds)[2]!.note).toBe('No signal matched an intent rule.');
  });

  it('names the undated intent line when only that matched', () => {
    const undated: ExplanationLine[] = [{ group: 'intent', label: 'Researching', points: 5, max: 10, text: 'Researching AI governance.' }];
    expect(scoreTiles({ priority: 30, fit: 45, intent: 5, lines: undated, offer: 'FDE Sprint', datedSignals: 1 }, thresholds)[2]!.note).toBe('Researching AI governance.');
  });
});

describe('warmIntro', () => {
  it('names the introducer and the points, or is null', () => {
    expect(warmIntro(lines)).toEqual({ introducerName: 'Ash Patel', points: 5 });
    expect(warmIntro([{ group: 'adjust', label: 'Warm intro', points: 3, max: 10 }])).toEqual({ introducerName: null, points: 3 });
    expect(warmIntro(lines.filter((l) => l.group !== 'adjust'))).toBeNull();
  });
});
