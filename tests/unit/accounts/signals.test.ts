import { describe, expect, it } from 'vitest';
import { SIGNAL_TYPES, fineTypeFromTitle, kindFor, signalDedupKeys } from '@/modules/accounts/domain/signals';

describe('signal types', () => {
  it('has the nine types with label, kind and explainer', () => {
    expect(Object.keys(SIGNAL_TYPES)).toHaveLength(9);
    expect(SIGNAL_TYPES.intent).toMatchObject({ label: 'Researching', kind: 'research' });
    expect(SIGNAL_TYPES.tech).toMatchObject({ label: 'Tech stack', kind: 'pain' });
    expect(SIGNAL_TYPES.risk.what).toMatch(/security breach/);
    expect(kindFor('funding')).toBe('trigger');
    expect(kindFor('nope')).toBeNull();
  });
});

describe('fineTypeFromTitle', () => {
  it('sets a type only when its kind is the given kind', () => {
    expect(fineTypeFromTitle('trigger', 'Acme raised a Series B')).toBe('funding');
    expect(fineTypeFromTitle('pain', 'Acme raised a Series B')).toBeNull();
    expect(fineTypeFromTitle('trigger', 'Jane Doe named CIO')).toBe('leadership');
    expect(fineTypeFromTitle('trigger', 'Pat appointed COO')).toBe('leadership');
    expect(fineTypeFromTitle('pain', 'Hiring 5 data engineers')).toBe('hiring');
    expect(fineTypeFromTitle('trigger', 'Hiring 5 data engineers')).toBeNull();
    expect(fineTypeFromTitle('trigger', 'Opened a new office')).toBeNull();
  });
});

describe('signalDedupKeys', () => {
  const base = {
    source: 's1',
    externalId: 'e1' as string | null,
    url: 'https://x.com/a/' as string | null,
    kind: 'trigger' as const,
    title: 'Raised  $40M, Series C!',
    occurredAt: new Date('2026-09-20T15:00:00Z'),
  };
  it('gives the three keys', () => {
    expect(signalDedupKeys(base)).toEqual([
      'ext:s1:e1',
      'url:https://x.com/a:2026-09-20',
      'title:trigger:raised 40m series c:2026-09-20',
    ]);
  });
  it('leaves out keys it cannot build', () => {
    expect(signalDedupKeys({ ...base, externalId: null, url: null })).toEqual([
      'title:trigger:raised 40m series c:2026-09-20',
    ]);
  });
  it('same title, kind and day collide even with different times', () => {
    const a = signalDedupKeys(base);
    const b = signalDedupKeys({
      ...base,
      externalId: null,
      url: null,
      title: 'raised $40M series c',
      occurredAt: new Date('2026-09-20T01:00:00Z'),
    });
    expect(a).toContain(b[0]);
  });
});
