import { z } from 'zod';
import { PRICE_MODELS } from '@/modules/offers';

const text = z.string();
const list = z.array(z.string());
const int = z.number().int();
const cents = int.nonnegative().nullable();
const rate = z.number().nonnegative().nullable();
const section = z.string().max(4000, 'Keep this under 4,000 characters.').nullable();

// Only fields a person may set. Status, approval, tenant, id and origin are never accepted.
const editable = {
  slug: text,
  name: text,
  promise: text,
  description: text.nullable(),
  practice_id: text,
  price_min_cents: cents,
  price_max_cents: cents,
  gross_margin: rate,
  typical_deal_cents: cents,
  expansion_rate: rate,
  expansion_value_cents: cents,
  sales_cycle_days: int.nonnegative().nullable(),
  target_titles: list,
  target_buying_roles: list,
  optional_buying_roles: list,
  company_size_min: int.nonnegative().nullable(),
  company_size_max: int.nonnegative().nullable(),
  revenue_min_cents: cents,
  revenue_max_cents: cents,
  industries: list,
  regions: list,
  excluded_domains: list,
  excluded_categories: list,
  proof_points: list,
  price_model: z.enum(PRICE_MODELS, 'Pick fixed, starting_at, per_month or custom.').nullable(),
  length_weeks: int.min(1, 'Use 1 to 260 weeks.').max(260, 'Use 1 to 260 weeks.').nullable(),
  key_offer: section,
  why_us: section,
  why_now: section,
};

export const createOfferBody = z
  .strictObject(editable)
  .partial()
  .required({ name: true, practice_id: true, promise: true });
export const patchOfferBody = z.strictObject(editable).partial();
