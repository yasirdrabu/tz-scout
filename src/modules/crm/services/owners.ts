import { and, asc, eq } from 'drizzle-orm';
import { listConnections, gateway } from '@/modules/integrations';
import { crmOwnerId, members, setCrmOwnerIds } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { newId } from '@/platform/ids';
import type { CrmAdapter } from '../contracts/adapter';
import { crmSetting, owner } from '../db/schema';

/** Shown when the token can't read owners (the live connector's own warning uses the same words). */
export const OWNERS_UNREADABLE = "Owner list can't be read, so Scout can't name who owns a company";

/** The most owners one sync reads. */
export const OWNER_SYNC_LIMIT = 2_000;

export type OwnerRow = { system: string; externalOwnerId: string; name: string; email: string | null; active: boolean; syncedAt: Date };

/** The tenant's CRM system (HubSpot until a tenant says otherwise). */
export async function crmSystem(ctx: ModuleContext): Promise<string> {
  const [row] = await ctx.tx.select({ system: crmSetting.system }).from(crmSetting).where(eq(crmSetting.tenantId, ctx.tenantId));
  return row?.system ?? 'hubspot';
}

/** True when the last connection test showed the token can't read owners. No test result counts as allowed. */
async function ownersUnreadable(ctx: ModuleContext, system: string): Promise<boolean> {
  const conn = (await listConnections(ctx)).find((c) => c.provider === system);
  const result = conn?.lastTestResult;
  if (!result) return false;
  return result.message.includes(OWNERS_UNREADABLE) || (result.missingPermissions ?? []).some((p) => /owner/i.test(p));
}

/** Reads the CRM's owner list into `crm.owner` (insert or update, active flag included). Refused when the token can't read owners. */
export async function syncOwners(ctx: ModuleContext): Promise<{ count: number }> {
  const system = await crmSystem(ctx);
  if (await ownersUnreadable(ctx, system)) {
    throw new ScoutError({ slug: 'owners-unreadable', status: 409, title: OWNERS_UNREADABLE });
  }
  const listed = (await gateway.call(ctx, system, 'listOwners', (a) => (a as CrmAdapter).listOwners({}), { module: 'crm', requestSummary: {} })).slice(0, OWNER_SYNC_LIMIT);
  const now = new Date();
  for (const o of listed) {
    await ctx.tx
      .insert(owner)
      .values({ id: newId('cow'), tenantId: ctx.tenantId, system, externalOwnerId: o.externalId, name: o.name, email: o.email, active: o.active, syncedAt: now })
      .onConflictDoUpdate({
        target: [owner.tenantId, owner.system, owner.externalOwnerId],
        set: { name: o.name, email: o.email, active: o.active, syncedAt: now },
      });
  }
  return { count: listed.length };
}

/** The roster for the tenant's CRM, by name. */
export async function listOwners(ctx: ModuleContext): Promise<OwnerRow[]> {
  const system = await crmSystem(ctx);
  const rows = await ctx.tx
    .select()
    .from(owner)
    .where(and(eq(owner.tenantId, ctx.tenantId), eq(owner.system, system)))
    .orderBy(asc(owner.name), asc(owner.externalOwnerId));
  return rows.map(({ id: _id, tenantId: _t, ...r }) => r);
}

export type OwnerMatch = { userId: string; membershipId: string; name: string; email: string; externalOwnerId: string; ownerName: string };

/** Members with no owner id yet, paired with a roster owner of the same email (case-insensitive). Computed on read (Ruling 21). */
export async function ownerMatches(ctx: ModuleContext): Promise<OwnerMatch[]> {
  const system = await crmSystem(ctx);
  const roster = await listOwners(ctx);
  const held = new Set<string>();
  const unlinked: Awaited<ReturnType<typeof members>> = [];
  for (const m of await members(ctx)) {
    if (m.status !== 'active') continue;
    const id = await crmOwnerId(ctx, m.userId, system);
    if (id) held.add(id);
    else unlinked.push(m);
  }
  const out: OwnerMatch[] = [];
  for (const m of unlinked) {
    const hit = roster.find((o) => o.active && !held.has(o.externalOwnerId) && o.email?.toLowerCase() === m.email.toLowerCase());
    if (hit) out.push({ userId: m.userId, membershipId: m.membershipId, name: m.name, email: m.email, externalOwnerId: hit.externalOwnerId, ownerName: hit.name });
  }
  return out;
}

/** Links a member to the roster owner offered as their match. Tenancy refuses an owner another member holds. */
export async function confirmOwnerMatch(ctx: ModuleContext, input: { userId: string; externalOwnerId: string }): Promise<void> {
  const system = await crmSystem(ctx);
  const match = (await ownerMatches(ctx)).find((m) => m.userId === input.userId && m.externalOwnerId === input.externalOwnerId);
  if (!match) {
    throw new ScoutError({ slug: 'owner-match-not-found', status: 409, title: 'That HubSpot owner is not a match for this person.' });
  }
  await setCrmOwnerIds(ctx, match.membershipId, { [system]: input.externalOwnerId });
}

/** The roster name for an owner id, or null when the owner is not in the roster. */
export async function ownerName(ctx: ModuleContext, system: string, externalOwnerId: string): Promise<string | null> {
  const [row] = await ctx.tx
    .select({ name: owner.name })
    .from(owner)
    .where(and(eq(owner.tenantId, ctx.tenantId), eq(owner.system, system), eq(owner.externalOwnerId, externalOwnerId)));
  return row?.name ?? null;
}

/** True or false for an owner in the roster; null when the owner is unknown. */
export async function isOwnerActive(ctx: ModuleContext, system: string, externalOwnerId: string): Promise<boolean | null> {
  const [row] = await ctx.tx
    .select({ active: owner.active })
    .from(owner)
    .where(and(eq(owner.tenantId, ctx.tenantId), eq(owner.system, system), eq(owner.externalOwnerId, externalOwnerId)));
  return row?.active ?? null;
}

/** True once the roster has any owner for the system. */
export async function rosterSynced(ctx: ModuleContext, system: string): Promise<boolean> {
  const [row] = await ctx.tx.select({ id: owner.id }).from(owner).where(and(eq(owner.tenantId, ctx.tenantId), eq(owner.system, system))).limit(1);
  return !!row;
}
