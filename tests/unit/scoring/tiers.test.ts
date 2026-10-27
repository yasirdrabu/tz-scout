import { describe, expect, it } from 'vitest';
import { applyFloors, tierFor } from '@/modules/scoring/domain/tiers';
import { daysAgo, NOW, profile } from './fixtures';

const t = (fit: number, intent: number, total: number, hasResearchOrTrigger = true, disqualifiedReason: string | null = null) =>
  tierFor({ fit, intent, total, disqualifiedReason, hasResearchOrTrigger }, profile);

describe('tierFor', () => {
  it('SCO-E3-S1-AC1: fit 65, intent 40, total 54 is good fit', () => {
    expect(t(65, 40, 54)).toBe('good_fit');
  });
  it('SCO-E3-S1-AC2: fit 70, intent 50, total 61 with a trigger is act now, with only pain is good fit', () => {
    expect(t(70, 50, 61, true)).toBe('act_now');
    expect(t(70, 50, 61, false)).toBe('good_fit');
  });
  it('SCO-E3-S1-AC3: fit 35 is not a fit whatever the intent', () => {
    expect(t(35, 100, 35)).toBe('not_fit');
  });
  it('a disqualified match is not a fit', () => {
    expect(t(90, 90, 90, true, 'Excluded category')).toBe('not_fit');
  });
  it('fit between 40 and 59 is watch; fit 40 is not below the threshold', () => {
    expect(t(40, 100, 40)).toBe('watch');
    expect(t(59, 100, 59)).toBe('watch');
  });
  it('act now boundaries: intent 34/35, total 59/60, fit 59/60', () => {
    expect(t(70, 34, 61)).toBe('good_fit');
    expect(t(70, 35, 61)).toBe('act_now');
    expect(t(70, 50, 59)).toBe('good_fit');
    expect(t(70, 50, 60)).toBe('act_now');
    expect(t(59, 50, 61)).toBe('watch');
    expect(t(60, 50, 61)).toBe('act_now');
  });
  it('SCO-E3-S1-AC4: a changed threshold moves the tier', () => {
    const strict = { ...profile, tierThresholds: { ...profile.tierThresholds, notFitBelow: 50 } };
    const input = { fit: 45, intent: 10, total: 45, disqualifiedReason: null, hasResearchOrTrigger: false };
    expect(tierFor(input, profile)).toBe('watch');
    expect(tierFor(input, strict)).toBe('not_fit');
  });
});

describe('applyFloors', () => {
  const base = { disqualified: false, researchTier: null, researchSignalAt: null, warmIntro: false, bestFit: 70 } as const;

  it('SCO-E3-S3-AC1: tier A with a signal 30 days old lifts watch to act now', () => {
    const r = applyFloors('watch', { ...base, researchTier: 'A', researchSignalAt: daysAgo(30) }, profile, NOW);
    expect(r).toEqual({ tier: 'act_now', tierReason: 'research_floor', text: 'Researcher rated A with a signal from 2026-09-14: act now' });
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
