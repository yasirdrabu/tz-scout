import { describe, expect, it } from 'vitest';
import { AUDIT_AREAS, areaOf, areaPrefixes } from '@/modules/tenancy/domain/audit-areas';

describe('areaOf', () => {
  it.each([
    ['tenancy.tenant.created', 'tenants'],
    ['tenancy.member.added', 'members'],
    ['tenancy.member.crm_owner_ids_changed', 'members'],
    ['tenancy.sign_in.failed', 'sign_in'],
    ['tenancy.api_key.revoked', 'api_keys'],
    ['integrations.credential.saved', 'integrations'],
    ['intake.source.created', 'sources'],
    ['routing.settings.updated', 'settings'],
    ['crm.settings.updated', 'settings'],
    ['offers.offer.approved', 'settings'],
    ['scoring.profile.updated', 'settings'],
    ['accounts.exclusion_rule.set', 'settings'],
    ['crm.property_setup', 'settings'],
    ['intake.relationship_default.set', 'settings'],
    ['accounts.account.merge', 'other'],
    ['intake.arrival.skip', 'other'],
  ])('%s is %s', (action, area) => {
    expect(areaOf(action)).toBe(area);
  });
});

it('every area but other has prefixes, and each prefix maps back to its area', () => {
  for (const area of AUDIT_AREAS) {
    if (area === 'other') continue;
    const prefixes = areaPrefixes(area);
    expect(prefixes.length, area).toBeGreaterThan(0);
    for (const p of prefixes) expect(areaOf(`${p}x`)).toBe(area);
  }
});
