"use server";

import { authorize } from "@/server/context";
import { act, type ActionResult } from "@/server/action";
import { setMeetingStatus } from "@/server/meetings";

/** Log a meeting outcome. A no-show starts the rebook sequence inside the service. */
export async function setMeetingStatusAction(slug: string, meetingId: string, status: "HELD" | "NO_SHOW" | "CANCELLED", _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      if (!["HELD", "NO_SHOW", "CANCELLED"].includes(status)) throw new Error("Choose held, no-show or cancelled.");
      const ctx = await authorize(slug, "meeting.update");
      await ctx.db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
      await setMeetingStatus(ctx, meetingId, status);
    },
    { revalidate: [`/c/${slug}/meetings`, `/c/${slug}/leads`] },
  );
}
