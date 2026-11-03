import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { filterVisibleAccountIds } from '@/modules/accounts';
import { memberRole, userIdForEmail } from '@/modules/tenancy';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { warmIntroConfirmed } from '../contracts/events';
import { relationshipDefault, warmIntro, warmIntroRule } from '../db/schema';
import { RELATIONSHIP_DEFAULTS } from '../defaults';
import type { WarmIntroInput } from '../domain/normalise-arrival';
import { isConfirmed, pickRule, strongest, warmIntroFullPoints, warmIntroPoints } from '../domain/warm-intro';

export type { WarmIntroInput };

export type DeclaredBy = 'person' | 'person_key' | 'agent' | 'vendor';

export type WarmIntroView = {
  warmIntroId: string;
  arrivalId: string;
  accountId: string;
  introducerUserId: string | null;
  introducerName: string | null;
  introducerEmail: string | null;
  relationshipKey: string;
  relationshipLabel: string;
  /** The points that count: half the full points, rounded down, until confirmed. */
  points: number;
  fullPoints: number;
  confirmed: boolean;
  confirmedAt: Date | null;
};

type Row = typeof warmIntro.$inferSelect;
type Rule = typeof warmIntroRule.$inferSelect;

const view = (r: Row, labels: Map<string, string>): WarmIntroView => ({
  warmIntroId: r.id,
  arrivalId: r.arrivalId,
  accountId: r.accountId,
  introducerUserId: r.introducerUserId,
  introducerName: r.introducerName,
  introducerEmail: r.introducerEmail,
  relationshipKey: r.relationshipKey,
  relationshipLabel: labels.get(r.relationshipKey) ?? r.relationshipKey,
  points: r.effectivePoints,
  fullPoints: r.points,
  confirmed: r.confirmed,
  confirmedAt: r.confirmedAt,
});

/** The tenant's relationship rows in key order, optionally locked (always in the same order, so two lockers can't deadlock). */
export function loadDefaults(ctx: ModuleContext, lock?: 'share' | 'update') {
  const q = ctx.tx.select().from(relationshipDefault).where(eq(relationshipDefault.tenantId, ctx.tenantId)).orderBy(asc(relationshipDefault.relationshipKey));
  return lock ? q.for(lock) : q;
}

const pointsByKey = (rows: { relationshipKey: string; points: number }[]) => Object.fromEntries(rows.map((d) => [d.relationshipKey, d.points]));

/** Each relationship key's label: the tenant's, else the built-in one. */
async function relationshipLabels(ctx: ModuleContext): Promise<Map<string, string>> {
  const rows = await loadDefaults(ctx);
  return new Map([...RELATIONSHIP_DEFAULTS.map((d) => [d.relationshipKey, d.label] as const), ...rows.map((d) => [d.relationshipKey, d.label] as const)]);
}

/** The tenant user an introducer's email belongs to, if they are a member. */
async function introducerUser(ctx: ModuleContext, email: string | undefined): Promise<string | null> {
  if (!email) return null;
  const userId = await userIdForEmail(email);
  return userId && (await memberRole(ctx, userId)) ? userId : null;
}

/** An intro's points under the given rules and defaults: its introducer's rule for the relationship, else the default. */
function priced(r: Pick<Row, 'introducerUserId' | 'introducerEmail' | 'relationshipKey' | 'confirmed'>, rules: readonly Rule[], defaults: Record<string, number>) {
  const rule = pickRule(
    rules.filter((x) => x.relationshipKey === r.relationshipKey),
    { userId: r.introducerUserId, email: r.introducerEmail },
  );
  const input = { relationshipKey: r.relationshipKey, introducerRule: rule?.points, defaults };
  return { points: warmIntroFullPoints(input), effectivePoints: warmIntroPoints({ ...input, confirmed: r.confirmed }) };
}

/**
 * Stores the arrival's warm intro with its points (SRC-E5): the introducer's rule, else the
 * relationship default, halved until confirmed. One per arrival, so a retry returns the stored row.
 * The defaults are read with a share lock, so an intro recorded while settings are being saved gets the saved points.
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
  if (existing) return view(existing, await relationshipLabels(ctx));

  const email = input.introducerEmail?.trim().toLowerCase() || undefined;
  const userId = await introducerUser(ctx, email);
  const defaults = pointsByKey(await loadDefaults(ctx, 'share'));
  const rules = await ctx.tx
    .select()
    .from(warmIntroRule)
    .where(and(eq(warmIntroRule.tenantId, ctx.tenantId), eq(warmIntroRule.relationshipKey, input.relationshipKey)));
  const confirmed = isConfirmed({ declaredBy });
  const points = priced({ introducerUserId: userId, introducerEmail: email ?? null, relationshipKey: input.relationshipKey, confirmed }, rules, defaults);

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
      ...points,
      confirmed,
      confirmedBy: confirmed ? `${ctx.actor.kind}:${ctx.actor.id}` : null,
      confirmedAt: confirmed ? new Date() : null,
    })
    .onConflictDoNothing();
  return view((await stored())!, await relationshipLabels(ctx));
}

/** The strongest warm intro across the given accounts (the highest effective points; intros never add up), or null. */
export async function getWarmIntro(ctx: ModuleContext, accountIds: string | string[]): Promise<WarmIntroView | null> {
  const ids = Array.isArray(accountIds) ? accountIds : [accountIds];
  if (ids.length === 0) return null;
  const rows = await ctx.tx
    .select()
    .from(warmIntro)
    .where(and(eq(warmIntro.tenantId, ctx.tenantId), inArray(warmIntro.accountId, ids)))
    .orderBy(warmIntro.createdAt);
  const best = strongest(rows);
  return best ? view(best, await relationshipLabels(ctx)) : null;
}

