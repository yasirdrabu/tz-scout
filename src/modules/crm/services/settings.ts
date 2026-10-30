import { and, eq } from 'drizzle-orm';
import { connectionSettings, gateway, setConnectionSettings } from '@/modules/integrations';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { PROPERTY_GROUP, SCOUT_PROPERTIES } from '../adapters/hubspot/properties';
import type { CrmAdapter } from '../contracts/adapter';
import { CRM_SYSTEMS, DEFAULT_FOLLOW_UP_DAYS, type CrmSystem } from '../contracts/types';
import { crmSetting, propertySetup } from '../db/schema';

export type QualifiedLeadRule = { property: string; value: string };

/** Which HubSpot contacts count as qualified leads, until a tenant sets its own (Ruling 14). */
export const DEFAULT_QUALIFIED_LEAD_RULE: QualifiedLeadRule = { property: 'lifecyclestage', value: 'marketingqualifiedlead' };

export type CrmSettings = {
  system: CrmSystem;
  takeOverStaleOwnership: boolean;
  pushNewPeople: boolean;
  followUpDays: number[];
  qualifiedLeadRule: QualifiedLeadRule;
};

export type CrmSettingsPatch = Partial<CrmSettings>;

const FOLLOW_UP_DAYS_MESSAGE = 'Pick 1 to 5 follow-up days, each 1 to 60, in order with no repeats.';

const isRule = (v: unknown): v is QualifiedLeadRule =>
  !!v && typeof v === 'object' && typeof (v as QualifiedLeadRule).property === 'string' && typeof (v as QualifiedLeadRule).value === 'string';

/** The tenant's CRM settings, with the qualified-lead rule from the HubSpot connection. */
export async function getCrmSettings(ctx: ModuleContext): Promise<CrmSettings> {
  const [row] = await ctx.tx.select().from(crmSetting).where(eq(crmSetting.tenantId, ctx.tenantId));
  const rule = (await connectionSettings(ctx, 'hubspot')).qualified_lead_rule;
  return {
    system: (row?.system ?? 'hubspot') as CrmSystem,
    takeOverStaleOwnership: row?.takeOverStaleOwnership ?? true,
    pushNewPeople: row?.pushNewPeople ?? true,
    followUpDays: row?.followUpDays ?? DEFAULT_FOLLOW_UP_DAYS,
    qualifiedLeadRule: isRule(rule) ? rule : DEFAULT_QUALIFIED_LEAD_RULE,
  };
}

function check(patch: CrmSettingsPatch): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  if (patch.system !== undefined && !CRM_SYSTEMS.includes(patch.system)) errors.push({ path: 'system', message: 'Pick a CRM Scout knows.' });
  const days = patch.followUpDays;
  if (
    days !== undefined &&
    (!Array.isArray(days) ||
      days.length < 1 ||
      days.length > 5 ||
      days.some((d, i) => !Number.isInteger(d) || d < 1 || d > 60 || (i > 0 && d <= days[i - 1]!)))
  ) {
    errors.push({ path: 'follow_up_days', message: FOLLOW_UP_DAYS_MESSAGE });
  }
  const rule = patch.qualifiedLeadRule;
  if (rule !== undefined) {
    if (!rule?.property?.trim()) errors.push({ path: 'qualified_lead_rule.property', message: 'Name the HubSpot property.' });
    if (!rule?.value?.trim()) errors.push({ path: 'qualified_lead_rule.value', message: 'Give the value that means qualified.' });
  }
  return errors;
}

/** Changes the CRM settings (Global Constraints ranges). The qualified-lead rule goes on the HubSpot connection. Audited. */
export async function setCrmSettings(ctx: ModuleContext, patch: CrmSettingsPatch): Promise<CrmSettings> {
  const errors = check(patch);
  if (errors.length > 0) throw new ScoutError({ slug: 'validation', status: 400, title: errors[0]!.message, errors });

  // Locked, so two changes can't both audit the same "before".
  await ctx.tx.insert(crmSetting).values({ tenantId: ctx.tenantId }).onConflictDoNothing();
  await ctx.tx.select({ id: crmSetting.tenantId }).from(crmSetting).where(eq(crmSetting.tenantId, ctx.tenantId)).for('update');
  const before = await getCrmSettings(ctx);

  const { qualifiedLeadRule, ...own } = patch;
  const set = Object.fromEntries(Object.entries(own).filter(([, v]) => v !== undefined));
  if (Object.keys(set).length > 0) await ctx.tx.update(crmSetting).set({ ...set, updatedAt: new Date() }).where(eq(crmSetting.tenantId, ctx.tenantId));
  if (qualifiedLeadRule) {
    await setConnectionSettings(ctx, 'hubspot', { qualified_lead_rule: { property: qualifiedLeadRule.property.trim(), value: qualifiedLeadRule.value.trim() } });
  }

  const after = await getCrmSettings(ctx);
  const changed = (Object.keys(after) as (keyof CrmSettings)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (changed.length > 0) {
    await audit(ctx, {
      action: 'crm.settings.updated',
      subject: { type: 'crm_setting', id: ctx.tenantId },
      before: Object.fromEntries(changed.map((k) => [k, before[k]])),
      after: Object.fromEntries(changed.map((k) => [k, after[k]])),
    });
  }
  return after;
}

/**
 * "Set up HubSpot fields" (Ruling 10): creates the `scout_buyer_signals` group and only the properties that are
 * missing, and records what Scout created in `crm.property_setup`. A run that creates nothing records nothing.
 */
export async function setUpHubSpotFields(ctx: ModuleContext): Promise<{ created: string[] }> {
  const { created } = await gateway.call(
    ctx,
    'hubspot',
    'setUpProperties',
    (a) => (a as CrmAdapter).setUpProperties({ groupName: PROPERTY_GROUP.name, groupLabel: PROPERTY_GROUP.label, properties: SCOUT_PROPERTIES }),
    { module: 'crm' },
  );
  if (created.length === 0) return { created };
  const [row] = await ctx.tx
    .select({ created: propertySetup.createdProperties })
    .from(propertySetup)
    .where(and(eq(propertySetup.tenantId, ctx.tenantId), eq(propertySetup.system, 'hubspot')))
    .for('update');
  const all = [...new Set([...(row?.created ?? []), ...created])];
  const values = { groupName: PROPERTY_GROUP.name, createdProperties: all, setUpAt: new Date(), setUpBy: ctx.actor.id };
  await ctx.tx
    .insert(propertySetup)
    .values({ tenantId: ctx.tenantId, system: 'hubspot', ...values })
    .onConflictDoUpdate({ target: [propertySetup.tenantId, propertySetup.system], set: values });
  await audit(ctx, { action: 'crm.property_setup', subject: { type: 'crm_property_setup', id: ctx.tenantId }, after: { created } });
  return { created };
}
