/** The audit log's Area filter (screens.md §21g), plus `other` for entries in none of them. */
export const AUDIT_AREAS = ['tenants', 'members', 'sign_in', 'api_keys', 'settings', 'integrations', 'sources', 'other'] as const;
export type AuditArea = (typeof AUDIT_AREAS)[number];

/** Action prefixes per area. Actions are `module.entity.verb`. */
const PREFIXES: Record<Exclude<AuditArea, 'other'>, string[]> = {
  tenants: ['tenancy.tenant.'],
  members: ['tenancy.member.'],
  sign_in: ['tenancy.sign_in.'],
  api_keys: ['tenancy.api_key.'],
  integrations: ['integrations.'],
  sources: ['intake.source.'],
  settings: [
    'routing.settings.',
    'crm.settings.',
    'crm.property_setup',
    'offers.',
    'scoring.',
    'accounts.exclusion_',
    'intake.relationship_default.',
  ],
};

/** The action prefixes of an area; for `other`, every prefix of the other areas (to exclude). */
export function areaPrefixes(area: AuditArea): string[] {
  return area === 'other' ? Object.values(PREFIXES).flat() : PREFIXES[area];
}

export function areaOf(action: string): AuditArea {
  for (const [area, prefixes] of Object.entries(PREFIXES)) {
    if (prefixes.some((p) => action.startsWith(p))) return area as AuditArea;
  }
  return 'other';
}