const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That warm intro was not found.' });

/**
 * Confirms an agent- or vendor-declared intro so it counts in full (SRC-E5-S1-AC2). A reviewer (`canReview`)
 * or the intro's named introducer may confirm it; the account must be visible to the caller (else not found).
 * Stamps a fresh change id (wic_), audits `intake.warm_intro.confirm` and publishes `intake.warm_intro.confirmed`.
 * An intro that is already confirmed comes back unchanged, with no event and no audit row.
 */
export async function confirmWarmIntro(ctx: ModuleContext, warmIntroId: string, opts: { canReview: boolean }): Promise<WarmIntroView> {
  const [row] = await ctx.tx
    .select()
    .from(warmIntro)
    .where(and(eq(warmIntro.tenantId, ctx.tenantId), eq(warmIntro.id, warmIntroId)))
    .for('update');
  if (!row || (await filterVisibleAccountIds(ctx, [row.accountId])).length === 0) throw notFound();
  const isIntroducer = ctx.actor.kind === 'user' && row.introducerUserId !== null && ctx.actor.id === row.introducerUserId;
  if (!opts.canReview && !isIntroducer) {
    const name = row.introducerName ?? row.introducerEmail ?? 'the introducer';
    throw new ScoutError({ slug: 'forbidden', status: 403, title: `Only a reviewer or ${name}, who made the intro, can confirm it.` });
  }
  const labels = await relationshipLabels(ctx);
  if (row.confirmed) return view(row, labels);

  const changeId = newId('wic');
  const [updated] = await ctx.tx
    .update(warmIntro)
    .set({
      confirmed: true,
      effectivePoints: row.points,
      confirmedBy: `${ctx.actor.kind}:${ctx.actor.id}`,
      confirmedAt: new Date(),
      repricedChangeId: changeId,
    })
    .where(eq(warmIntro.id, row.id))
    .returning();
  await audit(ctx, {
    action: 'intake.warm_intro.confirm',
    subject: { type: 'warm_intro', id: row.id },
    before: { confirmed: false, effectivePoints: row.effectivePoints },
    after: { confirmed: true, effectivePoints: row.points },
  });
  await publish(
    ctx,
    warmIntroConfirmed,
    { warmIntroId: row.id, accountId: row.accountId, arrivalId: row.arrivalId, relationshipKey: row.relationshipKey, points: row.points, changeId },
    { type: 'account', id: row.accountId },
  );
  return view(updated!, labels);
}

/**
 * Recomputes every intro of the tenant under the current rules and defaults (the table is small). The rows whose
 * points or effective points moved get `repriced_change_id = changeId`; `accountIds` are their distinct accounts,
 * in id order. The intros are locked first, so a confirm running at the same time is never overwritten.
 * Publishes nothing: the caller does, when `accountIds` is not empty.
 */
export async function repriceWarmIntros(ctx: ModuleContext): Promise<{ changeId: string; accountIds: string[] }> {
  const changeId = newId('wic');
  const rows = await ctx.tx.select().from(warmIntro).where(eq(warmIntro.tenantId, ctx.tenantId)).orderBy(asc(warmIntro.id)).for('update');
  const rules = await ctx.tx.select().from(warmIntroRule).where(eq(warmIntroRule.tenantId, ctx.tenantId));
  const defaults = pointsByKey(await loadDefaults(ctx));
  const accountIds = new Set<string>();
  for (const r of rows) {
    const next = priced(r, rules, defaults);
    if (next.points === r.points && next.effectivePoints === r.effectivePoints) continue;
    await ctx.tx
      .update(warmIntro)
      .set({ ...next, repricedChangeId: changeId })
      .where(eq(warmIntro.id, r.id));
    accountIds.add(r.accountId);
  }
  return { changeId, accountIds: [...accountIds].sort() };
}

/** The accounts whose intros a points change (wic_) moved, in id order, `limit` at a time after `afterId`. */
export async function accountIdsForWarmIntroChange(
  ctx: ModuleContext,
  changeId: string,
  opts: { afterId?: string; limit: number },
): Promise<string[]> {
  const rows = await ctx.tx
    .selectDistinct({ id: warmIntro.accountId })
    .from(warmIntro)
    .where(
      and(
        eq(warmIntro.tenantId, ctx.tenantId),
        eq(warmIntro.repricedChangeId, changeId),
        opts.afterId ? gt(warmIntro.accountId, opts.afterId) : undefined,
      ),
    )
    .orderBy(asc(warmIntro.accountId))
    .limit(opts.limit);
  return rows.map((r) => r.id);
}
