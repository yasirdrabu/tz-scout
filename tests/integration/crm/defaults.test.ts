import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import '@/entry/registry';
import { z } from 'zod';
import {
  crmOperations,
  crmTenantDefaults,
  handoffPackageProvider,
  registerHandoffPackageProvider,
  seedCrmDefaults,
  type HandoffPackageProvider,
} from '@/modules/crm';
import { crmSetting, fieldMapping } from '@/modules/crm/db/schema';
import { adminDb, closeDbs } from '@/platform/db/client';
import { schedule } from '@/platform/db/schema';
import { MODULE_ORDER } from '@/platform/db/migrate';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant } from '../offers/helpers';

let a: Awaited<ReturnType<typeof freshTenant>>;
let b: Awaited<ReturnType<typeof freshTenant>>;

const settings = (t: typeof a) => t.run((ctx) => ctx.tx.select().from(crmSetting));
const mappings = (t: typeof a) => t.run((ctx) => ctx.tx.select().from(fieldMapping));
const schedules = (tenantId: string) =>
  adminDb.select().from(schedule).where(sql`${schedule.tenantId} = ${tenantId} and ${schedule.jobName} like 'crm.%'`);

beforeAll(async () => {
  a = await freshTenant();
  b = await freshTenant();
});
afterAll(closeDbs);

describe('crm.tenant_defaults', () => {
  it('is registered under its name', () => {
    expect(crmTenantDefaults.name).toBe('crm.tenant_defaults');
  });

  it('writes the setting, the HubSpot field mapping and three schedules once, however often it runs', async () => {
    await runOutbox(a.tenantId);
    expect(await settings(a)).toMatchObject([
      { tenantId: a.tenantId, system: 'hubspot', takeOverStaleOwnership: true, pushNewPeople: true, followUpDays: [3, 7, 14] },
    ]);
    const m = await mappings(a);
    expect(m).toHaveLength(11);
    expect(m.find((r) => r.scoutField === 'tier')).toMatchObject({
      crmProperty: 'taazaa_tier',
      transform: 'enum_map',
      transformConfig: { act_now: 'Act now', good_fit: 'Good fit', watch: 'Watch', not_fit: 'Not a fit' },
    });
    expect(m.find((r) => r.scoutField === 'last_handoff')).toMatchObject({ crmProperty: 'taazaa_last_pushed', transform: 'date' });
    expect(m.find((r) => r.scoutField === 'scout_link')).toMatchObject({ crmProperty: 'scout_link' });
    const s = await schedules(a.tenantId);
    expect(s.map((x) => [x.jobName, x.cron, x.timezone]).sort()).toEqual([
      ['crm.activity.poll', '*/15 * * * *', 'UTC'],
      ['crm.deals.poll', '0 * * * *', 'UTC'],
      ['crm.owners.sync', '0 5 * * *', 'UTC'],
    ]);

    await a.run((ctx) => seedCrmDefaults(ctx));
    expect(await settings(a)).toHaveLength(1);
    expect(await mappings(a)).toHaveLength(11);
    expect(await schedules(a.tenantId)).toHaveLength(3);
  });

  it('keeps a changed setting and a changed mapping when run again', async () => {
    await a.run((ctx) => ctx.tx.update(crmSetting).set({ pushNewPeople: false, followUpDays: [2] }).where(eq(crmSetting.tenantId, a.tenantId)));
    await a.run((ctx) => ctx.tx.update(fieldMapping).set({ enabled: false }).where(eq(fieldMapping.scoutField, 'practice')));
    await a.run((ctx) => seedCrmDefaults(ctx));
    expect(await settings(a)).toMatchObject([{ pushNewPeople: false, followUpDays: [2] }]);
    expect((await mappings(a)).find((r) => r.scoutField === 'practice')?.enabled).toBe(false);
  });

  it('refuses a follow-up list of more than five days', async () => {
    await expect(
      a.run((ctx) =>
        ctx.tx.transaction((sp) => sp.update(crmSetting).set({ followUpDays: [1, 2, 3, 4, 5, 6] }).where(eq(crmSetting.tenantId, a.tenantId))),
      ),
    ).rejects.toThrow();
  });

  it('keeps tenants apart', async () => {
    await runOutbox(b.tenantId);
    expect(await settings(b)).toHaveLength(1);
    const seen = await b.run((ctx) => ctx.tx.select().from(crmSetting).where(eq(crmSetting.tenantId, a.tenantId)));
    expect(seen).toEqual([]);
    expect((await mappings(b)).every((r) => r.tenantId === b.tenantId)).toBe(true);
  });
});

