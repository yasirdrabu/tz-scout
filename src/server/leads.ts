// Module 5: lead intake and the validation agent.

import { z } from "zod";
import { Prisma, type LeadStatus } from "@prisma/client";
import type { ScopedDb } from "@/lib/db";
import { unscopedDb } from "@/lib/db";
import type { CompanyContext } from "./context";
import { adapters } from "@/integrations";
import { runAi } from "@/ai/run";
import { leadResearchTask } from "@/ai/leadResearch";
import { checkIndustry, checkNotExisting, checkRange, checkRole, checkTimeline, checkWorkEmail, decide, emailDomain, TIMELINE_OPTIONS, type CheckOutcome } from "@/lib/leadChecks";
import { money, num } from "@/lib/format";
import { enqueue, QUEUES } from "@/jobs/queue";
import { getSettings } from "./settings";
import { startShowUpSequence } from "./meetings";
import { audit } from "./audit";

export const FormSubmissionInput = z.object({
  email: z.string().trim().email(),
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().default(""),
  title: z.string().trim().optional().nullable(),
  company: z.string().trim().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  smsConsent: z.boolean().default(false),
  timeline: z.string().trim().optional().nullable(),
  offering: z.string().trim().optional().nullable(), // offering slug
  answers: z.record(z.string(), z.unknown()).optional(),
});
export type FormSubmissionT = z.infer<typeof FormSubmissionInput>;

/** Store the raw submission, create the lead, and queue validation. */
export async function ingestSubmission(db: ScopedDb, companyId: string, payload: unknown, source: "webhook" | "hubspot" | "manual") {
  const sub = await db.formSubmission.create({ data: { companyId, source, payload: (payload ?? {}) as Prisma.InputJsonValue } });
  const f = FormSubmissionInput.parse(payload);
  const offering = f.offering ? await db.offering.findFirst({ where: { slug: f.offering } }) : null;
  const domain = emailDomain(f.email);
  const lead = await db.lead.create({
    data: {
      companyId,
      offeringId: offering?.id ?? null,
      email: f.email.toLowerCase(),
      firstName: f.firstName,
      lastName: f.lastName,
      title: f.title ?? null,
      companyName: f.company ?? null,
      domain,
      phone: f.phone ?? null,
      smsConsent: f.smsConsent,
      timelineAnswer: f.timeline ?? null,
      formAnswers: (f.answers ?? {}) as Prisma.InputJsonValue,
    },
  });
  await db.formSubmission.update({ where: { id: sub.id }, data: { leadId: lead.id } });
  await enqueue(QUEUES.leadValidate, { companyId, leadId: lead.id }, { singletonKey: `lead:${lead.id}` });
  return lead.id;
}

const revenueFmt = (cents: number) => money(cents, "USD", { compact: true });

