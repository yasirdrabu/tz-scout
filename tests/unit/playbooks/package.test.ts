import { describe, expect, it } from 'vitest';
import { buildPackage, rulesPackageBrief, type PackageInput, type PackageSignal } from '@/modules/playbooks/domain/package';
import { rulesBrief } from '@/modules/playbooks/domain/rules-brief';
import { FIXTURE_NOW, fixture } from './fixtures/briefs';

const input = fixture('transit agency with RFP');

const signals: PackageSignal[] = input.signals.map((s) => ({
  ...s,
  url: `https://news.example/${s.id}`,
  ruleText: s.id === 'sig_cio' ? null : `Rule text for ${s.id}.`,
}));

const pkgInput = (over: Partial<PackageInput> = {}): PackageInput => ({
  brief: rulesPackageBrief(rulesBrief(input, FIXTURE_NOW)),
  input,
  signals,
  matches: [
    { name: 'AgentReady', total: 58 },
    { name: 'Smart Space', total: 41 },
    { name: 'Brain', total: 30 },
    { name: 'Blueprint', total: 20 },
  ],
  followUpDays: [3, 7, 14],
  buyer: { name: 'Maria Lopez', title: 'Chief Operating Officer', email: 'maria@metro.example' },
  ...over,
});

const section = (p: ReturnType<typeof buildPackage>, key: string) => p.sections.find((s) => s.key === key);

