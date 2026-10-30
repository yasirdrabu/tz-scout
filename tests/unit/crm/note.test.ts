import { describe, expect, it } from 'vitest';
import { noteFingerprint as original } from '@/modules/crm/domain/fingerprint';
import { NOTE_LIMIT, buildNote, noteFingerprint, type NoteInput } from '@/modules/crm/domain/note';

const URL = 'https://app.example.com/t/acme/accounts/acc_1';
const input = (over: Partial<NoteInput> = {}): NoteInput => ({
  account: { name: 'Acme', industry: 'Software', employees: 1200, hqCity: 'Austin', hqState: 'TX', hqCountry: 'US', description: 'Makes things', technologies: ['AWS', 'React'] },
  people: [
    { firstName: 'Sam', lastName: 'Roe', title: 'VP Eng', email: 'sam@acme.com', emailStatus: 'valid', isPrimary: false, roles: [{ key: 'influencer' }] },
    { firstName: 'Dana', lastName: 'Lee', title: 'CTO', email: 'dana@acme.com', emailStatus: 'valid', isPrimary: true, roles: [{ key: 'decision_maker' }] },
  ],
  assignmentNote: 'Take this one',
  ownerLine: 'Owner: Pat (reassigned from Lou)',
  scoutUrl: URL,
  dataAsOf: new Date('2026-10-28T10:00:00Z'),
  pkg: null,
  ...over,
});
const positions = (html: string, parts: string[]) => parts.map((p) => html.indexOf(p));
const ascending = (xs: number[]) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]!));

describe('buildNote', () => {
  it('orders the account sections and ends with the Scout link when there is no package', () => {
    const { html, droppedSections } = buildNote(input());
    expect(droppedSections).toEqual([]);
    expect(ascending(positions(html, ['People', 'About Acme', 'Data as of 2026-10-28', 'Take this one', 'reassigned from Lou', `Open in Scout: <a href="${URL}">`]))).toBe(true);
    expect(html.indexOf('Dana')).toBeLessThan(html.indexOf('Sam'));
    expect(html).toContain('Buying role: decision maker');
    expect(html).toContain('dana@acme.com (valid)');
  });

  it('puts package sections first, in order', () => {
    const pkg = { sections: [{ key: 'why', label: 'Why', html: '<p>WHY</p>' }, { key: 'offer', label: 'Offer', html: '<p>OFFER</p>' }] };
    const { html } = buildNote(input({ pkg }));
    expect(html.startsWith('<p>WHY</p><p>OFFER</p>')).toBe(true);
    expect(ascending(positions(html, ['WHY', 'OFFER', 'People', 'Open in Scout']))).toBe(true);
  });

  it('leaves out sections with no data', () => {
    const { html } = buildNote(
      input({ people: [], account: { name: 'Acme', industry: null, employees: null, hqCity: null, hqState: null, hqCountry: null, description: null, technologies: [] }, assignmentNote: null, ownerLine: null, dataAsOf: null }),
    );
    expect(html).toBe(`<p>Open in Scout: <a href="${URL}">${URL}</a></p>`);
  });

  it('escapes names and text', () => {
    const { html } = buildNote(
      input({ assignmentNote: '<b>x</b> & "y"', people: [{ firstName: '<script>alert(1)</script>', lastName: null, title: null, email: null, emailStatus: null, isPrimary: true, roles: [] }] }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;');
  });

  it('drops sections from the bottom past the limit, keeps the link and adds More in Scout', () => {
    const big = { key: 'big', label: 'Big', html: `<p>${'x'.repeat(70_000)}</p>` };
    const { html, droppedSections } = buildNote(input({ pkg: { sections: [{ key: 'why', label: 'Why', html: '<p>WHY</p>' }, big] } }));
    expect(html.length).toBeLessThanOrEqual(NOTE_LIMIT);
    expect(droppedSections).toEqual(['big', 'people', 'company', 'data_as_of', 'assignment_note', 'owner']);
    expect(html).toContain('WHY');
    expect(html).toContain('More in Scout');
    expect(html.endsWith(`Open in Scout: <a href="${URL}">${URL}</a></p>`)).toBe(true);
  });

  it('keeps earlier sections when only the last ones overflow', () => {
    const pad = { key: 'pad', label: 'Pad', html: `<p>${'y'.repeat(64_500)}</p>` };
    const { html, droppedSections } = buildNote(input({ pkg: { sections: [pad] } }));
    expect(html.length).toBeLessThanOrEqual(NOTE_LIMIT);
    expect(html).toContain('yyyy');
    expect(droppedSections.length).toBeGreaterThan(0);
    expect(droppedSections).not.toContain('pad');
  });
});

describe('noteFingerprint', () => {
  it('is the one shared implementation', () => {
    expect(noteFingerprint).toBe(original);
  });
});
