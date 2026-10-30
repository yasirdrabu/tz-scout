import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { getCrmSettings, setCrmSettings, setUpHubSpotFields } from '@/modules/crm';
import { SCOUT_PROPERTY_NAMES } from '@/modules/crm/adapters/hubspot/properties';
import { mockProperty, propertySetup } from '@/modules/crm/db/schema';
import { connectionSettings } from '@/modules/integrations';
import { callLog } from '@/modules/integrations/db/schema';
import { adminDb, closeDbs } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { ScoutError } from '@/platform/errors';
import { asPerson, routingTenant, type Tenant } from '../routing/helpers';

let t: Tenant;

beforeAll(async () => {
  t = await routingTenant();
});
afterAll(closeDbs);

const refused = async (patch: Parameters<typeof setCrmSettings>[1]) => {
  const e = await asPerson(t, (ctx) => setCrmSettings(ctx, patch)).catch((err: unknown) => err);
  expect(e).toBeInstanceOf(ScoutError);
  expect((e as ScoutError).status).toBe(400);
  return (e as ScoutError).errors!.map((x) => x.path);
};

describe('CRM settings', () => {
  it('has the defaults', async () => {
    expect(await asPerson(t, (ctx) => getCrmSettings(ctx))).toEqual({
      system: 'hubspot',
      takeOverStaleOwnership: true,
      pushNewPeople: true,
      followUpDays: [3, 7, 14],
      qualifiedLeadRule: { property: 'lifecyclestage', value: 'marketingqualifiedlead' },
    });
  });

  it('refuses follow-up days out of range with field errors', async () => {
    for (const days of [[], [1, 2, 3, 4, 5, 6], [7, 3], [3, 3], [0], [61], [2.5]]) {
      expect(await refused({ followUpDays: days })).toEqual(['follow_up_days']);
    }
    expect(await refused({ qualifiedLeadRule: { property: '', value: 'x' } })).toEqual(['qualified_lead_rule.property']);
    expect(await refused({ system: 'nope' as 'hubspot' })).toEqual(['system']);
    expect(await refused({ pushNewPeople: 'yes' as unknown as boolean, takeOverStaleOwnership: 1 as unknown as boolean })).toEqual([
      'take_over_stale_ownership',
      'push_new_people',
    ]);
    expect(await refused({ autoPush: true } as never)).toEqual(['auto_push']);
  });

  it('saves a change, audits it and puts the qualified-lead rule on the connection', async () => {
    const after = await asPerson(t, (ctx) =>
      setCrmSettings(ctx, { followUpDays: [2, 5], takeOverStaleOwnership: false, qualifiedLeadRule: { property: 'hs_lead_status', value: 'QUALIFIED' } }),
    );
    expect(after).toMatchObject({ followUpDays: [2, 5], takeOverStaleOwnership: false, pushNewPeople: true, qualifiedLeadRule: { property: 'hs_lead_status', value: 'QUALIFIED' } });
    expect((await t.run((ctx) => connectionSettings(ctx, 'hubspot'))).qualified_lead_rule).toEqual({ property: 'hs_lead_status', value: 'QUALIFIED' });
    const audits = await t.run((ctx) => ctx.tx.select().from(auditLog).where(and(eq(auditLog.tenantId, ctx.tenantId), eq(auditLog.action, 'crm.settings.updated'))));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ followUpDays: [2, 5], takeOverStaleOwnership: false });
  });
});

describe('Set up HubSpot fields', () => {
  it('creates the missing properties in the Scout group once; a second run records nothing new', async () => {
    const first = await asPerson(t, (ctx) => setUpHubSpotFields(ctx));
    expect(first.created.length).toBeGreaterThan(0);
    expect(first.created.every((n) => SCOUT_PROPERTY_NAMES.includes(n))).toBe(true);
    const groups = await t.run((ctx) => ctx.tx.select({ group: mockProperty.groupName }).from(mockProperty));
    expect(new Set(groups.map((g) => g.group))).toEqual(new Set(['scout_buyer_signals']));
    const [call] = await adminDb.select().from(callLog).where(and(eq(callLog.tenantId, t.tenantId), eq(callLog.operation, 'setUpProperties')));
    expect(call!.requestSummary).toMatchObject({ groupName: 'scout_buyer_signals', groupLabel: 'Scout buyer signals' });
    const [setup] = await t.run((ctx) => ctx.tx.select().from(propertySetup));
    expect(setup).toMatchObject({ system: 'hubspot', groupName: 'scout_buyer_signals', createdProperties: first.created });

    const second = await asPerson(t, (ctx) => setUpHubSpotFields(ctx));
    expect(second.created).toEqual([]);
    const rows = await t.run((ctx) => ctx.tx.select().from(propertySetup));
    expect(rows).toEqual([setup]);
  });
});
