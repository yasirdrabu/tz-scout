"use server";

import { randomBytes } from "node:crypto";
import { authorize } from "@/server/context";
import { act, bool, optStr, str, type ActionResult } from "@/server/action";
import { FormSubmissionInput, ingestSubmission, overrideLead, revalidate } from "@/server/leads";
import { bookMeeting } from "@/server/meetings";
import { audit } from "@/server/audit";

const paths = (slug: string) => [`/c/${slug}/leads`, `/c/${slug}/meetings`];

/** Simulate a form fill. Queues the validation agent exactly like the webhook does. */
export async function simulateSubmissionAction(slug: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "lead.simulate");
      const parsed = FormSubmissionInput.parse({
        email: str(fd, "email"),
        firstName: str(fd, "firstName"),
        lastName: str(fd, "lastName"),
        title: optStr(fd, "title"),
        company: optStr(fd, "company"),
        phone: optStr(fd, "phone"),
        smsConsent: bool(fd, "smsConsent"),
        timeline: optStr(fd, "timeline"),
        offering: optStr(fd, "offering"),
      });
      if (parsed.offering && !(await ctx.db.offering.findFirst({ where: { slug: parsed.offering }, select: { id: true } }))) throw new Error("Choose an offering from the list.");
      // Let the same sample run again: tag the address only when it is already taken.
      let email = parsed.email.toLowerCase();
      if (await ctx.db.lead.findFirst({ where: { email }, select: { id: true } })) {
        const [local, domain] = email.split("@") as [string, string];
        email = `${local.split("+")[0]}+${randomBytes(2).toString("hex")}@${domain}`;
      }
      return ingestSubmission(ctx.db, ctx.company.id, { ...parsed, email }, "manual");
    },
    { revalidate: paths(slug), message: "Submitted. The agent is checking it now." },
  );
}

export async function overrideLeadAction(slug: string, leadId: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "lead.override");
      const status = str(fd, "status");
      if (status !== "VALIDATED" && status !== "NOT_QUALIFIED") throw new Error("Choose Validated or Not qualified.");
      const reason = str(fd, "reason");
      if (!reason) throw new Error("Give a reason for the override.");
      await overrideLead(ctx, leadId, status, reason);
    },
    { revalidate: paths(slug), message: "Override saved." },
  );
}

export async function revalidateLeadAction(slug: string, leadId: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "lead.simulate");
      await ctx.db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { id: true } });
      await revalidate(ctx, leadId);
      await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "lead.recheck", entity: "lead", entityId: leadId });
    },
    { revalidate: paths(slug) },
  );
}

export async function bookMeetingAction(slug: string, leadId: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "meeting.update");
      const at = new Date(str(fd, "scheduledAt"));
      if (Number.isNaN(at.getTime())) throw new Error("Pick a date and time.");
      const type = str(fd, "type") === "SALES" ? "SALES" : "DISCOVERY";
      await ctx.db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { id: true } });
      return bookMeeting(ctx.db, ctx.company.id, leadId, at, type);
    },
    { revalidate: paths(slug), message: "Booked. Confirmation and reminders are scheduled." },
  );
}
