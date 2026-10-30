import { and, eq } from 'drizzle-orm';
import { crmOwnerId, members } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { withTenant } from '@/platform/db/tenant';
import { ID_PREFIX, nextMockId, type MockFailureKind } from './adapters/hubspot/mock';
import type { ActivityKind, DealStatus } from './contracts/types';
import { mockActivity, mockCompany, mockDeal, mockFailure, mockNote, mockOwner, mockPerson, mockTask } from './db/schema';
import { noteFingerprint } from './domain/fingerprint';

// Sample data and test helpers for the mock HubSpot. Every write commits on its own, like the mock itself.

const QUALIFIED_RULE_VALUE = 'marketingqualifiedlead';

/**
 * The sample CRM: an owner for each member's HubSpot owner id, Rahul Mehta (inactive) and Vijay Kumar (active),
 * four companies that exercise the ownership rule, and one qualified contact. Safe to run again.
 * Returns the external ids of the named owners.
 */
export async function seedMockCrm(ctx: ModuleContext): Promise<{ rahul: string; vijay: string }> {
  const tenantId = ctx.tenantId;
  const people = await members(ctx);
  const memberOwners: { externalId: string; name: string; email: string }[] = [];
  for (const m of people) {
    const externalId = await crmOwnerId(ctx, m.userId, 'hubspot');
    if (externalId) memberOwners.push({ externalId, name: m.name, email: m.email });
  }

  return withTenant(tenantId, async (tx) => {
    const ownerIds = new Map<string, string>();
    for (const o of await tx.select().from(mockOwner).where(eq(mockOwner.tenantId, tenantId))) ownerIds.set(o.name, o.externalId);

    for (const o of memberOwners) {
      await tx.insert(mockOwner).values({ tenantId, externalId: o.externalId, name: o.name, email: o.email, active: true }).onConflictDoNothing();
    }
    const named = async (name: string, email: string, active: boolean) => {
      const have = ownerIds.get(name);
      if (have) return have;
      const externalId = await nextMockId(tx, tenantId, mockOwner, ID_PREFIX.owner);
      await tx.insert(mockOwner).values({ tenantId, externalId, name, email, active });
      return externalId;
    };
    const rahul = await named('Rahul Mehta', 'rahul.mehta@example.com', false);
    const vijay = await named('Vijay Kumar', 'vijay.kumar@example.com', true);

    const company = async (domain: string, name: string, over: { ownerExternalId?: string; lifecycle?: string }) => {
      const [have] = await tx.select().from(mockCompany).where(and(eq(mockCompany.tenantId, tenantId), eq(mockCompany.domain, domain)));
      if (have) return have.externalId;
      const externalId = await nextMockId(tx, tenantId, mockCompany, ID_PREFIX.company);
      await tx.insert(mockCompany).values({ tenantId, externalId, domain, name, ownerExternalId: over.ownerExternalId ?? null, lifecycle: over.lifecycle ?? 'lead' });
      return externalId;
    };
    await company('owned-elsewhere.example', 'Owned Elsewhere', { ownerExternalId: vijay });
    const openDeal = await company('open-deal.example', 'Open Deal', { ownerExternalId: vijay });
    await company('customer.example', 'Customer', { ownerExternalId: vijay, lifecycle: 'customer' });
    await company('inactive-owner.example', 'Inactive Owner', { ownerExternalId: rahul });
    const qualified = await company('qualified.example', 'Qualified', {});

    const [hasDeal] = await tx.select().from(mockDeal).where(and(eq(mockDeal.tenantId, tenantId), eq(mockDeal.companyExternalId, openDeal)));
    if (!hasDeal) {
      const externalId = await nextMockId(tx, tenantId, mockDeal, ID_PREFIX.deal);
      await tx.insert(mockDeal).values({ tenantId, externalId, companyExternalId: openDeal, name: 'Open Deal renewal', stage: 'proposal', status: 'open', amountCents: 5_000_000, currency: 'USD', openedAt: new Date() });
    }

    const [hasLead] = await tx.select().from(mockPerson).where(and(eq(mockPerson.tenantId, tenantId), eq(mockPerson.email, 'pat.lee@qualified.example')));
    if (!hasLead) {
      const externalId = await nextMockId(tx, tenantId, mockPerson, ID_PREFIX.person);
      await tx.insert(mockPerson).values({ tenantId, externalId, companyExternalId: qualified, name: 'Pat Lee', title: 'VP Engineering', email: 'pat.lee@qualified.example', lifecycle: QUALIFIED_RULE_VALUE, qualifiedAt: new Date() });
    }
    return { rahul, vijay };
  });
}

