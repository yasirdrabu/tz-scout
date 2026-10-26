import type { CheckResult, LeadStatus } from "@prisma/client";
import type { Tone } from "@/components/ui";
import { TIMELINE_OPTIONS } from "@/lib/leadChecks";

export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = { NEW: "Checking", VALIDATING: "Checking", VALIDATED: "Validated", NOT_QUALIFIED: "Not qualified", REVIEW: "Needs review" };
export const LEAD_STATUS_TONE: Record<LeadStatus, Tone> = { NEW: "neutral", VALIDATING: "neutral", VALIDATED: "good", NOT_QUALIFIED: "bad", REVIEW: "near" };

export const CHECK_LABEL: Record<CheckResult, string> = { PASS: "Pass", FAIL: "Fail", UNKNOWN: "Unknown" };
export const CHECK_TONE: Record<CheckResult, Tone> = { PASS: "good", FAIL: "bad", UNKNOWN: "near" };

export const LEAD_TABS = [
  { key: "review", label: "Needs review" },
  { key: "validated", label: "Validated" },
  { key: "not_qualified", label: "Not qualified" },
  { key: "all", label: "All" },
] as const;
export type LeadTab = (typeof LEAD_TABS)[number]["key"];

export const timelineLabel = (v: string | null | undefined) => (v ? (TIMELINE_OPTIONS.find((t) => t.value === v)?.label ?? v) : null);

export const personName = (l: { firstName: string; lastName: string }) => `${l.firstName} ${l.lastName}`.trim();