describe('buildPackage (PLB-E3-S4)', () => {
  it('gives the sections in order with their labels', () => {
    const p = buildPackage(pkgInput());
    expect(p.sections.map((s) => [s.key, s.label])).toEqual([
      ['score', 'Score'],
      ['recommendation', "Scout's recommendation"],
      ['why_now', 'Why now'],
      ['how_to_approach', 'How to approach'],
      ['overview', 'Overview'],
      ['value_angle', 'Our value angle'],
      ['risks', 'Risks and watch-outs'],
      ['offer', 'The offer'],
      ['fit', 'Why it fits'],
      ['signals', 'Signals'],
      ['research_topics', 'Research topics'],
      ['other_offers', 'Other offers that fit'],
      ['would_raise', 'What would make it stronger'],
    ]);
    expect(section(p, 'score')!.html).toContain('Good fit: priority 71, fit 78, buying intent 60.');
    expect(section(p, 'fit')!.html).toContain("Industry: 25 of 25. Government is on the offer's list.");
    expect(section(p, 'offer')!.html).toContain('$40,000 to $120,000');
    expect(section(p, 'offer')!.html).toContain('60 days');
    expect(section(p, 'offer')!.html).toContain('Broward County: Cut fare reconciliation from 5 days to 1');
    expect(section(p, 'other_offers')!.html).toContain('AgentReady: 58');
    expect(section(p, 'other_offers')!.html).not.toContain('Blueprint');
    expect(section(p, 'why_now')!.html).toContain('<a href="https://news.example/sig_rfp">Ash Patel</a>');
    expect(p.planSteps).toEqual([]);
  });

  it('marks every brief-made piece of a rules package Assembled from rules (AC3)', () => {
    const p = buildPackage(pkgInput());
    for (const key of ['recommendation', 'why_now', 'overview', 'value_angle', 'risks']) {
      expect(section(p, key)!.html, key).toMatch(/<p><em>Assembled from rules<\/em><\/p>$/);
    }
    expect(section(p, 'how_to_approach')!.html.match(/<em>Assembled from rules<\/em>/g)).toHaveLength(3);
    expect(p.firstTouch!.body).toContain('Opener (Assembled from rules):');
    for (const f of p.followUps) expect(f.body).toMatch(/\(Assembled from rules\)$/);
  });

  it('an edited section carries Edited by', () => {
    const brief = rulesPackageBrief(rulesBrief(input, FIXTURE_NOW));
    brief.sections.overview = { text: 'They run the second-largest bus fleet in Florida.', label: 'Edited by Dana Ruiz' };
    const html = section(buildPackage(pkgInput({ brief })), 'overview')!.html;
    expect(html).toContain('They run the second-largest bus fleet in Florida.');
    expect(html).toContain('<em>Edited by Dana Ruiz</em>');
  });

  it('puts research intent and a lawsuit in Signals, never in the first touch or follow-ups (AC4)', () => {
    const p = buildPackage(pkgInput());
    const sig = section(p, 'signals')!.html;
    expect(sig).toContain('Researching: AI governance');
    expect(sig).toContain('Lawsuit: Rider data class action');
    expect(sig).toContain('Rule text for sig_suit.');
    expect(sig).not.toContain('New leader joined');
    expect(section(p, 'research_topics')!.html).toContain('AI governance');
    const buyerText = [p.firstTouch!.subject, p.firstTouch!.body, ...p.followUps.flatMap((f) => [f.subject, f.body])].join('\n');
    expect(buyerText).not.toMatch(/governance|lawsuit|breach|researching/i);
  });

  it('replaces an opener that is not buyer safe with the rules opener', () => {
    const brief = rulesPackageBrief(rulesBrief(input, FIXTURE_NOW));
    const rulesOpener = brief.opener.body;
    brief.opener = { subject: 'About the lawsuit', body: 'Hi Maria, I saw the rider data class action.', label: 'Written by Claude' };
    const p = buildPackage(pkgInput({ brief }));
    expect(p.firstTouch!.body).toContain(rulesOpener);
    expect(p.firstTouch!.body).toContain('Opener (Assembled from rules):');
    expect(p.firstTouch!.body).not.toContain('class action');
  });

  it('writes the first touch from the buyer and the opener', () => {
    const p = buildPackage(pkgInput());
    expect(p.firstTouch!.subject).toBe('First touch: Maria Lopez at Metro Valley Transit');
    const lines = p.firstTouch!.body.split('\n');
    expect(lines.slice(0, 4)).toEqual([
      'Start with Maria Lopez, Chief Operating Officer (maria@metro.example).',
      '',
      'Opener (Assembled from rules):',
      'Subject: A quick idea for Metro Valley Transit',
    ]);
    const none = buildPackage(pkgInput({ buyer: null }));
    expect(none.firstTouch!.subject).toBe('First touch: Metro Valley Transit');
    expect(none.firstTouch!.body.split('\n')[0]).toBe('Start with the Chief Operating Officer.');
  });

  it('fills the CRM properties', () => {
    const p = buildPackage(pkgInput());
    expect(p.properties).toEqual({
      practice: 'Digital Transformation',
      best_offer: 'FDE Sprint',
      tier: 'good_fit',
      fit: 78,
      intent: 60,
      priority: 71,
      why_now: expect.stringContaining('Metro Valley Transit issues RFP'),
      top_signals: 'Researching: AI governance; Metro Valley Transit issues RFP for fare system modernization; New leader joined: Chief Information Officer',
      research_topics: 'AI governance',
    });
  });

  it('escapes everything and leaves out sections with no data', () => {
    const i = fixture('transit agency with RFP');
    i.account.name = 'A <b>bold</b> & co';
    i.offer = null;
    i.score.fitParts = [];
    i.score.wouldRaise = [];
    const p = buildPackage(pkgInput({ input: i, matches: [], signals: [] }));
    expect(p.sections.map((s) => s.key)).toEqual(['score', 'recommendation', 'why_now', 'how_to_approach', 'overview', 'value_angle', 'risks']);
    expect(p.sections.map((s) => s.html).join('')).not.toContain('<b>');
    expect(p.followUps).toEqual([]);
  });

  it('drops a source link that is not http(s)', () => {
    const bad = signals.map((s) => ({ ...s, url: 'javascript:alert(1)' }));
    expect(section(buildPackage(pkgInput({ signals: bad })), 'why_now')!.html).not.toContain('javascript:');
  });
});
