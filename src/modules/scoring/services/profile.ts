import { isDeepStrictEqual } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { rulesChanged } from '../contracts/events';
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

type Patch = Partial<Omit<ScoringProfile, 'fitParts' | 'tierThresholds'>> & {
  fitParts?: Partial<FitParts>;
  tierThresholds?: { notFitBelow?: number; actNow?: Partial<TierThresholds['actNow']>; goodFit?: Partial<TierThresholds['goodFit']> };
};
export type ProfilePatch = Patch;

const KEYS = [
  'fitWeight',
  'intentWeight',
  'fitParts',
  'halfLifeDays',
  'maxSignalAgeDays',
  'tierThresholds',
  'warmIntroCap',
  'trustModifierMax',
  'trustNeutral',
  'researchFloorDays',
] as const;

const between = (n: number, min: number, max: number) => Number.isFinite(n) && n >= min && n <= max;

/** What is wrong with `p`, as the messages to show next to the fields. Empty when it is fine. */
function problems(p: ScoringProfile): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  const bad = (path: string, message: string) => out.push({ path, message });
  if (!between(p.fitWeight, 0, 1) || !between(p.intentWeight, 0, 1)) bad('fitWeight', 'Weights must be between 0 and 1.');
  else if (p.fitWeight === 0 && p.intentWeight === 0) bad('fitWeight', "Fit and intent can't both have weight 0.");
  const parts = Object.values(p.fitParts);
  if (parts.some((n) => !between(n, 0, 100)) || parts.reduce((a, b) => a + b, 0) !== 100) bad('fitParts', 'The fit parts must add up to 100.');
  if (!Number.isInteger(p.halfLifeDays) || !between(p.halfLifeDays, 1, 365)) bad('halfLifeDays', 'Half-life must be between 1 and 365 days.');
  if (!Number.isInteger(p.maxSignalAgeDays) || p.maxSignalAgeDays < 1) bad('maxSignalAgeDays', 'Signals must count for at least 1 day.');
  const t = p.tierThresholds;
  if (![t.notFitBelow, t.actNow.fit, t.actNow.intent, t.actNow.total, t.goodFit.fit].every((n) => between(n, 0, 100))) {
    bad('tierThresholds', 'Tier thresholds must be between 0 and 100.');
  }
  if (!Number.isInteger(p.warmIntroCap) || !between(p.warmIntroCap, 0, 20)) bad('warmIntroCap', 'The warm intro cap must be between 0 and 20.');
  if (!Number.isInteger(p.trustModifierMax) || !between(p.trustModifierMax, 0, 10)) bad('trustModifierMax', 'The trust modifier must be between 0 and 10.');
  if (!between(p.trustNeutral, 0, 1)) bad('trustNeutral', 'Neutral trust must be between 0 and 1.');
  if (!Number.isInteger(p.researchFloorDays) || p.researchFloorDays < 0) bad('researchFloorDays', 'The research floor must be 0 days or more.');
  return out;
}

/**
 * Applies `patch` on top of the current profile (fit parts and thresholds merge field by field), validates the
 * result, bumps `version`, publishes `scoring.rules.changed` and audits the changed fields before and after.
 * A patch that changes nothing writes nothing. The route (`scoring:manage`) checks who may call this.
 */
export async function updateProfile(ctx: ModuleContext, patch: ProfilePatch): Promise<ProfileView> {
  await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ctx.tenantId} || ':scoring-profile'))`);
  const { version, ...before } = await getProfile(ctx);
  const next: ScoringProfile = {
    ...before,
    ...patch,
    fitParts: { ...before.fitParts, ...patch.fitParts },
    tierThresholds: {
      notFitBelow: patch.tierThresholds?.notFitBelow ?? before.tierThresholds.notFitBelow,
      actNow: { ...before.tierThresholds.actNow, ...patch.tierThresholds?.actNow },
      goodFit: { ...before.tierThresholds.goodFit, ...patch.tierThresholds?.goodFit },
    },
  };
  const errors = problems(next);
  if (errors.length > 0) throw new ScoutError({ slug: 'validation', status: 400, title: 'Check the scoring settings.', errors });
  const changed = KEYS.filter((k) => !isDeepStrictEqual(before[k], next[k]));
  if (changed.length === 0) return { ...before, version };

  const row = { ...next, version: version + 1, updatedBy: ctx.actor.id, updatedAt: new Date() };
  await ctx.tx
    .insert(scoringProfile)
    .values({ tenantId: ctx.tenantId, ...row })
    .onConflictDoUpdate({ target: scoringProfile.tenantId, set: row });
  await publish(ctx, rulesChanged, { profileVersion: row.version, changed: [...changed], changedBy: ctx.actor.id }, { type: 'scoring_profile', id: ctx.tenantId });
  await audit(ctx, {
    action: 'scoring.profile.updated',
    subject: { type: 'scoring_profile', id: ctx.tenantId },
    before: Object.fromEntries(changed.map((k) => [k, before[k]])),
    after: Object.fromEntries(changed.map((k) => [k, next[k]])),
  });
  return { ...next, version: row.version };
}

/** Puts every setting back to the defaults (SCO-E5-S3-AC5). */
export function resetProfile(ctx: ModuleContext): Promise<ProfileView> {
  return updateProfile(ctx, DEFAULT_PROFILE);
}