/** The validation agent. Runs as a background job; every decision is explainable from stored checks. */
export async function validateLead(db: ScopedDb, companyId: string, leadId: string) {
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { offering: true } });
  if (lead.status !== "NEW" && lead.status !== "VALIDATING") return;
  await db.lead.update({ where: { id: leadId }, data: { status: "VALIDATING" } });
  const a = adapters(db, companyId);
  const domain = lead.domain ?? emailDomain(lead.email);
  const o = lead.offering;

  const [resolves, profile, crm, website] = await Promise.all([
    a.companyData.domainResolves(domain).catch(() => null),
    a.companyData.lookup(domain).catch(() => null),
    a.hubspot.lookupExisting(domain, lead.email).catch(() => null),
    a.companyData.websiteText(domain).catch(() => null),
  ]);

  // Claude reads the website and writes the note; it can also fill a missing industry.
  let note: string | null = null;
  let aiIndustry: string | null = null;
  try {
    const { output } = await runAi(db, companyId, leadResearchTask, {
      lead: { name: `${lead.firstName} ${lead.lastName}`.trim(), title: lead.title, email: lead.email, companyName: lead.companyName, timeline: TIMELINE_OPTIONS.find((t) => t.value === lead.timelineAnswer)?.label ?? lead.timelineAnswer },
      profile: { name: profile?.name ?? null, employees: profile?.employees ?? null, revenue: profile?.revenueCents ? revenueFmt(profile.revenueCents) : null, industry: profile?.industry ?? null, hq: profile?.hq ?? null },
      website,
      offering: o ? { name: o.name, promise: o.promise } : null,
    });
    note = output.note;
    aiIndustry = output.industry;
  } catch {
    note = null;
  }

  const industry = profile?.industry ?? aiIndustry;
  const checks: CheckOutcome[] = [
    checkWorkEmail(lead.email, resolves),
    checkRange("company_size", profile?.employees, o?.companySizeMin, o?.companySizeMax, (n) => `${num(n)} employees`),
    checkRange("revenue", profile?.revenueCents, o?.revenueMinCents != null ? Number(o.revenueMinCents) : null, o?.revenueMaxCents != null ? Number(o.revenueMaxCents) : null, revenueFmt),
    checkIndustry(industry, domain, o?.industries ?? [], o?.excludedCategories ?? [], o?.excludedDomains ?? []),
    checkRole(lead.title, o?.targetTitles ?? []),
    checkTimeline(lead.timelineAnswer, o?.timelineWindowDays ?? 180),
    checkNotExisting(crm),
  ];
  if (!o) checks.push({ check: "industry", result: "UNKNOWN", reason: "No offering on the form, so targets are unknown." });

  for (const c of checks) {
    await db.leadCheck.upsert({
      where: { leadId_check: { leadId, check: c.check } },
      create: { companyId, leadId, check: c.check, result: c.result, reason: c.reason, evidence: (c.evidence ?? Prisma.JsonNull) as Prisma.InputJsonValue },
      update: { result: c.result, reason: c.reason, evidence: (c.evidence ?? Prisma.JsonNull) as Prisma.InputJsonValue },
    });
  }
  const stored = await db.leadCheck.findMany({ where: { leadId } });
  const decision = decide(stored);

  // Round robin among sales members.
  const owner = await nextOwner(db, companyId);

  const contact = await a.hubspot.upsertContact({ email: lead.email, firstName: lead.firstName, lastName: lead.lastName, title: lead.title, companyName: lead.companyName ?? profile?.name, domain }).catch(() => null);
  if (contact) {
    await a.hubspot.writeValidation(contact.contactId, {
      leadStatus: decision.status,
      researchNote: note,
      checks: Object.fromEntries(stored.map((c) => [c.check, { result: c.result, reason: c.reason }])),
      ownerEmail: owner?.email ?? null,
      reason: decision.reason,
    }).catch(() => {});
  }

  await db.lead.update({
    where: { id: leadId },
    data: {
      status: decision.status,
      decisionReason: decision.reason,
      researchNote: note,
      companyName: lead.companyName ?? profile?.name ?? null,
      ownerUserId: owner?.id ?? null,
      hubspotContactId: contact?.contactId ?? null,
      validatedAt: new Date(),
    },
  });
  await audit(db, companyId, { action: "lead.validated", entity: "lead", entityId: leadId, data: { status: decision.status, reason: decision.reason } });
  if (decision.status === "VALIDATED") await startShowUpSequence(db, companyId, leadId);
}

async function nextOwner(db: ScopedDb, companyId: string) {
  const sales = await unscopedDb.membership.findMany({ where: { companyId, role: "SALES" }, include: { user: true }, orderBy: { createdAt: "asc" } });
  if (sales.length === 0) return null;
  const settings = await getSettings(db);
  const pick = sales[settings.roundRobinIndex % sales.length]!;
  await db.settings.update({ where: { id: settings.id }, data: { roundRobinIndex: settings.roundRobinIndex + 1 } });
  return pick.user;
}

