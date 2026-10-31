import { z } from 'zod';

// Ranges are the service's to check, so a person gets the plain-words messages.
const num = z.number();

/** The fields of `PUT /api/v1/scoring/profile`, all optional. `parseBody` camelCases the top level; thresholds are converted here. */
export const profilePatchBody = z
  .strictObject({
    fit_weight: num,
    intent_weight: num,
    fit_parts: z.strictObject({ industry: num, size: num, revenue: num, region: num, buyer: num }).partial(),
    half_life_days: num,
    max_signal_age_days: num,
    tier_thresholds: z
      .strictObject({
        not_fit_below: num,
        act_now: z.strictObject({ fit: num, intent: num, total: num }).partial(),
        good_fit: z.strictObject({ fit: num }).partial(),
      })
      .partial()
      .transform(({ not_fit_below, act_now, good_fit }) => ({
        ...(not_fit_below === undefined ? {} : { notFitBelow: not_fit_below }),
        ...(act_now === undefined ? {} : { actNow: act_now }),
        ...(good_fit === undefined ? {} : { goodFit: good_fit }),
      })),
    warm_intro_cap: num,
    trust_modifier_max: num,
    trust_neutral: num,
    research_floor_days: num,
  })
  .partial();