describe('migrate order', () => {
  it('runs crm after accounts', () => {
    const order = [...MODULE_ORDER];
    expect(order.indexOf('crm')).toBe(order.indexOf('accounts') + 1);
  });
});

describe('handoff package provider', () => {
  it('returns null until one is registered, and again once cleared', async () => {
    const ctx = {} as never;
    expect(await handoffPackageProvider().package(ctx, 'acc_1', 'asg_1')).toBeNull();
    const own: HandoffPackageProvider = {
      package: async () => ({ sections: [], properties: {}, firstTouch: null, followUps: [], planSteps: [] }),
    };
    registerHandoffPackageProvider(own);
    expect(await handoffPackageProvider().package(ctx, 'acc_1', 'asg_1')).not.toBeNull();
    registerHandoffPackageProvider(null);
    expect(await handoffPackageProvider().package(ctx, 'acc_1', 'asg_1')).toBeNull();
  });
});

const company = { externalId: 'mock-co-1', name: 'Acme', ownerExternalId: 'mock-ow-1', lifecycle: 'lead', openDeals: 0, deals: [] };
const deal = {
  externalId: 'mock-dl-1',
  companyExternalId: 'mock-co-1',
  name: 'Big deal',
  stage: 'qualified',
  status: 'open',
  amountCents: 100000,
  currency: 'USD',
  openedAt: '2026-10-01T00:00:00.000Z',
  closedAt: null,
};
const lead = {
  contact: { externalId: 'mock-ct-1', name: 'Pat Lee', email: 'pat.lee@qualified.example', title: null, phone: null, linkedin: null },
  company: null,
  lifecycleStage: 'marketingqualifiedlead',
  qualifiedAt: '2026-10-01T00:00:00.000Z',
  cursorAt: '2026-10-01T00:00:00.000Z',
  raw: {},
};

