import { ENV_KEY } from "@/integrations/mode";
// Settings display helpers: unit conversions between storage (cents, decimals) and what people type
// (dollars, percents), and integration notes.

import type { Format } from "@/lib/scorecard";
import type { Provider } from "@/integrations/mode";

const trim = (n: number, digits = 4) => String(Math.round(n * 10 ** digits) / 10 ** digits);

export const dollars = (cents: number | null | undefined) => (cents == null ? "" : trim(cents / 100, 2));
export const percent = (rate: number | null | undefined) => (rate == null ? "" : trim(rate * 100, 3));
export const plain = (n: number | null | undefined) => (n == null ? "" : String(n));

/** A scorecard target in the unit people type for that metric. */
export function targetToInput(format: Format, v: number | null | undefined) {
  if (v == null) return "";
  if (format === "money" || format === "moneyPrecise") return dollars(v);
  if (format === "rate") return percent(v);
  return plain(v);
}

export const UNIT_LABEL: Record<Format, string> = { money: "$", moneyPrecise: "$", rate: "%", count: "count" };

/** The environment variable that switches each integration from sample data to live. */
export const ENV_VAR: Record<Provider, string> = ENV_KEY;

export const GOES_LIVE: Record<Provider, string> = {
  prospects: "When an Apollo key is added (APOLLO_API_KEY)",
  hubspot: "Milestone 8",
  meta: "Milestone 9",
  linkedin: "Milestone 10",
  googleAds: "Milestone 10",
  companyData: "When a data provider key is added",
  booking: "When the booking calendar is connected",
  messaging: "When email and text credentials are added",
  anthropic: "When an API key is added",
};

export const TABS = [
  { key: "scoring", label: "Segment scoring" },
  { key: "tests", label: "Message tests" },
  { key: "funnel", label: "Funnel" },
  { key: "sequence", label: "Show-up sequence" },
  { key: "scorecard", label: "Scorecard" },
  { key: "buyers", label: "Buyers" },
  { key: "integrations", label: "Integrations" },
  { key: "team", label: "Team" },
] as const;
export type TabKey = (typeof TABS)[number]["key"];
