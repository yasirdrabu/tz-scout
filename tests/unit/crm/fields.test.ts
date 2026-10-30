import { describe, expect, it } from 'vitest';
import { DEFAULT_FIELD_MAPPINGS } from '@/modules/crm/defaults';
import { propertyValues } from '@/modules/crm/domain/fields';

const now = new Date('2026-10-30T18:00:00Z');
const all = new Set(DEFAULT_FIELD_MAPPINGS.map((m) => m.crmProperty));

describe('propertyValues', () => {
  it('maps the tier through enum_map and passes plain values through', () => {
    expect(propertyValues(DEFAULT_FIELD_MAPPINGS, { tier: 'act_now', fit: 80, practice: 'AI' }, all, now)).toEqual({
      taazaa_tier: 'Act now',
      taazaa_fit_score: 80,
      taazaa_bucket: 'AI',
      taazaa_last_pushed: '2026-10-30',
    });
  });

  it('never sends null, empty or unmapped values', () => {
    const out = propertyValues(DEFAULT_FIELD_MAPPINGS, { tier: 'bogus', fit: null, why_now: '  ', intent: undefined, priority: 0 }, all, now);
    expect(out).toEqual({ taazaa_total_score: 0, taazaa_last_pushed: '2026-10-30' });
  });

  it('skips properties that do not exist in the CRM', () => {
    const out = propertyValues(DEFAULT_FIELD_MAPPINGS, { fit: 5, scout_link: 'https://x' }, new Set(['taazaa_fit_score']), now);
    expect(out).toEqual({ taazaa_fit_score: 5 });
  });

  it('applies cents_to_amount and date, and skips disabled or read mappings', () => {
    const rows = [
      { scoutField: 'revenue', crmProperty: 'rev', transform: 'cents_to_amount' },
      { scoutField: 'seen', crmProperty: 'seen', transform: 'date' },
      { scoutField: 'a', crmProperty: 'a', transform: 'none', enabled: false },
      { scoutField: 'b', crmProperty: 'b', transform: 'none', direction: 'read' },
    ];
    const out = propertyValues(rows, { revenue: 123456, seen: new Date('2026-03-04T23:00:00Z'), a: 1, b: 2 }, new Set(['rev', 'seen', 'a', 'b']), now);
    expect(out).toEqual({ rev: 1234.56, seen: '2026-03-04' });
  });
});
