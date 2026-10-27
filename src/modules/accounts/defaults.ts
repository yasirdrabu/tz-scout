import type { ModuleContext } from '@/platform/context';
import { buyingRole, exclusionList, exclusionRule } from './db/schema';

/** Default buying roles, with labels from the buying committee spec. */
export const DEFAULT_BUYING_ROLES = [
  { key: 'business_owner', label: 'Business owner' },
  { key: 'commercial_buyer', label: 'Commercial buyer' },
  { key: 'technical_buyer', label: 'Technical buyer' },
  { key: 'influencer', label: 'Influencer' },
  { key: 'champion', label: 'Champion' },
  { key: 'procurement', label: 'Procurement' },
  { key: 'blocker', label: 'Blocker' },
  { key: 'user', label: 'User' },
];

/** ACC-E7 default rules, all on. `params` says which input each rule reads. */
export const DEFAULT_EXCLUSION_RULES = [
  { key: 'software_vendor', label: 'Software vendor', kind: 'industry_or_keyword', params: { list: 'vendor_keyword' } },
  { key: 'unit_of_parent', label: 'Part of a larger company', kind: 'parent', params: { lists: ['parent_domain', 'parent_name'] } },
  { key: 'existing_customer', label: 'Already a customer', kind: 'crm_status', params: { crmStatus: 'customer' } },
  { key: 'open_deal', label: 'Has an open deal', kind: 'crm_status', params: { crmStatus: 'open_deal' } },
  { key: 'domain_listed', label: 'On our do-not-contact list', kind: 'domain_list', params: { list: 'do_not_contact_domain' } },
];

/** The v1 vendor text pattern (src/integrations/prospects/vibe.ts, VENDOR_TEXT) as plain lowercase phrases. */
export const VENDOR_PHRASES = [
  'uses ai to',
  'use ai to',
  'ai-powered',
  'ai powered',
  'ai infrastructure',
  'ai teammate',
  'ai-driven workforce',
  'ai-driven platform',
  'ai-driven solutions',
  'software platform',
  'saas',
  'our platform',
  'centralized platform',
  'healthcare intelligence platform',
  'execution software',
  'helps hospitals',
  'helps health systems',
  'helps providers',
  'helps payers',
  'helps landlords',
  'helps carriers',
  'helps insurers',
  'helping hospitals',
  'helping health systems',
  'helping providers',
  'ai care',
];

/** Adds what is missing and leaves anything a person has changed alone, so it is safe to run again. */
export async function seedAccountDefaults(ctx: ModuleContext): Promise<void> {
  const tenantId = ctx.tenantId;
  await ctx.tx
    .insert(buyingRole)
    .values(DEFAULT_BUYING_ROLES.map((r, sort) => ({ tenantId, ...r, sort })))
    .onConflictDoNothing();
  await ctx.tx
    .insert(exclusionRule)
    .values(DEFAULT_EXCLUSION_RULES.map((r) => ({ tenantId, ...r, enabled: true })))
    .onConflictDoNothing();
  await ctx.tx
    .insert(exclusionList)
    .values(VENDOR_PHRASES.map((value) => ({ tenantId, kind: 'vendor_keyword', value })))
    .onConflictDoNothing();
}
