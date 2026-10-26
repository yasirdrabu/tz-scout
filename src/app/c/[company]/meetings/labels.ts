import type { Channel, MeetingStatus, MeetingType, TouchStatus } from "@prisma/client";
import type { Tone } from "@/components/ui";

export const MEETING_STATUS_LABEL: Record<MeetingStatus, string> = { BOOKED: "Booked", HELD: "Held", NO_SHOW: "No-show", REBOOKED: "Rebooked", CANCELLED: "Cancelled" };
export const MEETING_STATUS_TONE: Record<MeetingStatus, Tone> = { BOOKED: "neutral", HELD: "good", NO_SHOW: "bad", REBOOKED: "near", CANCELLED: "muted" };
export const MEETING_TYPE_LABEL: Record<MeetingType, string> = { DISCOVERY: "Discovery", SALES: "Sales" };

export const TOUCH_STATUS_LABEL: Record<TouchStatus, string> = { SCHEDULED: "Scheduled", SENT: "Sent", SKIPPED: "Skipped" };
export const TOUCH_STATUS_TONE: Record<TouchStatus, Tone> = { SCHEDULED: "neutral", SENT: "good", SKIPPED: "muted" };
export const CHANNEL_LABEL: Record<Channel, string> = { EMAIL: "Email", SMS: "Text message" };

/** Plain name for a touch kind: booking_link, confirmation, reminder_24h, precall_note, rebook_2. */
export function touchKindLabel(kind: string): string {
  if (kind === "booking_link") return "Booking link";
  if (kind === "confirmation") return "Confirmation";
  if (kind === "precall_note") return "Pre-call note";
  const r = /^reminder_(\d+)h$/.exec(kind);
  if (r) {
    const h = Number(r[1]);
    return `Reminder, ${h} hour${h === 1 ? "" : "s"} before`;
  }
  const b = /^rebook_(\d+)$/.exec(kind);
  if (b) return `Rebook note ${b[1]}`;
  return kind.replace(/_/g, " ");
}

export const OUTCOMES = [
  { status: "HELD", label: "Held", variant: "secondary" },
  { status: "NO_SHOW", label: "No-show", variant: "secondary" },
  { status: "CANCELLED", label: "Cancelled", variant: "ghost" },
] as const;
export type Outcome = (typeof OUTCOMES)[number]["status"];

/** Which outcome buttons a booked meeting offers: before its time only cancelling makes sense. */
export function outcomesFor(m: { status: MeetingStatus; scheduledAt: Date }, now = new Date()) {
  if (m.status !== "BOOKED") return [];
  return m.scheduledAt.getTime() <= now.getTime() ? OUTCOMES : OUTCOMES.filter((o) => o.status === "CANCELLED").map((o) => ({ ...o, label: "Mark cancelled" }));
}
