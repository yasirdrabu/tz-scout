import { and, eq } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { memberPreference } from '../db/schema';

/** Preferences are a person's own; an API key has none. */
function me(ctx: ModuleContext): string {
  const userId = ctx.access?.userId;
  if (!userId) throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Only a person can do this here.' });
  return userId;
}

const where = (ctx: ModuleContext, userId: string, key: string) =>
  and(eq(memberPreference.tenantId, ctx.tenantId), eq(memberPreference.userId, userId), eq(memberPreference.key, key));

/** The caller's stored value for `key` in this workspace, or null when they never saved one. */
export async function getPreference(ctx: ModuleContext, key: string): Promise<unknown> {
  const [row] = await ctx.tx.select({ value: memberPreference.value }).from(memberPreference).where(where(ctx, me(ctx), key));
  return row ? row.value : null;
}

/** Saves the caller's value for `key`; the owning feature has checked it. */
export async function setPreference(ctx: ModuleContext, key: string, value: unknown): Promise<void> {
  const userId = me(ctx);
  await ctx.tx
    .insert(memberPreference)
    .values({ tenantId: ctx.tenantId, userId, key, value })
    .onConflictDoUpdate({ target: [memberPreference.tenantId, memberPreference.userId, memberPreference.key], set: { value, updatedAt: new Date() } });
}

/** Forgets the caller's value for `key`, so the default applies again. */
export async function clearPreference(ctx: ModuleContext, key: string): Promise<void> {
  await ctx.tx.delete(memberPreference).where(where(ctx, me(ctx), key));
}
