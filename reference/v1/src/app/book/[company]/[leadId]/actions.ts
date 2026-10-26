"use server";

// Public booking. No sign-in, so nothing from the client is trusted beyond the lead id and the chosen
// slot: the company, the lead, its status and the slot list are all re-checked here.

import { act, str, type ActionResult } from "@/server/action";
import { unscopedDb, scopedDb } from "@/lib/db";
import { effectiveStatus } from "@/server/leads";
import { bookMeeting } from "@/server/meetings";
import { bookingSlots } from "./slots";

const INACTIVE = "This link is no longer active.";

export async function bookSlotAction(slug: string, leadId: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const company = await unscopedDb.company.findUnique({ where: { slug: String(slug) }, select: { id: true } });
      if (!company) throw new Error(INACTIVE);
      const db = scopedDb(company.id);
      const lead = await db.lead.findUnique({ where: { id: String(leadId) }, select: { id: true, status: true, overrideStatus: true } });
      if (!lead || effectiveStatus(lead) !== "VALIDATED") throw new Error(INACTIVE);

      const now = new Date();
      const upcoming = await db.meeting.findFirst({ where: { leadId: lead.id, status: "BOOKED", scheduledAt: { gt: now } }, select: { id: true } });
      if (upcoming) throw new Error("You already have a time booked.");

      const slot = str(fd, "slot");
      const offered = bookingSlots(now).some((d) => d.slots.some((s) => s.iso === slot));
      if (!offered) throw new Error("That time is no longer available. Pick another.");

      // Rebooking after a missed call keeps the same meeting type so the old one is marked rebooked.
      const missed = await db.meeting.findFirst({ where: { leadId: lead.id, status: "NO_SHOW" }, orderBy: { scheduledAt: "desc" }, select: { type: true } });
      return bookMeeting(db, company.id, lead.id, new Date(slot), missed?.type ?? "DISCOVERY");
    },
    { revalidate: `/book/${slug}/${leadId}` },
  );
}
