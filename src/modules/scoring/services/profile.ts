import { eq } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import type { FitParts, ScoringProfile, TierThresholds } from '../contracts/types';
import { DEFAULT_PROFILE } from '../defaults';
import { scoringProfile } from '../db/schema';

/** `version` is 0 when the tenant has no profile row and the defaults apply. */
export type ProfileView = ScoringProfile & { version: number };

/** The tenant's scoring profile, or the defaults when there is no row. */
export async function getProfile(ctx: ModuleContext): Promise<ProfileView> {
  const [row] = await ctx.tx.select().from(scoringProfile).where(eq(scoringProfile.tenantId, ctx.tenantId));
  if (!row) return { ...DEFAULT_PROFILE, version: 0 };
  return {
    fitWeight: row.fitWeight,
    intentWeight: row.intentWeight,
    fitParts: row.fitParts as FitParts,
    halfLifeDays: row.halfLifeDays,
    maxSignalAgeDays: row.maxSignalAgeDays,
    tierThresholds: row.tierThresholds as TierThresholds,
    warmIntroCap: row.warmIntroCap,
    trustModifierMax: row.trustModifierMax,
    trustNeutral: row.trustNeutral,
    researchFloorDays: row.researchFloorDays,
    version: row.version,
  };
}
