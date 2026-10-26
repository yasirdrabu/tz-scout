// Module 6: the show-up agent. Booking link after validation, confirmation and reminders on booking,
// a pre-call note with a matched case study, and a rebook sequence on no-show.

import type { MeetingStatus, MeetingType } from "@prisma/client";
import type { ScopedDb } from "@/lib/db";
import { scopedDb, unscopedDb } from "@/lib/db";
import type { CompanyContext } from "./context";
import { adapters } from "@/integrations";
import { dateTime } from "@/lib/format";
import { getSettings } from "./settings";
import { matchesIndustry } from "./offerings";
import { audit } from "./audit";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

type TouchDraft = { kind: string; channel: "EMAIL" | "SMS"; dueAt: Date; subject?: string; body: string };

async function leadWithContext(db: ScopedDb, leadId: string) {
  return db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { offering: { include: { caseStudies: { include: { caseStudy: true } } } }, checks: true, company: true } });
}

/** First touch with a booking link. Outbound leads pass their own subject and opener. */
export async function startShowUpSequence(db: ScopedDb, companyId: string, leadId: string, now = new Date(), opts: { subject?: string; opener?: string } = {}) {
  const lead = await leadWithContext(db, leadId);
  const already = await db.meetingTouch.count({ where: { leadId, kind: "booking_link" } });
  if (already) return;
  const settings = await getSettings(db);
  const owner = lead.ownerUserId ? await unscopedDb.user.findUnique({ where: { id: lead.ownerUserId } }) : null;
  const link = await adapters(db, companyId).booking.bookingLink({ leadId, ownerEmail: owner?.email ?? null, companySlug: lead.company.slug });
  await db.meetingTouch.create({
    data: {
      companyId,
      leadId,
      kind: "booking_link",
      channel: "EMAIL",
      dueAt: new Date(now.getTime() + settings.sequence.bookingLinkDelayMinutes * 60_000),
      subject: opts.subject ?? `${lead.firstName}, pick a time to talk`,
      body: opts.opener
        ? `${opts.opener}\n\nIf it's useful, here are 30 minute slots: ${link}\n\n${owner?.name ?? "The team"}`
        : `Hi ${lead.firstName},\n\nThanks for reaching out about ${lead.offering?.name ?? "working together"}. Pick a 30 minute slot that suits you: ${link}\n\n${owner?.name ?? "The team"}`,
    },
  });
}

/** Book (or rebook) a meeting and schedule confirmation, reminders and the pre-call note. */
export async function bookMeeting(db: ScopedDb, companyId: string, leadId: string, scheduledAt: Date, type: MeetingType = "DISCOVERY", now = new Date()) {
  const lead = await leadWithContext(db, leadId);
  const settings = await getSettings(db);

  // A new booking after a no-show marks the old meeting rebooked and ends its rebook sequence.
  const prior = await db.meeting.findFirst({ where: { leadId, type, status: "NO_SHOW" }, orderBy: { scheduledAt: "desc" } });
  if (prior) {
    await db.meeting.update({ where: { id: prior.id }, data: { status: "REBOOKED" } });
    await db.meetingTouch.updateMany({ where: { meetingId: prior.id, status: "SCHEDULED" }, data: { status: "SKIPPED" } });
  }
  await db.meetingTouch.updateMany({ where: { leadId, kind: "booking_link", status: "SCHEDULED" }, data: { status: "SKIPPED" } });

  const industry = (lead.checks.find((c) => c.check === "industry")?.evidence as { industry?: string } | null)?.industry ?? null;
  const cases = lead.offering?.caseStudies.map((c) => c.caseStudy) ?? [];
  const caseStudy = cases.find((c) => matchesIndustry(c.industry, industry)) ?? cases[0] ?? null;

  const a = adapters(db, companyId);
  const hs = lead.hubspotContactId ? await a.hubspot.logMeeting(lead.hubspotContactId, { type, status: "BOOKED", scheduledAt }).catch(() => null) : null;
  const meeting = await db.meeting.create({
    data: { companyId, leadId, type, status: "BOOKED", scheduledAt, bookedAt: now, caseStudyId: caseStudy?.id ?? null, hubspotMeetingId: hs?.meetingId ?? null, rebookOfId: prior?.id ?? null },
  });

  const when = dateTime(scheduledAt);
  const label = type === "DISCOVERY" ? "discovery call" : "call";
  const touches: TouchDraft[] = [{ kind: "confirmation", channel: "EMAIL", dueAt: now, subject: `Confirmed: ${label} on ${when}`, body: `Hi ${lead.firstName}, you're booked for ${when}. A calendar invite is on its way.` }];
  for (const h of settings.sequence.reminderHours) {
    const dueAt = new Date(scheduledAt.getTime() - h * HOUR);
    if (dueAt <= now) continue;
    const kind = `reminder_${h}h`;
    touches.push({ kind, channel: "EMAIL", dueAt, subject: `Reminder: ${label} ${h >= 24 ? "tomorrow" : `in ${h} hour${h === 1 ? "" : "s"}`}`, body: `Hi ${lead.firstName}, a reminder about our ${label} at ${when}.` });
    if (settings.sequence.smsReminders && lead.smsConsent && lead.phone) touches.push({ kind, channel: "SMS", dueAt, body: `Reminder: ${label} at ${when}. Reply C to reschedule.` });
  }
  if (caseStudy) {
    const dueAt = new Date(Math.max(now.getTime(), scheduledAt.getTime() - 24 * HOUR));
    touches.push({ kind: "precall_note", channel: "EMAIL", dueAt, subject: `Before we talk: how ${caseStudy.client} did it`, body: `Hi ${lead.firstName}, ahead of our ${label}, here is a short story from a company like yours: ${caseStudy.title}. ${caseStudy.result}${caseStudy.link ? ` ${caseStudy.link}` : ""}` });
  }
  await db.meetingTouch.createMany({ data: touches.map((t) => ({ ...t, companyId, leadId, meetingId: meeting.id, subject: t.subject ?? null })) });
  await audit(db, companyId, { action: "meeting.booked", entity: "meeting", entityId: meeting.id, data: { type, scheduledAt } });
  return meeting.id;
}

