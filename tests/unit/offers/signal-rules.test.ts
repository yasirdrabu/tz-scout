import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIGNAL_RULES,
  GENERIC_SIGNAL_RULES,
  SIGNAL_TYPE_KEYS,
  signalRuleProblems,
  type SignalRuleInput,
} from '@/modules/offers/domain/signal-rules';

const rule = (over: Partial<SignalRuleInput> = {}): SignalRuleInput => ({
  type: 'intent',
  label: 'Researching AI',
  weight: 40,
  match: ['ai strategy'],
  minValue: 0.6,
  why: 'They are researching the problem.',
  enabled: true,
  ...over,
});

const messages = (rules: SignalRuleInput[]) => signalRuleProblems(rules).map((p) => `${p.path}: ${p.message}`);

describe('signalRuleProblems', () => {
  it('accepts a good rule and the limits themselves', () => {
    expect(signalRuleProblems([rule()])).toEqual([]);
    expect(
      signalRuleProblems([
        rule({
          weight: 100,
          label: 'x'.repeat(120),
          why: 'y'.repeat(500),
          match: Array.from({ length: 30 }, () => 'k'.repeat(60)),
          minValue: null,
        }),
      ]),
    ).toEqual([]);
    expect(signalRuleProblems([rule({ weight: 0 })])).toEqual([]);
    expect(signalRuleProblems(Array.from({ length: 50 }, () => rule()))).toEqual([]);
  });

  it('lists the nine signal types', () => {
    expect([...SIGNAL_TYPE_KEYS].sort()).toEqual(
      ['intent', 'leadership', 'funding', 'news', 'risk', 'hiring', 'growth', 'workforce', 'tech'].sort(),
    );
  });

  it('refuses more than 50 rules', () => {
    expect(messages(Array.from({ length: 51 }, () => rule()))).toEqual(['rules: Use at most 50 signal rules.']);
  });

  it('refuses an unknown type', () => {
    expect(messages([rule({ type: 'vibes' })])).toEqual(['rules.0.type: Pick a signal type.']);
  });

  it('refuses a blank or long label', () => {
    expect(messages([rule({ label: '  ' })])).toEqual(['rules.0.label: Add a label.']);
    expect(messages([rule({ label: 'x'.repeat(121) })])).toEqual(['rules.0.label: Keep the label to 120 characters.']);
  });

  it('refuses points outside 0 to 100 or not whole', () => {
    const msg = 'rules.0.weight: Points must be a whole number from 0 to 100.';
    expect(messages([rule({ weight: -1 })])).toEqual([msg]);
    expect(messages([rule({ weight: 101 })])).toEqual([msg]);
    expect(messages([rule({ weight: 10.5 })])).toEqual([msg]);
    expect(messages([rule({ weight: Number.NaN })])).toEqual([msg]);
  });

  it('refuses more than 30 keywords or one over 60 characters', () => {
    expect(messages([rule({ match: Array.from({ length: 31 }, () => 'k') })])).toEqual([
      'rules.0.match: Use at most 30 keywords per rule.',
    ]);
    expect(messages([rule({ match: ['ok', 'k'.repeat(61)] })])).toEqual([
      'rules.0.match.1: Keep each keyword to 60 characters.',
    ]);
  });

  it('refuses a minimum that is not a number', () => {
    expect(messages([rule({ minValue: Number.POSITIVE_INFINITY })])).toEqual([
      'rules.0.minValue: The minimum must be a number from 0 up.',
    ]);
    expect(messages([rule({ minValue: -0.1 })])).toEqual(['rules.0.minValue: The minimum must be a number from 0 up.']);
  });

  it('requires a why of at most 500 characters', () => {
    expect(messages([rule({ why: '   ' })])).toEqual(['rules.0.why: Add why this signal matters.']);
    expect(messages([rule({ why: 'y'.repeat(501) })])).toEqual(['rules.0.why: Keep the reason to 500 characters.']);
  });

  it('reports every rule that has a problem', () => {
    expect(messages([rule({ why: '' }), rule(), rule({ label: '' })])).toEqual([
      'rules.0.why: Add why this signal matters.',
      'rules.2.label: Add a label.',
    ]);
  });
});

describe('default rules', () => {
  const all = [...Object.values(DEFAULT_SIGNAL_RULES).flat(), ...GENERIC_SIGNAL_RULES];
  it('carry the v1 sets and pass validation', () => {
    expect(Object.keys(DEFAULT_SIGNAL_RULES).sort()).toEqual([
      'agentready-diagnostic',
      'ai-opportunity-map',
      'company-brain',
      'fde-sprint',
      'modernization-blueprint',
      'smart-space-poc',
    ]);
    expect(DEFAULT_SIGNAL_RULES['modernization-blueprint']).toHaveLength(6);
    expect(GENERIC_SIGNAL_RULES).toHaveLength(4);
    expect(signalRuleProblems(all.map((r) => ({ ...r, enabled: true })))).toEqual([]);
  });
});
