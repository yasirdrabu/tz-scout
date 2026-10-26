import type { MeetingStatus } from "@prisma/client";
import { ActionButton } from "@/components/client";
import { setMeetingStatusAction } from "./actions";
import { outcomesFor } from "./labels";

/** Held / No-show / Cancelled for a booked meeting. Renders nothing when the viewer can't log outcomes. */
export function OutcomeButtons({ slug, meeting, canUpdate, size = "sm" }: { slug: string; meeting: { id: string; status: MeetingStatus; scheduledAt: Date }; canUpdate: boolean; size?: "sm" | "md" }) {
  const options = canUpdate ? outcomesFor(meeting) : [];
  if (options.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {options.map((o) => (
        <ActionButton
          key={o.status}
          action={setMeetingStatusAction.bind(null, slug, meeting.id, o.status)}
          variant={o.variant}
          size={size}
          pendingText="Saving..."
          confirm={o.status === "NO_SHOW" ? "Mark as a no-show? This starts the rebook sequence." : o.status === "CANCELLED" ? "Mark this meeting cancelled? Pending reminders will be skipped." : undefined}
        >
          {o.label}
        </ActionButton>
      ))}
    </div>
  );
}