/** Human override. Logged with the reason; overriding to validated starts the show-up sequence. */
export async function overrideLead(ctx: CompanyContext, leadId: string, status: LeadStatus, reason: string) {
  const { db, company, user } = ctx;
  if (!reason.trim()) throw new Error("Give a reason for the override.");
  if (!["VALIDATED", "NOT_QUALIFIED"].includes(status)) throw new Error("Override to validated or not qualified.");
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
  await db.lead.update({ where: { id: leadId }, data: { overrideStatus: status, overrideReason: reason.trim(), overrideById: user.id, overrideAt: new Date() } });
  await audit(db, company.id, { userId: user.id, action: "lead.override", entity: "lead", entityId: leadId, data: { from: lead.overrideStatus ?? lead.status, to: status, reason } });
  const a = adapters(db, company.id);
  if (lead.hubspotContactId) {
    await a.hubspot.writeValidation(lead.hubspotContactId, { leadStatus: status as "VALIDATED" | "NOT_QUALIFIED", researchNote: lead.researchNote, checks: {}, ownerEmail: null, reason: `Override by ${user.name}: ${reason}` }).catch(() => {});
  }
  if (status === "VALIDATED") await startShowUpSequence(db, company.id, leadId);
  // Not qualified: nothing scheduled for this lead should go out.
  else await db.meetingTouch.updateMany({ where: { leadId, status: "SCHEDULED", kind: "booking_link" }, data: { status: "SKIPPED" } });
}

export async function revalidate(ctx: CompanyContext, leadId: string) {
  await ctx.db.lead.update({ where: { id: leadId }, data: { status: "NEW" } });
  await enqueue(QUEUES.leadValidate, { companyId: ctx.company.id, leadId });
}

export const effectiveStatus = (l: { status: LeadStatus; overrideStatus: LeadStatus | null }) => l.overrideStatus ?? l.status;

/** Sample people for the "simulate a form fill" tool. Each exercises a different path. */
export const SAMPLE_SUBMISSIONS: (FormSubmissionT & { label: string })[] = [
  { label: "Good fit, real estate COO", email: "dana.reyes@keystone-ridge-properties.com", firstName: "Dana", lastName: "Reyes", title: "Chief Operating Officer", company: "Keystone Ridge Properties", timeline: "3m", offering: "ai-opportunity-map", smsConsent: true },
  { label: "Good fit, healthcare CIO", email: "sam.patel@cedarline-health.com", firstName: "Sam", lastName: "Patel", title: "CIO", company: "Cedarline Health Partners", timeline: "now", offering: "agentready-diagnostic", smsConsent: false },
  { label: "Good fit, carrier on Access", email: "lee.okafor@northgate-freight.com", firstName: "Lee", lastName: "Okafor", title: "VP Operations", company: "Northgate Freight", timeline: "3m", offering: "modernization-blueprint", smsConsent: true },
  { label: "Free email address", email: "jordan.m.1984@gmail.com", firstName: "Jordan", lastName: "Miles", title: "Director of Operations", company: "Self", timeline: "3m", offering: "ai-opportunity-map", smsConsent: false },
  { label: "Too small", email: "kim@tinyshop-studio.com", firstName: "Kim", lastName: "Tran", title: "Owner", company: "Tinyshop Studio", timeline: "now", offering: "ai-opportunity-map", smsConsent: false },
  { label: "Excluded industry", email: "alex@orbit-casino-games.com", firstName: "Alex", lastName: "Brook", title: "COO", company: "Orbit Casino Games", timeline: "3m", offering: "ai-opportunity-map", smsConsent: false },
  { label: "Existing customer", email: "pat.lin@harborpoint-logistics.com", firstName: "Pat", lastName: "Lin", title: "VP Operations", company: "Harborpoint Logistics", timeline: "now", offering: "modernization-blueprint", smsConsent: false },
  { label: "Unknown firmographics (review)", email: "morgan@quietwater-partners.com", firstName: "Morgan", lastName: "Hale", title: "Managing Partner", company: "Quietwater Partners", timeline: "6m", offering: "ai-opportunity-map", smsConsent: false },
  { label: "Just researching", email: "chris.diaz@brightwater-residential.com", firstName: "Chris", lastName: "Diaz", title: "VP of Operations", company: "Brightwater Residential", timeline: "research", offering: "ai-opportunity-map", smsConsent: false },
];
