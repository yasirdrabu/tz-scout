import { asc, eq } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { declineReasonDef, reviewStatusDef, routingSetting } from '../db/schema';
import { DEFAULT_AUTO_ACCEPT_WORKING_DAYS } from '../defaults';
import { requirePerson } from './review';

export type ReviewSettings = {
  statuses: {
    key: string;
    label: string;
    order: number;
    countsAsReviewed: boolean;
    isDeclined: boolean;
    isInitial: boolean;
    returnsToSource: boolean;
    tone: string;
    archived: boolean;
  }[];
  declineReasons: { key: string; label: string; appliesTo: string; noteRequired: boolean; archived: boolean }[];
  /** 1 to 10 working days, or null when auto-acceptance is off. */
  autoAcceptWorkingDays: number | null;
};

/** The review statuses, decline reasons and the auto-accept setting (REV-E1-S4 reads; R1b changes only the setting). */
export async function getReviewSettings(ctx: ModuleContext): Promise<ReviewSettings> {
  const statuses = await ctx.tx.select().from(reviewStatusDef).where(eq(reviewStatusDef.tenantId, ctx.tenantId)).orderBy(asc(reviewStatusDef.order), asc(reviewStatusDef.key));
  const reasons = await ctx.tx.select().from(declineReasonDef).where(eq(declineReasonDef.tenantId, ctx.tenantId)).orderBy(asc(declineReasonDef.label));
  const [setting] = await ctx.tx.select({ days: routingSetting.autoAcceptWorkingDays }).from(routingSetting).where(eq(routingSetting.tenantId, ctx.tenantId));
  return {
    statuses: statuses.map((s) => ({
      key: s.key,
      label: s.label,
      order: s.order,
      countsAsReviewed: s.countsAsReviewed,
      isDeclined: s.isDeclined,
      isInitial: s.isInitial,
      returnsToSource: s.returnsToSource,
      tone: s.tone,
      archived: !!s.archivedAt,
    })),
    // "Other" always needs a note (REV-E3-S2).
    declineReasons: reasons.map((r) => ({ key: r.key, label: r.label, appliesTo: r.appliesTo, noteRequired: r.key === 'other', archived: !!r.archivedAt })),
    autoAcceptWorkingDays: setting ? setting.days : DEFAULT_AUTO_ACCEPT_WORKING_DAYS,
  };
}

/** Sets how many working days a pending assignment waits before it is accepted for the seller; null turns it off. Audited. */
export async function setAutoAcceptWorkingDays(ctx: ModuleContext, days: number | null): Promise<ReviewSettings> {
  requirePerson(ctx);
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 10)) {
    const message = 'Pick 1 to 10 working days, or turn it off.';
    throw new ScoutError({ slug: 'validation', status: 400, title: message, errors: [{ path: 'autoAcceptWorkingDays', message }] });
  }
  const before = (await getReviewSettings(ctx)).autoAcceptWorkingDays;
  await ctx.tx
    .insert(routingSetting)
    .values({ tenantId: ctx.tenantId, autoAcceptWorkingDays: days })
    .onConflictDoUpdate({ target: routingSetting.tenantId, set: { autoAcceptWorkingDays: days, updatedAt: new Date() } });
  if (before !== days) {
    await audit(ctx, {
      action: 'routing.settings.updated',
      subject: { type: 'routing_setting', id: ctx.tenantId },
      before: { autoAcceptWorkingDays: before },
      after: { autoAcceptWorkingDays: days },
    });
  }
  return getReviewSettings(ctx);
}
