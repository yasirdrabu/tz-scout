import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  listExclusionRules,
  setExclusionList,
  setExclusionRule,
  upsertFromArrival,
  type ArrivalForAccounts,
} from '@/modules/accounts';
import { account, exclusionList } from '@/modules/accounts/db/schema';
import type { ModuleContext } from '@/platform/context';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant } from '../offers/helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
});

const domain = () => `${newId('acc').slice(-10).toLowerCase()}.example.com`;
const person = { userId: 'usr_admin', dataLimit: { kind: 'all' as const } };
const asPerson = <T>(fn: (ctx: ModuleContext) => Promise<T>) => t.run((ctx) => fn({ ...ctx, access: person }));

function arrival(over: Partial<ArrivalForAccounts> = {}): ArrivalForAccounts {
  return {
    arrivalId: newId('evt').replace('evt_', 'arr_'),
    receivedAt: new Date('2026-10-26T15:00:00Z'),
    sourceChain: {},
    account: {},
    people: [],
    signals: [],
    facts: [],
    research: {},
    soleProprietor: false,
    externalIds: [],
    ...over,
  };
}
const reason = async (id: string) =>
  (await t.run((ctx) => ctx.tx.select({ k: account.excludedReasonKey }).from(account).where(eq(account.id, id))))[0]!.k;

describe('exclusion settings', () => {
  it('lists the rules', async () => {
    const rules = await asPerson((ctx) => listExclusionRules(ctx));
    expect(rules.map((r) => r.key)).toEqual(
      expect.arrayContaining(['software_vendor', 'unit_of_parent', 'existing_customer', 'open_deal', 'domain_listed']),
    );
    expect(rules.every((r) => r.enabled)).toBe(true);
  });

  it('turning off software_vendor clears that exclusion once the recheck runs', async () => {
    const out = await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: 'Vendor Co', domain: domain() } })));
    await t.run((ctx) =>
      ctx.tx.update(account).set({ industryKey: 'software', excludedReasonKey: 'software_vendor' }).where(eq(account.id, out.accountId)),
    );
    await asPerson((ctx) => setExclusionRule(ctx, 'software_vendor', false));
    expect(await reason(out.accountId)).toBe('software_vendor'); // not until the job runs
    await runOutbox(t.tenantId);
    expect(await reason(out.accountId)).toBeNull();
    expect((await asPerson((ctx) => listExclusionRules(ctx))).find((r) => r.key === 'software_vendor')?.enabled).toBe(false);
  });

  it('adding the account domain to do_not_contact_domain sets domain_listed', async () => {
    const d = domain();
    const out = await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: 'Listed Co', domain: d } })));
    await asPerson((ctx) => setExclusionList(ctx, 'do_not_contact_domain', [d, 'other.example.org']));
    await runOutbox(t.tenantId);
    expect(await reason(out.accountId)).toBe('domain_listed');
    const rows = await t.run((ctx) =>
      ctx.tx.select().from(exclusionList).where(and(eq(exclusionList.tenantId, ctx.tenantId), eq(exclusionList.kind, 'do_not_contact_domain'))),
    );
    expect(rows.map((r) => r.value).sort()).toEqual([d, 'other.example.org'].sort());
  });

  it('rechecks 100 accounts per message and follows the cursor to the end', async () => {
    const tenant = await freshTenant();
    await runOutbox(tenant.tenantId);
    const last = domain();
    await tenant.run(async (ctx) => {
      for (let i = 0; i < 230; i++) {
        await upsertFromArrival(ctx, arrival({ account: { name: `Recheck ${i}`, domain: i === 229 ? last : domain() } }));
      }
    });
    await runOutbox(tenant.tenantId);
    await tenant.run((ctx) => setExclusionList({ ...ctx, access: person }, 'do_not_contact_domain', [last]));
    await runOutbox(tenant.tenantId);
    const listed = await tenant.run((ctx) => ctx.tx.select({ id: account.id }).from(account).where(eq(account.excludedReasonKey, 'domain_listed')));
    expect(listed).toHaveLength(1);
  });

  it('needs a person, rejects unknown rules and list kinds', async () => {
    await expect(t.run((ctx) => setExclusionRule(ctx, 'software_vendor', true))).rejects.toMatchObject({ status: 403 });
    await expect(asPerson((ctx) => setExclusionRule(ctx, 'nope', true))).rejects.toMatchObject({ status: 404 });
    await expect(asPerson((ctx) => setExclusionList(ctx, 'bogus', ['x']))).rejects.toMatchObject({ status: 400 });
  });
});