/** Makes the mock fail `operation` the next `times` calls with a 429, a 500 or a timeout. */
export async function setMockFailure(ctx: ModuleContext, operation: string, kind: MockFailureKind, times: number): Promise<void> {
  await withTenant(ctx.tenantId, (tx) =>
    tx
      .insert(mockFailure)
      .values({ tenantId: ctx.tenantId, operation, kind, remaining: times })
      .onConflictDoUpdate({ target: [mockFailure.tenantId, mockFailure.operation], set: { kind, remaining: times } }),
  );
}

/** Edits a note the way a person would in HubSpot, so its fingerprint no longer matches Scout's. */
export async function mockEditNote(ctx: ModuleContext, externalId: string): Promise<void> {
  await withTenant(ctx.tenantId, async (tx) => {
    const where = and(eq(mockNote.tenantId, ctx.tenantId), eq(mockNote.externalId, externalId));
    const [note] = await tx.select().from(mockNote).where(where);
    if (!note) throw new Error(`No mock note ${externalId}`);
    const html = `${note.html}<p>Edited by a rep.</p>`;
    await tx.update(mockNote).set({ html, fingerprint: noteFingerprint(html) }).where(where);
  });
}

/** Completes a task the way a person would in HubSpot. */
export async function mockCompleteTask(ctx: ModuleContext, externalId: string): Promise<void> {
  await withTenant(ctx.tenantId, (tx) =>
    tx.update(mockTask).set({ status: 'completed' }).where(and(eq(mockTask.tenantId, ctx.tenantId), eq(mockTask.externalId, externalId))),
  );
}

/** Adds an activity on a company; returns its external id. */
export async function mockAddActivity(
  ctx: ModuleContext,
  input: { companyExternalId: string; kind: ActivityKind; occurredAt?: Date; actorOwnerExternalId?: string | null },
): Promise<string> {
  return withTenant(ctx.tenantId, async (tx) => {
    const externalId = await nextMockId(tx, ctx.tenantId, mockActivity, ID_PREFIX.activity);
    await tx.insert(mockActivity).values({
      tenantId: ctx.tenantId,
      externalId,
      companyExternalId: input.companyExternalId,
      kind: input.kind,
      occurredAt: input.occurredAt ?? new Date(),
      actorOwnerExternalId: input.actorOwnerExternalId ?? null,
    });
    return externalId;
  });
}

/** Adds a deal on a company (open unless said otherwise); returns its external id. */
export async function mockAddDeal(
  ctx: ModuleContext,
  input: { companyExternalId: string; name: string; status?: DealStatus; amountCents?: number | null; stage?: string | null },
): Promise<string> {
  return withTenant(ctx.tenantId, async (tx) => {
    const externalId = await nextMockId(tx, ctx.tenantId, mockDeal, ID_PREFIX.deal);
    const status = input.status ?? 'open';
    const now = new Date();
    await tx.insert(mockDeal).values({
      tenantId: ctx.tenantId,
      externalId,
      companyExternalId: input.companyExternalId,
      name: input.name,
      stage: input.stage ?? null,
      status,
      amountCents: input.amountCents ?? null,
      currency: 'USD',
      openedAt: now,
      closedAt: status === 'open' ? null : now,
      updatedAt: now,
    });
    return externalId;
  });
}

/** Changes a deal's status, amount or stage, as a person would in HubSpot. */
export async function mockSetDeal(
  ctx: ModuleContext,
  externalId: string,
  change: { status?: DealStatus; amountCents?: number | null; stage?: string | null },
): Promise<void> {
  const now = new Date();
  await withTenant(ctx.tenantId, (tx) =>
    tx
      .update(mockDeal)
      .set({
        ...(change.status ? { status: change.status, closedAt: change.status === 'open' ? null : now } : {}),
        ...(change.amountCents !== undefined ? { amountCents: change.amountCents } : {}),
        ...(change.stage !== undefined ? { stage: change.stage } : {}),
        updatedAt: now,
      })
      .where(and(eq(mockDeal.tenantId, ctx.tenantId), eq(mockDeal.externalId, externalId))),
  );
}

/** Moves a contact to the qualified lifecycle at `at` (now by default), as a person would in HubSpot. */
export async function mockQualifyPerson(ctx: ModuleContext, email: string, at: Date = new Date()): Promise<void> {
  await withTenant(ctx.tenantId, (tx) =>
    tx
      .update(mockPerson)
      .set({ lifecycle: QUALIFIED_RULE_VALUE, qualifiedAt: at })
      .where(and(eq(mockPerson.tenantId, ctx.tenantId), eq(mockPerson.email, email))),
  );
}
