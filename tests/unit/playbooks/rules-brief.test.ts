import { describe, expect, it } from 'vitest';
import { briefOutputSchema, CITE_MESSAGE, sectionOutputSchema } from '@/modules/playbooks/domain/brief-io';
import { NO_DATED_SIGNALS, NOTHING_IN_DATA, rulesBrief, whoFirst } from '@/modules/playbooks/domain/rules-brief';
import { BRIEF_FIXTURES, FIXTURE_NOW, fixture } from './fixtures/briefs';

const sections = (o: ReturnType<typeof rulesBrief>) => Object.values(o.sections);

describe('rulesBrief', () => {
  it('writes the overview, approach, value angle, risks and why now for the transit agency', () => {
    const o = rulesBrief(fixture('transit agency with RFP'), FIXTURE_NOW);
    expect(o.sections.overview.text).toBe(
      'Metro Valley Transit, Government: Transit, based in Miami, FL, US, about 3,200 staff. Metro Valley Transit runs buses and rail for 2.7 million riders. Scout matched it to FDE Sprint with a priority of 71 (Good fit).',
    );
    expect(o.sections.overview.citations).toEqual(expect.arrayContaining(['fct_name', 'fct_emp']));
    expect(o.sections.approach.text).toBe(
      'Start with Maria Lopez, Chief Operating Officer. Ask Dana Ruiz for the intro. Lead with: We put an engineer on one workflow and get it working in weeks.',
    );
    expect(o.sections.approach.citations).toEqual(['per_maria']);
    expect(o.sections.valueAngle.text).toBe('We put an engineer on one workflow and get it working in weeks. Broward County: Cut fare reconciliation from 5 days to 1.');
    expect(o.sections.whyNow).toEqual({
      text: 'Researching: AI governance (Oct 20, 2026, Vibe Prospecting)\nMetro Valley Transit issues RFP for fare system modernization (Oct 10, 2026, Ash Patel)',
      citations: ['sig_intent', 'sig_rfp'],
    });
    expect(o.sections.risks).toEqual({ text: NOTHING_IN_DATA, citations: [] });
  });

  it('every number in rules text is cited, for every fixture', () => {
    for (const [name, input] of Object.entries(BRIEF_FIXTURES)) {
      for (const s of sections(rulesBrief(input, FIXTURE_NOW))) {
        if (/\d/.test(s.text)) expect(s.citations.length, `${name}: ${s.text}`).toBeGreaterThan(0);
      }
    }
  });

  it('says No dated signals yet. with no signals, and the risk lines that apply', () => {
    const o = rulesBrief(fixture('not a fit'), FIXTURE_NOW);
    expect(o.sections.whyNow).toEqual({ text: NO_DATED_SIGNALS, citations: [] });
    expect(o.sections.risks.text).toBe('No buyer contact yet.\nNo dated signal in the last 90 days, so timing is a guess.\nFit is below 50.');
    expect(rulesBrief(fixture('open deal'), FIXTURE_NOW).sections.risks.text).toBe('Sam Patel owns an open deal in HubSpot.');
  });

  it('uses the risks fallback line when no rule hits', () => {
    expect(rulesBrief(fixture('customer'), FIXTURE_NOW).sections.risks.text).toBe(NOTHING_IN_DATA);
  });

  it('leaves out uncitable numbers when the input has nothing to cite', () => {
    const i = fixture('not a fit');
    i.facts = [];
    const o = rulesBrief(i, FIXTURE_NOW);
    expect(o.sections.overview.text).toBe('Tiny Bakery, Retail, based in Boise, ID, US.');
    expect(o.sections.risks.text).toBe('No buyer contact yet.');
    expect(() => briefOutputSchema.parse(o)).not.toThrow();
  });

  it('who first prefers the primary, then the buying role, then the title', () => {
    expect(whoFirst(fixture('transit agency with RFP'))).toMatchObject({ personId: 'per_maria', title: 'Chief Operating Officer', reason: 'Marked as the main contact.' });
    expect(whoFirst(fixture('open deal'))).toMatchObject({ personId: 'per_raj', title: 'CFO', reason: 'Holds the Economic buyer buying role.' });
    expect(whoFirst(fixture('no people'))).toMatchObject({ personId: null, title: 'COO', reason: "COO is the offer's usual buyer." });
    expect(whoFirst(fixture('intent only'))).toMatchObject({ personId: null, title: 'CIO' });
  });

  it('opens on a public hook, never research or risk', () => {
    expect(rulesBrief(fixture('transit agency with RFP'), FIXTURE_NOW).opener).toEqual({
      subject: 'A quick idea for Metro Valley Transit',
      body: 'Hi Maria, I noticed Metro Valley Transit just brought on a new Chief Information Officer. We put an engineer on one workflow and get it working in weeks.',
    });
    expect(rulesBrief(fixture('intent only'), FIXTURE_NOW).opener.body).toBe(
      'Hi there, I work with healthcare teams a lot like yours. We give a clear go, fix first or not ready answer on AI.',
    );
  });
});

describe('the output check', () => {
  it('a section with $250K and no citations fails with the citation message', () => {
    const r = sectionOutputSchema.safeParse({ text: 'The contract is worth $250K.', citations: [] });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toBe(CITE_MESSAGE);
    expect(sectionOutputSchema.safeParse({ text: 'The contract is worth $250K.', citations: ['fct_1'] }).success).toBe(true);
    expect(sectionOutputSchema.safeParse({ text: 'No numbers here.', citations: [] }).success).toBe(true);
  });
});
