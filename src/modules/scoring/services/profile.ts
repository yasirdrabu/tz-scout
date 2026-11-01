import { isDeepStrictEqual } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { rulesChanged } from '../contracts/events';
import type { FitParts, ScoringProfile, TierCutoffs, Weights } from '../contracts/types';
import { DEFAULT_PROFILE } from '../defaults';
import { scoringProfile } from '../db/schema';

/** `version` is 0 when the tenant has no profile row and the defaults apply. */
export type ProfileView = ScoringProfile & { version: number };

/** The tenant's scoring profile, or the defaults when there is no row. */
export async function getProfile(ctx: ModuleContext): Promise<ProfileView> {
  const [row] = await ctx.tx.select().from(scoringProfile).where(eq(scoringProfile.tenantId, ctx.tenantId));
  if (!row) return { ...DEFAULT_PROFILE, version: 0 };
  return {
    weights: row.weights as Weights,
    fitParts: row.fitParts as FitParts,
    halfLifeDays: row.halfLifeDays,
    maxSignalAgeDays: row.maxSignalAgeDays,
    tierCutoffs: row.tierCutoffs as TierCutoffs,
    warmIntroCap: row.warmIntroCap,
    trustNeutral: row.trustNeutral,
    researchFloorDays: row.researchFloorDays,
    version: row.version,
  };
}

type Patch = Partial<Omit<ScoringProfile, 'fitParts' | 'weights' | 'tierCutoffs'>> & {
  fitParts?: Partial<FitParts>;
  weights?: Partial<Weights>;
  tierCutoffs?: Partial<TierCutoffs>;
};
export type ProfilePatch = Patch;

const KEYS = [
  'weights',
  'fitParts',
  'halfLifeDays',
  'maxSignalAgeDays',
  'tierCutoffs',
  'warmIntroCap',
  'trustNeutral',
  'researchFloorDays',
] as const;

const between = (n: number, min: number, max: number) => Number.isFinite(n) && n >= min && n <= max;

/** What is wrong with `p`, as the messages to show next to the fields. Empty when it is fine. */
function problems(p: ScoringProfile): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  const bad = (path: string, message: string) => out.push({ path, message });
  const weights = Object.values(p.weights);
  if (weights.some((n) => !Number.isInteger(n) || !between(n, 0, 60) || n % 5 !== 0)) bad('weights', 'Each weight is 0 to 60, in steps of 5.');
  else if (weights.reduce((a, b) => a + b, 0) !== 100) bad('weights', `Weights add up to ${weights.reduce((a, b) => a + b, 0)}. Make them add up to 100.`);
  const parts = Object.values(p.fitParts);
  if (parts.some((n) => !between(n, 0, 100)) || parts.reduce((a, b) => a + b, 0) !== 100) bad('fitParts', 'The fit parts must add up to 100.');
  if (!Number.isInteger(p.halfLifeDays) || !between(p.halfLifeDays, 1, 365)) bad('halfLifeDays', 'Half-life must be between 1 and 365 days.');
  if (!Number.isInteger(p.maxSignalAgeDays) || p.maxSignalAgeDays < 1) bad('maxSignalAgeDays', 'Signals must count for at least 1 day.');
  const c = p.tierCutoffs;
  if (![c.actNow, c.goodFit, c.watch].every((n) => Number.isInteger(n))) bad('tierCutoffs', 'Cutoffs must be whole numbers.');
  else {
    if (c.actNow > 100) bad('tierCutoffs.actNow', "Act now can't start higher than 100.");
    else if (c.actNow <= c.goodFit) bad('tierCutoffs.actNow', 'Act now has to start higher than Good fit.');
    if (c.watch < 1) bad('tierCutoffs.watch', 'Watch has to start at 1 or more.');
    else if (c.goodFit <= c.watch) bad('tierCutoffs.goodFit', 'Good fit has to start higher than Watch.');
  }
  if (!Number.isInteger(p.warmIntroCap) || !between(p.warmIntroCap, 0, 20)) bad('warmIntroCap', 'The warm intro cap must be between 0 and 20.');
  if (!between(p.trustNeutral, 0, 1)) bad('trustNeutral', 'Neutral trust must be between 0 and 1.');
  if (!Number.isInteger(p.researchFloorDays) || p.researchFloorDays < 0) bad('researchFloorDays', 'The research floor must be 0 days or more.');
  return out;
}

/** `patch` on top of `before`, merged field by field and validated. Throws the 400 with the messages to show. */
export function draftProfile(before: ScoringProfile, patch: ProfilePatch): ScoringProfile {
  const next: ScoringProfile = {
    ...before,
    ...patch,
    fitParts: { ...before.fitParts, ...patch.fitParts },
    weights: { ...before.weights, ...patch.weights },
    tierCutoffs: { ...before.tierCutoffs, ...patch.tierCutoffs },
  };
  const errors = problems(next);
  if (errors.length > 0) throw new ScoutError({ slug: 'validation', status: 400, title: 'Check the scoring settings.', errors });
  return next;
}

/**
 * Applies `patch` on top of the current profile (weights, fit parts and cutoffs merge field by field), validates the
 * result, bumps `version`, publishes `scoring.rules.changed` and audits the changed fields before and after.
 * A patch that changes nothing writes nothing. The route (`scoring:manage`) checks who may call this.
 */
export async function updateProfile(ctx: ModuleContext, patch: ProfilePatch): Promise<ProfileView> {
  await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ctx.tenantId} || ':scoring-profile'))`);
  const { version, ...before } = await getProfile(ctx);
  const next = draftProfile(before, patch);
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
