import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedAccountDefaults, sourceInfoProvider } from '@/modules/accounts';
import { buyingRole, exclusionList, exclusionRule } from '@/modules/accounts/db/schema';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant } from '../offers/helpers';

let a: Awaited<ReturnType<typeof freshTenant>>;
let b: Awaited<ReturnType<typeof freshTenant>>;

const counts = (t: typeof a) =>
  t.run(async (ctx) => ({
    roles: (await ctx.tx.select().from(buyingRole).where(eq(buyingRole.tenantId, ctx.tenantId))).length,
    rules: await ctx.tx.select().from(exclusionRule).where(eq(exclusionRule.tenantId, ctx.tenantId)),
    list: await ctx.tx.select().from(exclusionList).where(eq(exclusionList.tenantId, ctx.tenantId)),
  }));

beforeAll(async () => {
  a = await freshTenant();
  b = await freshTenant();
});

describe('accounts.tenant_defaults', () => {
  it('adds 8 buying roles, 5 enabled rules and the vendor phrases once, however often it runs', async () => {
    await runOutbox(a.tenantId);
    const first = await counts(a);
    expect(first.roles).toBe(8);
    expect(first.rules.map((r) => r.key).sort()).toEqual([
      'domain_listed',
      'existing_customer',
      'open_deal',
      'software_vendor',
      'unit_of_parent',
    ]);
    expect(first.rules.every((r) => r.enabled)).toBe(true);
    expect(first.list.length).toBeGreaterThan(10);
    expect(first.list.every((l) => l.kind === 'vendor_keyword' && l.value === l.value.toLowerCase())).toBe(true);

    await a.run((ctx) => seedAccountDefaults(ctx));
    const second = await counts(a);
    expect([second.roles, second.rules.length, second.list.length]).toEqual([8, 5, first.list.length]);
  });

  it('labels the roles from the spec', async () => {
    const roles = await a.run((ctx) => ctx.tx.select().from(buyingRole).where(eq(buyingRole.key, 'commercial_buyer')));
    expect(roles[0]).toMatchObject({ label: 'Commercial buyer', archived: false });
  });

  it('keeps tenants apart', async () => {
    expect((await counts(b)).roles).toBe(0);
    await runOutbox(b.tenantId);
    expect((await counts(b)).roles).toBe(8);
    const seen = await a.run((ctx) => ctx.tx.select().from(buyingRole));
    expect(seen.every((r) => r.tenantId === a.tenantId)).toBe(true);
  });
});

describe('SourceInfoProvider default', () => {
  it('trusts every source at 0.60 when none is registered', async () => {
    const out = await a.run((ctx) => sourceInfoProvider().getTrust(ctx, ['src_a', 'src_b']));
    expect(out).toEqual(new Map([['src_a', 0.6], ['src_b', 0.6]]));
  });
});
