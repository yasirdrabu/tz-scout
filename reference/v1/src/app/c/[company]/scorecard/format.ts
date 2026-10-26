// Display helpers for the scorecard. Colours are decided by colourFor in src/lib/scorecard.ts; this only
// maps them to classes and formats values by each metric's unit.

import type { Format } from "@/lib/scorecard";
import type { Tone } from "@/components/ui";
import { date, money, num, pct } from "@/lib/format";

export function fmtMetric(format: Format, v: number | null | undefined, currency: string): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  if (format === "money") return money(v, currency);
  if (format === "moneyPrecise") return money(v, currency, { precise: true });
  if (format === "rate") return pct(v);
  return num(v, Number.isInteger(v) || Math.abs(v) >= 100 ? 0 : 1);
}

export const CELL_TONE: Record<Tone, string> = {
  good: "bg-good-soft text-good",
  near: "bg-near-soft text-near",
  bad: "bg-bad-soft text-bad",
  muted: "text-ink-faint",
  neutral: "",
  accent: "",
};

export const weekLabel = (d: Date) => date(d, { month: "short", day: "numeric" });
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export const OWNER_ROLES = ["Owner", "Operator", "Sales"] as const;
export const ROLE_TONE: Record<string, Tone> = { Owner: "accent", Operator: "neutral", Sales: "neutral" };
