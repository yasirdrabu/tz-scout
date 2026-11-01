import { describe, expect, it } from 'vitest';
import { isBuyerSafe } from '@/modules/playbooks/domain/buyer-safe';
import { labelFor, writtenBy } from '@/modules/playbooks/domain/labels';

const signals = [
  { type: 'intent', kind: 'research', title: 'Researching: AI governance' },
  { type: 'risk', kind: 'trigger', title: 'Security breach or outage: Plant outage after ransomware' },
  { type: 'leadership', kind: 'trigger', title: 'New leader joined: Chief Information Officer' },
];

describe('isBuyerSafe', () => {
  it('rejects an opener that quotes a research signal', () => {
    expect(isBuyerSafe('Hi Maria, I saw your team is looking into AI governance lately.', signals)).toBe(false);
  });

  it('rejects lawsuit, breach and researching, and a quoted risk signal', () => {
    expect(isBuyerSafe('Hi Jo, sorry to hear about the lawsuit.', [])).toBe(false);
    expect(isBuyerSafe('Hi Jo, after the breach you may want help.', [])).toBe(false);
    expect(isBuyerSafe('Hi Jo, your team is researching vendors.', [])).toBe(false);
    expect(isBuyerSafe('Hi Jo, the plant outage after ransomware must have hurt.', signals)).toBe(false);
  });

  it.each([
    'We saw the data breaches last spring.',
    'After the breached vendor news, we can help.',
    'The lawsuits must be a strain.',
    'I heard you were sued last year.',
    'With the litigation behind you, it is a good time.',
    'Our research shows you need help.',
    'Your team researched this topic.',
    'Our intent data says you are in market.',
  ])('rejects %s', (text) => {
    expect(isBuyerSafe(text, [])).toBe(false);
  });

  it('rejects text that quotes a staff makeup (workforce) signal', () => {
    const workforce = [{ type: 'workforce', kind: 'pain', title: 'Operations is 40% of staff' }];
    expect(isBuyerSafe('Hi Jo, operations is 40% of staff at your company.', workforce)).toBe(false);
    expect(isBuyerSafe('Hi Jo, I noticed you opened a new office.', workforce)).toBe(true);
  });

  it('passes a public leadership hook', () => {
    expect(isBuyerSafe('Hi Maria, I noticed Metro Valley Transit just brought on a new Chief Information Officer.', signals)).toBe(true);
  });
});

describe('labels', () => {
  it('names who wrote each piece', () => {
    expect(labelFor({ origin: 'ai', mode: 'live' })).toBe('Written by Claude');
    expect(labelFor({ origin: 'ai', mode: 'mock' })).toBe('Sample output');
    expect(labelFor({ origin: 'rules', mode: 'rules' })).toBe('Assembled from rules');
    expect(labelFor({ origin: 'human', mode: null, editedByName: 'Dana Ruiz' })).toBe('Edited by Dana Ruiz');
    expect([writtenBy({ origin: 'ai', mode: 'live' }), writtenBy({ origin: 'ai', mode: 'mock' }), writtenBy({ origin: 'rules', mode: 'rules' }), writtenBy({ origin: 'human', mode: null })]).toEqual([
      'claude',
      'sample',
      'rules',
      'person',
    ]);
  });
});
