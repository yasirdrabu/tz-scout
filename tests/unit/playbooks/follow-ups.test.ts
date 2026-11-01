import { describe, expect, it } from 'vitest';
import { followUps } from '@/modules/playbooks/domain/follow-ups';
import { fixture } from './fixtures/briefs';

const transit = fixture('transit agency with RFP');
const base = {
  account: transit.account,
  offer: transit.offer,
  signals: transit.signals,
  buyer: { name: 'Maria Lopez' },
};

describe('followUps (Ruling 10)', () => {
  it('days [3, 7, 14] give New angle, Proof, Close the loop', () => {
    const out = followUps({ ...base, days: [3, 7, 14] });
    expect(out.map((f) => f.day)).toEqual([3, 7, 14]);
    expect(out.map((f) => f.subject)).toEqual([
      'Follow-up 1 of 3 (day 3): New angle, email Maria Lopez',
      'Follow-up 2 of 3 (day 7): Proof, email Maria Lopez',
      'Follow-up 3 of 3 (day 14): Close the loop, email Maria Lopez',
    ]);
    for (const f of out) {
      expect(f.body.startsWith('Hi Maria,')).toBe(true);
      expect(f.body.endsWith('(Assembled from rules)')).toBe(true);
    }
  });

  it('one day only is Close the loop; four days put Proof in the middle', () => {
    expect(followUps({ ...base, days: [5] }).map((f) => f.subject)).toEqual(['Follow-up 1 of 1 (day 5): Close the loop, email Maria Lopez']);
    expect(followUps({ ...base, days: [2, 4, 6, 9] }).map((f) => f.subject.split(': ')[1])).toEqual([
      'New angle, email Maria Lopez',
      'Proof, email Maria Lopez',
      'Proof, email Maria Lopez',
      'Close the loop, email Maria Lopez',
    ]);
  });

  it('with no buyer, emails the account and greets "there"', () => {
    const [f] = followUps({ ...base, buyer: null, days: [3] });
    expect(f!.subject).toBe('Follow-up 1 of 1 (day 3): Close the loop, email Metro Valley Transit');
    expect(f!.body.startsWith('Hi there,')).toBe(true);
  });

  it('never quotes research intent, a lawsuit or a breach (PLB-E3-S4-AC4)', () => {
    const signals = [
      { id: 'sig_r', type: 'intent', kind: 'research' as const, title: 'Researching: AI governance', occurredAt: null, sourceName: null },
      { id: 'sig_l', type: 'news', kind: 'trigger' as const, title: 'Lawsuit filed over rider data', occurredAt: null, sourceName: null },
      { id: 'sig_b', type: 'risk', kind: 'trigger' as const, title: 'Data breach at the depot', occurredAt: null, sourceName: null },
      ...transit.signals,
    ];
    const out = followUps({ ...base, signals, days: [3, 7, 14] });
    for (const f of out) expect(f.body).not.toMatch(/governance|lawsuit|breach|researching/i);
  });

  it('is empty with no offer, so the CRM keeps its own tasks', () => {
    expect(followUps({ ...base, offer: null, days: [3, 7, 14] })).toEqual([]);
  });
});
