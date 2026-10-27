import { and, eq, isNull } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { person } from '../db/schema';
import { pickPrimary } from '../domain/primary';

/**
 * Marks who to approach first: the pinned person if there is one, else the best by seniority and verified email.
 * Target titles come from the best offer, which arrives with R1b, so none are used yet. The caller holds the account lock.
 */
export async function repickPrimary(ctx: ModuleContext, accountId: string): Promise<void> {
  const people = await ctx.tx
    .select()
    .from(person)
    .where(and(eq(person.tenantId, ctx.tenantId), eq(person.accountId, accountId), isNull(person.archivedAt)));
  const primaryId = pickPrimary(
    people.map((p) => ({ id: p.id, title: p.title, seniority: p.seniority, emailStatus: p.emailStatus, pinnedPrimary: !!p.primaryPinnedAt })),
    [],
  );
  for (const p of people) {
    const next = p.id === primaryId;
    if (p.isPrimary !== next) {
      await ctx.tx
        .update(person)
        .set({ isPrimary: next, updatedAt: new Date() })
        .where(and(eq(person.tenantId, ctx.tenantId), eq(person.id, p.id)));
    }
  }
}
