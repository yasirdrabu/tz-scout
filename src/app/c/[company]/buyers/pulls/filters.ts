// Server-side helpers for pull pages: read stored filters and build the credit estimate table.

import { FiltersSchema, pullEstimate } from "@/server/buyers";
import type { ProspectFilters } from "@/integrations/prospects";
import type { Estimate } from "./labels";

/** Stored filters, read safely (older rows may be missing keys). */
export function readFilters(raw: unknown): ProspectFilters {
  const p = FiltersSchema.safeParse(raw ?? {});
  return p.success ? (p.data as ProspectFilters) : (FiltersSchema.parse({}) as ProspectFilters);
}

export function estimateFor(maxCompanies: number): Estimate {
  const e = pullEstimate(maxCompanies);
  return { requested: e.requested, allowed: e.allowed, credits: e.credits, cap: e.cap, live: e.live };
}

/** Estimates for 1 to 200 companies, so the form can update the line as the number changes. */
export function estimateTable(): Estimate[] {
  return Array.from({ length: 200 }, (_, i) => estimateFor(i + 1));
}