/** A valid sample for each operation's input and output, and the field whose removal must be refused. */
const SAMPLES: Record<keyof typeof crmOperations, { input: unknown; dropIn: string | null; output: unknown; dropOut: string | null }> = {
  findCompany: { input: { domain: 'acme.example' }, dropIn: 'domain', output: { ...company, deals: [deal] }, dropOut: 'ownerExternalId' },
  upsertCompany: {
    input: { domain: 'acme.example', name: 'Acme', ownerExternalId: 'mock-ow-1', replaceableOwner: false, properties: { taazaa_tier: 'Act now', taazaa_fit_score: 80 } },
    dropIn: 'name',
    output: { externalId: 'mock-co-1', created: true, ownerExternalId: null },
    dropOut: 'created',
  },
  findPerson: { input: { email: 'pat@acme.example' }, dropIn: 'email', output: { externalId: 'mock-ct-1', ownerExternalId: null }, dropOut: 'externalId' },
  upsertPerson: {
    input: { name: 'Pat Lee', ownerExternalId: null, takeOverOwner: false, companyExternalId: 'mock-co-1' },
    dropIn: 'companyExternalId',
    output: { externalId: 'mock-ct-1', created: false },
    dropOut: 'externalId',
  },
  upsertNote: {
    input: { companyExternalId: 'mock-co-1', html: '<p>Hi</p>', ownerExternalId: null },
    dropIn: 'html',
    output: { externalId: 'mock-nt-1', fingerprint: 'abc', kept: false },
    dropOut: 'fingerprint',
  },
  upsertTask: {
    input: { companyExternalId: 'mock-co-1', subject: 'First touch', body: 'Start', ownerExternalId: 'mock-ow-1', dueAt: '2026-10-30T00:00:00.000Z' },
    dropIn: 'subject',
    output: { externalId: 'mock-tk-1', status: 'open' },
    dropOut: 'status',
  },
  closeTask: { input: { externalId: 'mock-tk-1' }, dropIn: 'externalId', output: { status: 'completed' }, dropOut: 'status' },
  listOwners: {
    input: {},
    dropIn: null,
    output: [{ externalId: 'mock-ow-1', name: 'Vijay Kumar', email: 'v@x.example', active: true }],
    dropOut: '0.active',
  },
  readFollowThrough: {
    input: { companyExternalId: 'mock-co-1', taskExternalIds: ['mock-tk-1'] },
    dropIn: 'taskExternalIds',
    output: {
      tasks: [{ externalId: 'mock-tk-1', status: 'open', dueAt: null }],
      emails: 1,
      calls: 0,
      meetings: 0,
      deals: 0,
      openDeals: 0,
      stage: null,
      ownerExternalId: null,
      lastActivityAt: null,
    },
    dropOut: 'emails',
  },
  listActivities: {
    input: { companyExternalId: 'mock-co-1', since: '2026-10-01T00:00:00.000Z' },
    dropIn: 'since',
    output: [{ externalId: 'mock-act-1', kind: 'reply', occurredAt: '2026-10-02T00:00:00.000Z', actorOwnerExternalId: null }],
    dropOut: '0.actorOwnerExternalId',
  },
  listDeals: { input: { changedSince: '2026-10-01T00:00:00.000Z' }, dropIn: null, output: [deal], dropOut: '0.status' },
  listQualifiedLeads: {
    input: { changedSince: '2026-10-01T00:00:00.000Z', rule: { property: 'lifecyclestage', value: 'marketingqualifiedlead' } },
    dropIn: 'rule',
    output: [lead],
    dropOut: '0.qualifiedAt',
  },
  readQualifiedLead: {
    input: { contactId: 'mock-ct-1', rule: { property: 'lifecyclestage', value: 'marketingqualifiedlead' } },
    dropIn: 'contactId',
    output: lead,
    dropOut: 'qualifiedAt',
  },
  existingProperties: { input: {}, dropIn: null, output: ['taazaa_tier'], dropOut: null },
  setUpProperties: {
    input: { groupName: 'scout_buyer_signals', properties: [{ name: 'scout_link', label: 'Scout link', type: 'string' }] },
    dropIn: 'groupName',
    output: { created: ['scout_link'] },
    dropOut: 'created',
  },
  verifyWebhook: { input: { method: 'POST', url: 'https://x.example/hook', headers: {}, rawBody: '[]' }, dropIn: 'rawBody', output: true, dropOut: null },
  parseWebhook: { input: { rawBody: '[]' }, dropIn: 'rawBody', output: [{ kind: 'deal', externalIds: ['mock-dl-1'] }], dropOut: '0.kind' },
};

/** Copy of `value` without the field at `path` (dotted; numbers index arrays). */
function without(value: unknown, path: string): unknown {
  const copy = structuredClone(value) as Record<string, unknown>;
  const parts = path.split('.');
  let cur: Record<string, unknown> = copy;
  for (const p of parts.slice(0, -1)) cur = cur[p] as Record<string, unknown>;
  delete cur[parts[parts.length - 1]!];
  return copy;
}

describe('adapter schemas', () => {
  it('covers every operation', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(crmOperations).sort());
  });

  for (const [name, op] of Object.entries(crmOperations)) {
    const sample = SAMPLES[name as keyof typeof crmOperations];
    const input = op.input as z.ZodType;
    const output = op.output as z.ZodType;

    it(`${name} parses a valid sample and rejects one missing a required field`, () => {
      expect(input.safeParse(sample.input).success).toBe(true);
      expect(output.safeParse(sample.output).success).toBe(true);
      if (sample.dropIn) expect(input.safeParse(without(sample.input, sample.dropIn)).success).toBe(false);
      if (sample.dropOut) expect(output.safeParse(without(sample.output, sample.dropOut)).success).toBe(false);
    });
  }

  it('listActivities requires the actor owner id (Ruling 17)', () => {
    expect(crmOperations.listActivities.output.safeParse([{ externalId: 'a', kind: 'email', occurredAt: '2026-10-01T00:00:00.000Z' }]).success).toBe(false);
  });
});
