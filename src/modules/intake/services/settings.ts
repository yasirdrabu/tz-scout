import { and, asc, eq } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { relationshipDefault } from '../db/schema';

export type RelationshipDefaultView = { relationshipKey: string; label: string; points: number };

const MAX_POINTS = 20;

const view = (r: typeof relationshipDefault.$inferSelect): RelationshipDefaultView => ({
  relationshipKey: r.relationshipKey,
  label: r.label,
  points: r.points,
});

export async function listRelationshipDefaults(ctx: ModuleContext): Promise<RelationshipDefaultView[]> {
  const rows = await ctx.tx
    .select()
    .from(relationshipDefault)
    .where(eq(relationshipDefault.tenantId, ctx.tenantId))
    .orderBy(asc(relationshipDefault.relationshipKey));
  return rows.map(view);
}

/**
 * Sets the default points for a relationship (0 to 20). Platform admins only in R1 (SRC-E5): the route
 * enforces that, as permissions are not part of `Access`. Publishes nothing in R1a, because nothing
 * scores from warm intros until a later release; intros already recorded keep the points they were given.
 */
export async function setRelationshipDefault(ctx: ModuleContext, relationshipKey: string, points: number): Promise<RelationshipDefaultView> {
  if (!Number.isInteger(points) || points < 0 || points > MAX_POINTS) {
    throw new ScoutError({
      slug: 'validation',
      status: 400,
      title: 'Check the request.',
      errors: [{ path: 'points', message: `Points must be a whole number from 0 to ${MAX_POINTS}.` }],
    });
  }
  const [before] = await ctx.tx
    .select()
    .from(relationshipDefault)
    .where(and(eq(relationshipDefault.tenantId, ctx.tenantId), eq(relationshipDefault.relationshipKey, relationshipKey)));
  if (!before) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That relationship was not found.' });
  const [row] = await ctx.tx
    .update(relationshipDefault)
    .set({ points })
    .where(and(eq(relationshipDefault.tenantId, ctx.tenantId), eq(relationshipDefault.relationshipKey, relationshipKey)))
    .returning();
  await audit(ctx, {
    action: 'intake.relationship_default.set',
    subject: { type: 'relationship_default', id: relationshipKey },
    before: { points: before.points },
    after: { points },
  });
  return view(row!);
}
