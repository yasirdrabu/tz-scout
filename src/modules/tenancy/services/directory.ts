import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { apiKey, membership, user } from '../db/schema';

export type DirectoryEntry = { userId: string; name: string };

/** The workspace's active members by name, for owner and "sent by" pickers (no emails, roles or permissions). */
export async function memberDirectory(ctx: ModuleContext): Promise<DirectoryEntry[]> {
  return ctx.tx
    .select({ userId: membership.userId, name: user.name })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(and(eq(membership.tenantId, ctx.tenantId), eq(membership.status, 'active')))
    .orderBy(asc(user.name), asc(user.id));
}

/** Each given user's display name, by id; unknown ids are left out. Former members keep their name. */
export async function userNames(ctx: ModuleContext, ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map();
  const rows = await ctx.tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Each given API key's name, by id, in the context's tenant; unknown ids are left out. Revoked keys keep their name. */
export async function apiKeyNames(ctx: ModuleContext, ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map();
  const rows = await ctx.tx
    .select({ id: apiKey.id, name: apiKey.name })
    .from(apiKey)
    .where(and(eq(apiKey.tenantId, ctx.tenantId), inArray(apiKey.id, wanted)));
  return new Map(rows.map((r) => [r.id, r.name]));
}
