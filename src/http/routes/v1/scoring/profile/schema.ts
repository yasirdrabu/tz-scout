import { z } from 'zod';

// Ranges are the service's to check, so a person gets the plain-words messages.
const num = z.number();

/** The fields of `PUT /api/v1/scoring/profile`, all optional. `parseBody` camelCases the top level; cutoffs are converted here. */
export const profilePatchBody = z
  .strictObject({
    weights: z.strictObject({ fit: num, intent: num, revenue: num, trust: num }).partial(),
    fit_parts: z.strictObject({ industry: num, size: num, revenue: num, region: num, buyer: num }).partial(),
    half_life_days: num,
    max_signal_age_days: num,
    tier_cutoffs: z
      .strictObject({ act_now: num, good_fit: num, watch: num })
      .partial()
      .transform(({ act_now, good_fit, watch }) => ({
        ...(act_now === undefined ? {} : { actNow: act_now }),
        ...(good_fit === undefined ? {} : { goodFit: good_fit }),
        ...(watch === undefined ? {} : { watch }),
      })),
    warm_intro_cap: num,
    trust_neutral: num,
    research_floor_days: num,
  })
  .partial();
