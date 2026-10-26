import type { Tone } from "@/components/ui";
import type { Action } from "@/lib/permissions";

export const SEGMENT_STATUSES = ["PROPOSED", "SHORTLISTED", "ACTIVE", "REJECTED"] as const;
export type SegmentStatusKey = (typeof SEGMENT_STATUSES)[number];

export const SEGMENT_STATUS_LABEL: Record<SegmentStatusKey, string> = { PROPOSED: "Proposed", SHORTLISTED: "Shortlisted", ACTIVE: "Active", REJECTED: "Rejected" };
export const SEGMENT_STATUS_TONE: Record<SegmentStatusKey, Tone> = { PROPOSED: "neutral", SHORTLISTED: "accent", ACTIVE: "good", REJECTED: "muted" };

export const ORIGIN_LABEL = { AI: "Proposed by Claude", MANUAL: "Added by hand" } as const;

/** The status changes offered from each status. */
export const STATUS_MOVES: Record<SegmentStatusKey, { to: SegmentStatusKey; label: string }[]> = {
  PROPOSED: [
    { to: "SHORTLISTED", label: "Shortlist" },
    { to: "ACTIVE", label: "Activate" },
    { to: "REJECTED", label: "Reject" },
  ],
  SHORTLISTED: [
    { to: "ACTIVE", label: "Activate" },
    { to: "PROPOSED", label: "Back to proposed" },
    { to: "REJECTED", label: "Reject" },
  ],
  ACTIVE: [{ to: "SHORTLISTED", label: "Pause" }],
  REJECTED: [{ to: "PROPOSED", label: "Back to proposed" }],
};

/** Owners decide which segments are active, so moving into or out of Active needs that permission. */
export function moveNeeds(from: SegmentStatusKey, to: SegmentStatusKey): Action {
  return to === "ACTIVE" || from === "ACTIVE" ? "segment.activate" : "segment.generate";
}

export const isSegmentStatus = (s: unknown): s is SegmentStatusKey => typeof s === "string" && (SEGMENT_STATUSES as readonly string[]).includes(s);

/** The factors a person rates when adding a segment by hand. The rest come from data. */
export const MANUAL_FACTORS = ["pain", "urgency", "ability_to_pay", "delivery_fit", "committee", "cycle"] as const;
