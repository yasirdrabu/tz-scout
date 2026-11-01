import { and, eq, gte, sql } from 'drizzle-orm';
import { members } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { scoreChange, scoringProfile } from '../db/schema';

/** How long the review queue shows the banner after a settings change (Ruling 16). */
const RECENT_MS = 7 * 86_400_000;

export type LastRescoreView = {
  version: number;
  changedAt: Date;
  changedByName: string | null;
  summary: string;
  weightsText: string;
  /** Accounts the rescore since the change moved to another tier. */
  tierChangedCount: number;
};

const pct = (w: number) => `${Math.round(w * 100)}%`;

/**
 * The review queue's rescore banner (Ruling 16): the last change to the scoring settings, when a person made it in
 * the last 7 days, with the accounts whose `rules_changed` rescore since then moved them to another tier. Null when
 * the profile was never changed by a person or the change is older. A manual rescore changes no settings, so it
 * shows nothing here.
 */
export async function lastRescore(ctx: ModuleContext, now: Date = new Date()): Promise<LastRescoreView | null> {
  const [p] = await ctx.tx
    .select({ version: scoringProfile.version, at: scoringProfile.updatedAt, by: scoringProfile.updatedBy, fit: scoringProfile.fitWeight, intent: scoringProfile.intentWeight })
    .from(scoringProfile)
    .where(eq(scoringProfile.tenantId, ctx.tenantId));
  if (!p?.by || now.getTime() - p.at.getTime() > RECENT_MS) return null;
  const [moved] = await ctx.tx
    .select({ n: sql<number>`count(distinct ${scoreChange.accountId})::int` })
    .from(scoreChange)
    .where(
      and(
        eq(scoreChange.tenantId, ctx.tenantId),
        eq(scoreChange.cause, 'rules_changed'),
        gte(scoreChange.at, p.at),
        sql`${scoreChange.fromTier} is distinct from ${scoreChange.toTier}`,
      ),
    );
  const name = (await members(ctx)).find((m) => m.userId === p.by)?.name ?? null;
  return {
    version: p.version,
    changedAt: p.at,
    changedByName: name,
    summary: 'Scoring settings changed',
    weightsText: `Fit ${pct(p.fit)}, buying intent ${pct(p.intent)}`,
    tierChangedCount: moved?.n ?? 0,
  };
}
