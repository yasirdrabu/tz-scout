import { and, eq, or } from 'drizzle-orm';
import { memberRole, userIdForEmail } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { newId } from '@/platform/ids';
import { relationshipDefault, warmIntro, warmIntroRule } from '../db/schema';
import { isConfirmed, strongest, warmIntroFullPoints, warmIntroPoints } from '../domain/warm-intro';

/** A declared intro after normalising: the relationship key is already mapped (else `other`). */
export type WarmIntroInput = {
  introducerName?: string;
  introducerEmail?: string;
  relationshipText?: string;
  relationshipKey: string;
  note?: string;
};

export type DeclaredBy = 'person' | 'person_key' | 'agent' | 'vendor';

export type WarmIntroView = {
  warmIntroId: string;
  arrivalId: string;
  accountId: string;
  introducerUserId: string | null;
  introducerName: string | null;
  relationshipKey: string;
  /** The points that count: half the full points, rounded down, until confirmed. */
  points: number;
  fullPoints: number;
  confirmed: boolean;
};

type Row = typeof warmIntro.$inferSelect;

const view = (r: Row): WarmIntroView => ({
  warmIntroId: r.id,
  arrivalId: r.arrivalId,
  accountId: r.accountId,
  introducerUserId: r.introducerUserId,
  introducerName: r.introducerName,
  relationshipKey: r.relationshipKey,
  points: r.effectivePoints,
  fullPoints: r.points,
  confirmed: r.confirmed,
});

/** The tenant user an introducer's email belongs to, if they are a member. */
async function introducerUser(ctx: ModuleContext, email: string | undefined): Promise<string | null> {
  if (!email) return null;
  const userId = await userIdForEmail(email);
  return userId && (await memberRole(ctx, userId)) ? userId : null;
}

/**
 * Stores the arrival's warm intro with its points (SRC-E5): the introducer's rule, else the
 * relationship default, halved until confirmed. One per arrival, so a retry returns the stored row.
 */
export async function recordWarmIntro(
  ctx: ModuleContext,
  arrivalId: string,
  accountId: string,
  input: WarmIntroInput,
  declaredBy: DeclaredBy,
): Promise<WarmIntroView> {
  const stored = async () =>
    (await ctx.tx.select().from(warmIntro).where(and(eq(warmIntro.tenantId, ctx.tenantId), eq(warmIntro.arrivalId, arrivalId))))[0];
  const existing = await stored();
  if (existing) return view(existing);

  const email = input.introducerEmail?.trim().toLowerCase() || undefined;
  const userId = await introducerUser(ctx, email);
  const rules = await ctx.tx
    .select()
    .from(warmIntroRule)
    .where(
      and(
        eq(warmIntroRule.tenantId, ctx.tenantId),
        eq(warmIntroRule.relationshipKey, input.relationshipKey),
        or(userId ? eq(warmIntroRule.introducerUserId, userId) : undefined, email ? eq(warmIntroRule.introducerEmail, email) : undefined),
      ),
    );
  const rule = (userId ? rules.find((r) => r.introducerUserId === userId) : undefined) ?? rules.find((r) => email && r.introducerEmail === email);
  const defaults = Object.fromEntries(
    (await ctx.tx.select().from(relationshipDefault).where(eq(relationshipDefault.tenantId, ctx.tenantId))).map((d) => [d.relationshipKey, d.points]),
  );
  const confirmed = isConfirmed({ declaredBy });
  const points = { relationshipKey: input.relationshipKey, introducerRule: rule?.points, defaults };

  await ctx.tx
    .insert(warmIntro)
    .values({
      id: newId('wi'),
      tenantId: ctx.tenantId,
      arrivalId,
      accountId,
      introducerUserId: userId,
      introducerName: input.introducerName ?? null,
      introducerEmail: email ?? null,
      relationshipText: input.relationshipText ?? null,
      relationshipKey: input.relationshipKey,
      note: input.note ?? null,
      points: warmIntroFullPoints(points),
      effectivePoints: warmIntroPoints({ ...points, confirmed }),
      confirmed,
      confirmedBy: confirmed ? `${ctx.actor.kind}:${ctx.actor.id}` : null,
    })
    .onConflictDoNothing();
  return view((await stored())!);
}

/** The strongest warm intro on the account (the highest effective points; intros never add up), or null. */
export async function getWarmIntro(ctx: ModuleContext, accountId: string): Promise<WarmIntroView | null> {
  const rows = await ctx.tx
    .select()
    .from(warmIntro)
    .where(and(eq(warmIntro.tenantId, ctx.tenantId), eq(warmIntro.accountId, accountId)))
    .orderBy(warmIntro.createdAt);
  const best = strongest(rows);
  return best ? view(best) : null;
}