export async function setMeetingStatus(ctx: Pick<CompanyContext, "db" | "company"> & { user?: { id: string } }, meetingId: string, status: MeetingStatus, now = new Date()) {
  const { db, company } = ctx;
  const m = await db.meeting.findUniqueOrThrow({ where: { id: meetingId }, include: { lead: true } });
  if (m.status === status) return;
  if (status === "REBOOKED") throw new Error("Rebooked is set automatically when a new time is booked.");
  const settings = await getSettings(db);
  await db.meeting.update({ where: { id: meetingId }, data: { status, heldAt: status === "HELD" ? now : null } });
  // Pending reminders no longer apply once the meeting resolves.
  if (status !== "BOOKED") await db.meetingTouch.updateMany({ where: { meetingId, status: "SCHEDULED", kind: { not: { startsWith: "rebook" } } }, data: { status: "SKIPPED" } });
  // Correcting a no-show to another outcome withdraws its pending rebook notes.
  if (m.status === "NO_SHOW") await db.meetingTouch.updateMany({ where: { meetingId, status: "SCHEDULED", kind: { startsWith: "rebook" } }, data: { status: "SKIPPED" } });
  // No rebook notes if the lead already has another call on the calendar.
  const alreadyBooked = status === "NO_SHOW" && (await db.meeting.count({ where: { leadId: m.leadId, id: { not: meetingId }, status: "BOOKED", scheduledAt: { gt: now } } })) > 0;
  if (status === "NO_SHOW" && !alreadyBooked) {
    const link = await adapters(db, company.id).booking.bookingLink({ leadId: m.leadId, ownerEmail: null, companySlug: (await db.company.findFirstOrThrow()).slug });
    await db.meetingTouch.createMany({
      data: settings.sequence.rebookDays.map((d, i) => ({
        companyId: company.id,
        leadId: m.leadId,
        meetingId,
        kind: `rebook_${i + 1}`,
        channel: "EMAIL" as const,
        dueAt: new Date(now.getTime() + d * DAY),
        subject: i === 0 ? "Sorry we missed you" : i === 1 ? "Still want to talk?" : "Last note from me",
        body: i === 0 ? `Hi ${m.lead.firstName}, looks like today didn't work. Grab another time here: ${link}` : i === 1 ? `Hi ${m.lead.firstName}, happy to find a time that works better: ${link}` : `Hi ${m.lead.firstName}, I'll close the loop for now. If timing changes, here's my calendar: ${link}`,
      })),
    });
  }
  const a = adapters(db, company.id);
  if (m.lead.hubspotContactId) await a.hubspot.logMeeting(m.lead.hubspotContactId, { type: m.type, status, scheduledAt: m.scheduledAt }).catch(() => {});
  await audit(db, company.id, { userId: ctx.user?.id, action: `meeting.${status.toLowerCase()}`, entity: "meeting", entityId: meetingId });
}

/** Send every due touch across companies. Runs every minute. */
export async function sendDueTouches(now = new Date()) {
  const due = await unscopedDb.meetingTouch.findMany({ where: { status: "SCHEDULED", dueAt: { lte: now } }, include: { lead: true }, take: 200, orderBy: { dueAt: "asc" } });
  let sent = 0;
  for (const t of due) {
    const db = scopedDb(t.companyId);
    const to = t.channel === "SMS" ? t.lead.phone : t.lead.email;
    if (!to) {
      await db.meetingTouch.update({ where: { id: t.id }, data: { status: "SKIPPED" } });
      continue;
    }
    try {
      await adapters(db, t.companyId).messaging.send({ channel: t.channel, to, subject: t.subject, body: t.body });
      await db.meetingTouch.update({ where: { id: t.id }, data: { status: "SENT", sentAt: new Date() } });
      sent++;
    } catch (e) {
      console.error("[touches]", (e as Error).message);
    }
  }
  return sent;
}

/** Show-up rate by week (Monday start) for a meeting type. Feeds the funnel and scorecard. */
export async function showUpByWeek(db: ScopedDb, type: MeetingType, from: Date, to: Date) {
  const ms = await db.meeting.findMany({ where: { type, scheduledAt: { gte: from, lt: to }, status: { in: ["HELD", "NO_SHOW", "REBOOKED"] } }, select: { scheduledAt: true, status: true } });
  const weeks = new Map<string, { booked: number; held: number }>();
  for (const m of ms) {
    const d = new Date(m.scheduledAt);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
    const k = monday.toISOString().slice(0, 10);
    const w = weeks.get(k) ?? { booked: 0, held: 0 };
    w.booked++;
    if (m.status === "HELD") w.held++;
    weeks.set(k, w);
  }
  return [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({ week, ...v, rate: v.booked ? v.held / v.booked : null }));
}
