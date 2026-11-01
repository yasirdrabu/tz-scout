import { describe, expect, it } from 'vitest';
import { recommendation } from '@/modules/playbooks/domain/recommendation';
import { fixture } from './fixtures/briefs';

describe('recommendation', () => {
  it('an open deal says to check with the owner first', () => {
    expect(recommendation(fixture('open deal'))).toEqual({
      headline: 'Check with Sam Patel before assigning.',
      detail: 'Sam Patel owns an open deal on this company in HubSpot. Why now: Security breach or outage: Plant outage after ransomware (Oct 15, 2026, Research agent).',
    });
  });

  it('a customer names the customer record', () => {
    const r = recommendation(fixture('customer'));
    expect(r.headline).toBe('Check with Lee Wong before assigning.');
    expect(r.detail).toMatch(/^Lee Wong owns a customer record on this company in HubSpot\. Why now: /);
  });

  it('act now and good fit say to approve and assign, with the warm intro', () => {
    const r = recommendation(fixture('transit agency with RFP'));
    expect(r.headline).toBe('Approve and assign to someone who covers Digital Transformation.');
    expect(r.detail).toBe('Why now: Researching: AI governance (Oct 20, 2026, Vibe Prospecting). Warm intro available through Dana Ruiz.');
    expect(recommendation(fixture('no people')).headline).toBe('Approve and assign to someone who covers AI Strategy.');
  });

  it('watch keeps it in review with fit, intent and the first would-raise line', () => {
    expect(recommendation(fixture('intent only'))).toEqual({
      headline: 'Keep it in review until a stronger signal arrives.',
      detail: 'Fit is 55 and buying intent is 30. A signal for New leader would raise the score.',
    });
  });

  it('watch turns a would-raise phrase into a whole sentence', () => {
    const i = fixture('intent only');
    i.score = { ...i.score, fit: 45, intent: 0, wouldRaise: ['Revenue on file', 'A signal for RFP'] };
    expect(recommendation(i).detail).toBe('Fit is 45 and buying intent is 0. Revenue on file would raise the score.');
  });

  it('a detail over the cap ends at a sentence, not mid-word', () => {
    const i = fixture('open deal');
    i.crm = { ...i.crm!, ownerName: `Sam ${'Patel'.repeat(100)}` };
    const { detail } = recommendation(i);
    expect(detail.length).toBeLessThanOrEqual(600);
    expect(detail).toMatch(/HubSpot\.$/);
  });

  it('not a fit names the lowest fit part', () => {
    expect(recommendation(fixture('not a fit'))).toEqual({
      headline: 'Send it back or decline it.',
      detail: "6 staff is below the smallest offer's range.",
    });
  });

  it('no dated signals says so', () => {
    const i = fixture('transit agency with RFP');
    i.signals = [];
    i.warmIntro = null;
    expect(recommendation(i).detail).toBe('No dated signals yet.');
  });
});
