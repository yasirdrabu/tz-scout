// Display helpers for saved pulls: schedule names, a short filter summary, and the credit estimate line.
// Pure, so the client estimate field can use them too.

import type { ProspectFilters } from "@/integrations/prospects/types";
import { money, num } from "@/lib/format";

export const SCHEDULES = [
  { key: "off", label: "Off" },
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly on Mondays" },
] as const;
export type ScheduleKey = (typeof SCHEDULES)[number]["key"];

export const scheduleLabel = (s: string) => SCHEDULES.find((x) => x.key === s)?.label ?? "Off";

const listOf = (xs: string[], max = 3) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`);

function range(lo: number | null | undefined, hi: number | null | undefined, fmt: (n: number) => string, unit: string) {
  if (lo == null && hi == null) return null;
  if (lo != null && hi != null) return `${fmt(lo)} to ${fmt(hi)} ${unit}`;
  if (lo != null) return `${fmt(lo)} or more ${unit}`;
  return `up to ${fmt(hi!)} ${unit}`;
}

/** One line per filter that is set, for lists. */
export function filterSummary(f: ProspectFilters): string[] {
  const out: string[] = [];
  if (f.industries.length) out.push(`Industries: ${listOf(f.industries)}`);
  const size = range(f.employeeMin, f.employeeMax, (n) => num(n), "employees");
  if (size) out.push(size.charAt(0).toUpperCase() + size.slice(1));
  const rev = range(f.revenueMinCents, f.revenueMaxCents, (n) => money(n, "USD", { compact: true }), "revenue");
  if (rev) out.push(rev.charAt(0).toUpperCase() + rev.slice(1));
  if (f.locations.length) out.push(`Based in ${listOf(f.locations)}`);
  if (f.hiringTitles.length) out.push(`Hiring for ${listOf(f.hiringTitles)}`);
  if (f.technologies.length) out.push(`Using ${listOf(f.technologies)}`);
  if (f.keywords.length) out.push(`Keywords: ${listOf(f.keywords)}`);
  return out;
}

export type Estimate = { requested: number; allowed: number; credits: number; cap: number; live: boolean };

/** "Up to 25 companies, about 52 Apollo credits" plus the cap and sample data notes. */
export function estimateText(e: Estimate): string {
  const companies = e.allowed < e.requested ? `Up to ${e.allowed} of ${e.requested} companies (the credit cap of ${e.cap} limits the rest)` : `Up to ${e.allowed} ${e.allowed === 1 ? "company" : "companies"}`;
  return `${companies}, about ${e.credits} Apollo credits${e.live ? "" : ". No credits on sample data"}.`;
}

/** Dollars in millions typed by a person, from stored cents. */
export const toMillions = (cents: number | null | undefined) => (cents == null ? "" : String(Math.round((cents / 100_000_000) * 100) / 100));
