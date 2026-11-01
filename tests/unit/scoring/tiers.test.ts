import { describe, expect, it } from 'vitest';
import { applyFloors, tierFor } from '@/modules/scoring/domain/tiers';
import { daysAgo, NOW, profile } from './fixtures';

const t = (score: number, hasResearchOrTrigger = true, disqualifiedReason: string | null = null) =>
  tierFor({ score, disqualifiedReason, hasResearchOrTrigger }, profile);

describe('tierFor', () => {
  it('SCO-E6-S1-AC1: score 62 is good fit', () => {
    expect(t(62)).toBe('good_fit');
  });
  it('SCO-E6-S1-AC2: score 83 with a trigger is act now, with only pain is good fit', () => {
    expect(t(83, true)).toBe('act_now');
    expect(t(83, false)).toBe('good_fit');
  });
  it('SCO-E6-S1-AC3: score 45 is watch', () => {
    expect(t(45)).toBe('watch');
  });
  it('SCO-E6-S1-AC4: score 20 is nurture', () => {
    expect(t(20)).toBe('nurture');
  });
  it('a disqualified match is not a fit whatever the score', () => {
    expect(t(90, true, 'Excluded category')).toBe('not_fit');
  });
  it('cutoff boundaries: 75 with a trigger is act now, 74 good fit, 55 good fit, 54 watch, 35 watch, 34 nurture', () => {
    expect(t(75)).toBe('act_now');
    expect(t(74)).toBe('good_fit');
    expect(t(55)).toBe('good_fit');
    expect(t(54)).toBe('watch');
    expect(t(35)).toBe('watch');
    expect(t(34)).toBe('nurture');
  });
  it('SCO-E3-S1-AC4: changed cutoffs move the tier', () => {
    const strict = { ...profile, tierCutoffs: { actNow: 90, goodFit: 70, watch: 50 } };
    const input = { score: 60, disqualifiedReason: null, hasResearchOrTrigger: true };
    expect(tierFor(input, profile)).toBe('good_fit');
    expect(tierFor(input, strict)).toBe('watch');
  });
  it('cutoffs of 100/99/1 are honoured', () => {
    const edge = { ...profile, tierCutoffs: { actNow: 100, goodFit: 99, watch: 1 } };
    const at = (score: number) => tierFor({ score, disqualifiedReason: null, hasResearchOrTrigger: true }, edge);
    expect([at(100), at(99), at(1), at(0)]).toEqual(['act_now', 'good_fit', 'watch', 'nurture']);
  });
});

describe('applyFloors', () => {
  const base = { disqualified: false, researchTier: null, researchSignalAt: null, warmIntro: false, bestFit: 70 } as const;

  it('SCO-E3-S3-AC1: tier A with a signal 30 days old lifts watch to act now', () => {
    const r = applyFloors('watch', { ...base, researchTier: 'A', researchSignalAt: daysAgo(30) }, profile, NOW);
    expect(r).toEqual({ tier: 'act_now', tierReason: 'research_floor', text: 'Researcher rated A with a signal from Sep 14, 2026: act now' });
  });
  it('SCO-E3-S3-AC2: tier A with a signal 200 days old floors at good fit', () => {
    const r = applyFloors('watch', { ...base, researchTier: 'A', researchSignalAt: daysAgo(200) }, profile, NOW);
    expect(r.tier).toBe('good_fit');
    expect(r.tierReason).toBe('research_floor');
  });
  it('tier A with a signal exactly 180 days old still counts as recent', () => {
    expect(applyFloors('watch', { ...base, researchTier: 'A', researchSignalAt: daysAgo(180) }, profile, NOW).tier).toBe('act_now');
  });
  it('tier A with a signal 181 days old floors at good fit', () => {
    expect(applyFloors('watch', { ...base, researchTier: 'A', researchSignalAt: daysAgo(181) }, profile, NOW).tier).toBe('good_fit');
  });
  it('tier A with no signal date floors at good fit and the text has no date', () => {
    expect(applyFloors('watch', { ...base, researchTier: 'A' }, profile, NOW)).toEqual({
      tier: 'good_fit',
      tierReason: 'research_floor',
      text: 'Researcher rated A: good fit',
    });
  });
  it('a warm intro at exactly fit 40 lifts', () => {
    expect(applyFloors('watch', { ...base, warmIntro: true, bestFit: 40 }, profile, NOW).tier).toBe('good_fit');
  });
  it('SCO-E3-S3-AC3: tier B with computed act now stays act now', () => {
    expect(applyFloors('act_now', { ...base, researchTier: 'B' }, profile, NOW)).toEqual({ tier: 'act_now', tierReason: 'computed' });
  });
  it('tier B lifts watch to good fit and tier C lifts not a fit to watch', () => {
    expect(applyFloors('watch', { ...base, researchTier: 'B' }, profile, NOW).tier).toBe('good_fit');
    expect(applyFloors('not_fit', { ...base, researchTier: 'C' }, profile, NOW)).toMatchObject({ tier: 'watch', tierReason: 'research_floor' });
  });
  it('SCO-E3-S3-AC4: a disqualified account stays not a fit', () => {
    const r = applyFloors('not_fit', { ...base, disqualified: true, researchTier: 'A', researchSignalAt: daysAgo(30), warmIntro: true }, profile, NOW);
    expect(r).toEqual({ tier: 'not_fit', tierReason: 'computed' });
  });
  it('SCO-E3-S3-AC5: a warm intro with fit 45 lifts watch to good fit', () => {
    expect(applyFloors('watch', { ...base, warmIntro: true, bestFit: 45 }, profile, NOW)).toEqual({ tier: 'good_fit', tierReason: 'warm_intro_floor' });
  });
  it('a warm intro with fit 39 does not lift', () => {
    expect(applyFloors('not_fit', { ...base, warmIntro: true, bestFit: 39 }, profile, NOW)).toEqual({ tier: 'not_fit', tierReason: 'computed' });
  });
  it('a floor never lowers the computed tier', () => {
    expect(applyFloors('good_fit', { ...base, researchTier: 'C', warmIntro: true }, profile, NOW)).toEqual({ tier: 'good_fit', tierReason: 'computed' });
  });
});
