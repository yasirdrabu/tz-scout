// The team and HubSpot side of Buyers: who follows up (sellers are HubSpot owners), what HubSpot
// already knows about each account, and pushing an account with all of its context.
// Reps don't log in here. Zach assigns; reps work the account in HubSpot.

import type { ScopedDb } from "@/lib/db";
import type { CompanyContext } from "./context";
import { adapters } from "@/integrations";
import type { FollowThrough } from "@/integrations/hubspot";
import { Prisma } from "@prisma/client";
import { buildHubSpotContext, type ContextMatch } from "@/lib/hubspotContext";
import { buyerSettings, generateSequence, rulesFor, type MatchReasons } from "./buyers";
import { decideOwnership } from "@/lib/ownership";
import type { SequenceStep } from "@/ai/outreachSequence";
import { SIGNAL_KIND } from "@/lib/matching";
import { audit } from "./audit";
import { handoffMessages, type HandoffMessage } from "@/lib/handoff";
import type { ResearchEntry } from "@/lib/research";

// ---------- Team ----------

export async function listSellers(db: ScopedDb, opts: { teamOnly?: boolean } = {}) {
  return db.seller.findMany({ where: opts.teamOnly ? { onTeam: true } : {}, orderBy: [{ onTeam: "desc" }, { name: "asc" }] });
}

/** Add or refresh HubSpot owners on the roster. Existing onTeam choices are kept. */
export async function upsertSellers(db: ScopedDb, companyId: string, owners: { id: string; name: string; email?: string | null; active: boolean }[], team: string[] = []) {
  for (const o of owners) {
    if (!o.name.trim()) continue;
    await db.seller.upsert({
      where: { companyId_hubspotOwnerId: { companyId, hubspotOwnerId: o.id } },
      create: { companyId, hubspotOwnerId: o.id, name: o.name.trim(), email: o.email ?? null, active: o.active, onTeam: team.includes(o.id) },
      update: { name: o.name.trim(), active: o.active, ...(o.email ? { email: o.email } : {}), ...(team.includes(o.id) ? { onTeam: true } : {}) },
    });
  }
}

/** Pull the owner list from HubSpot. Needs the owners read permission on the private app. */
export async function syncSellers(ctx: CompanyContext) {
  const owners = await adapters(ctx.db, ctx.company.id).hubspot.listOwners();
  await upsertSellers(ctx.db, ctx.company.id, owners);
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "team.sync", entity: "seller", data: { owners: owners.length } });
  return owners.length;
}

export async function setOnTeam(ctx: CompanyContext, sellerId: string, onTeam: boolean) {
  await ctx.db.seller.update({ where: { id: sellerId }, data: { onTeam } });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: onTeam ? "team.add" : "team.remove", entity: "seller", entityId: sellerId });
}

// ---------- Assigning ----------

/** Assign one or many accounts to a seller (or unassign with null). */
export async function assignSeller(ctx: CompanyContext, accountIds: string[], sellerId: string | null) {
  if (sellerId) {
    const s = await ctx.db.seller.findUnique({ where: { id: sellerId } });
    if (!s) throw new Error("That person isn't on the team roster.");
    if (!s.onTeam) throw new Error(`${s.name} isn't on the team yet. Add them in Settings, Team.`);
  }
  const { count } = await ctx.db.account.updateMany({ where: { id: { in: accountIds } }, data: { sellerId } });
  for (const id of accountIds) await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "account.assign", entity: "account", entityId: id, data: { sellerId, bulk: accountIds.length > 1 } });
  return count;
}

// ---------- What HubSpot already knows ----------

export type HubSpotState = "new" | "in_crm" | "open_deal" | "customer";
export const HUBSPOT_STATE_LABEL: Record<HubSpotState, string> = { new: "Not in HubSpot", in_crm: "In HubSpot", open_deal: "Open deal in HubSpot", customer: "Customer in HubSpot" };

/** Read-only: look every account up in HubSpot by domain and record what's there. */
export async function checkHubSpot(ctx: CompanyContext, accountIds?: string[]) {
  const hs = adapters(ctx.db, ctx.company.id).hubspot;
  const accounts = await ctx.db.account.findMany({ where: accountIds ? { id: { in: accountIds } } : {}, select: { id: true, domain: true } });
  const owners = new Map((await ctx.db.seller.findMany()).map((s) => [s.hubspotOwnerId, s.active ? s.name : `${s.name} (no longer active)`]));
  const tally: Record<HubSpotState, number> = { new: 0, in_crm: 0, open_deal: 0, customer: 0 };
  for (const a of accounts) {
    const c = await hs.findCompany(a.domain);
    const state: HubSpotState = !c ? "new" : c.lifecycle === "customer" ? "customer" : c.openDeals > 0 ? "open_deal" : "in_crm";
    tally[state]++;
    const note = c
      ? [c.ownerId ? `Owned by ${owners.get(c.ownerId) ?? `HubSpot owner ${c.ownerId}`}` : "No owner in HubSpot", c.lifecycle ? `stage: ${c.lifecycle}` : null, c.deals ? `${c.deals} deal${c.deals === 1 ? "" : "s"}${c.openDeals ? `, ${c.openDeals} open` : ""}` : null].filter(Boolean).join(", ")
      : null;
    await ctx.db.account.update({ where: { id: a.id }, data: { hubspotState: state, hubspotNote: note, hubspotOwnerId: c?.ownerId ?? null, hubspotCompanyId: c?.id ?? undefined, hubspotCheckedAt: new Date() } });
  }
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "hubspot.check", entity: "account", data: { accounts: accounts.length, ...tally } });
  return tally;
}

// ---------- Pushing ----------

export class OwnedElsewhereError extends Error {
  constructor(public owner: string, reason = "is owned by someone else") {
    super(`${owner} owns this in HubSpot and it ${reason}, so it wasn't reassigned. Push anyway to add the context and keep their ownership.`);
    this.name = "OwnedElsewhereError";
  }
}

// Every buyer we found goes to HubSpot; this only guards against an unusually large pull.
const MAX_CONTACTS = 10;

/**
 * Push one account to HubSpot with everything a rep needs: the company (owner and our fields),
 * a note with every signal and why it matters, the buyers we found with emails and phones, and a
 * task for the owner. Safe to repeat: it updates the same company, note, contacts and task.
 */
export async function pushToHubSpot(ctx: CompanyContext, accountId: string, opts: { allowOtherOwner?: boolean; properties?: Set<string>; batchId?: string | null } = {}) {
  const hs = adapters(ctx.db, ctx.company.id).hubspot;
  const a = await ctx.db.account.findUniqueOrThrow({
    where: { id: accountId },
    include: { seller: true, contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] }, signals: { orderBy: { occurredAt: "desc" } }, matches: { include: { offering: { include: { caseStudies: { include: { caseStudy: true } } } } } } },
  });
  if (!a.seller) throw new Error("Assign an owner before pushing, so HubSpot knows who follows up.");
  const ownerId = a.seller.hubspotOwnerId;

  // Someone else already owns it in HubSpot (and we didn't set that): don't step on them by accident.
  // Assigning and pushing takes the account over, unless someone is actually working it (an open
  // deal or a customer). See src/lib/ownership.ts.
  const existing = await hs.findCompany(a.domain);
  const current = existing?.ownerId ? await ctx.db.seller.findFirst({ where: { hubspotOwnerId: existing.ownerId } }) : null;
  const { takeOverOwnership } = await buyerSettings(ctx.db);
  const decision = decideOwnership({ existing, ownerId, pushedOwnerId: a.pushedOwnerId, currentOwnerActive: current ? current.active : null, takeOver: takeOverOwnership, allowOtherOwner: !!opts.allowOtherOwner });
  if (decision.action === "stop") throw new OwnedElsewhereError(current?.name ?? `HubSpot owner ${existing?.ownerId}`, decision.reason);
  const replaceable = decision.action === "assign" ? decision.replaceOwnerId : null;
  const takenFrom = decision.action === "assign" && decision.takenFrom ? (current?.name ?? `HubSpot owner ${decision.takenFrom}`) : null;

  const sorted = [...a.matches].sort((x, y) => y.total - x.total);
  const toMatch = (m: (typeof sorted)[number]): ContextMatch => {
    const r = m.reasons as unknown as MatchReasons;
    return { offering: m.offering.name, tier: m.tier, fit: m.fit, signal: m.signal, total: m.total, hits: r?.signals ?? [], fitParts: r?.fit ?? [], whyNow: m.whyNow, angle: m.angle, opener: m.opener, contactTitle: m.contactTitle };
  };
  const bestRow = sorted.find((m) => m.offeringId === a.bestOfferingId) ?? null;
  const best = bestRow ? toMatch(bestRow) : null;
  const others = sorted.filter((m) => m !== bestRow && m.tier !== "not_fit").slice(0, 3).map(toMatch);
  const contacts = a.contacts.slice(0, MAX_CONTACTS);
  // The offer behind the best match, and the signals that would strengthen it.
  const o = bestRow?.offering ?? null;
  const offer = o
    ? { name: o.name, promise: o.promise || null, priceMinCents: o.priceMinCents, priceMaxCents: o.priceMaxCents, salesCycleDays: o.salesCycleDays, targetTitles: o.targetTitles, proofPoints: o.proofPoints, caseStudies: o.caseStudies.map((x) => ({ title: x.caseStudy.title, client: x.caseStudy.client, result: x.caseStudy.result, link: x.caseStudy.link })) }
    : null;
  const fired = new Set((best?.hits ?? []).map((h) => h.ruleId));
  const missing = o ? rulesFor(o).filter((r) => !fired.has(r.id) && SIGNAL_KIND[r.type] !== "pain").map((r) => ({ label: r.label, weight: r.weight, why: r.why })) : [];
  // The follow-up emails, signed by whoever owns the account now.
  const sequence: SequenceStep[] = bestRow ? ((await generateSequence(ctx.db, ctx.company.id, a.id, bestRow.offeringId).catch(() => null)) ?? (bestRow.sequence as SequenceStep[] | null) ?? []) : [];
  const briefRun = bestRow?.aiRunId ? await ctx.db.aiRun.findUnique({ where: { id: bestRow.aiRunId }, select: { model: true } }) : null;
  const briefBy = bestRow?.briefedAt ? (briefRun?.model === "mock" ? "Brief assembled from the signals by rules (Claude not connected yet)." : "Brief written by Claude from the signals and the offer.") : null;
  const appUrl = process.env.APP_PUBLIC_URL ? `${process.env.APP_PUBLIC_URL.replace(/\/$/, "")}/c/${ctx.company.slug}/buyers/${a.id}` : null;
  const context = buildHubSpotContext({
    account: { name: a.name, domain: a.domain, industry: a.industry, employeesRange: a.employeesRange, revenueRange: a.revenueRange, location: [a.city, a.state].filter(Boolean).join(", ") || null, description: a.description, technologies: a.technologies, source: a.source, dataAsOf: a.enrichedAt },
    best,
    others,
    signals: a.signals.map((s) => ({ id: s.id, type: s.type, title: s.title, detail: s.detail, url: s.url, value: s.value, occurredAt: s.occurredAt })),
    contacts: contacts.map((c) => ({ name: [c.firstName, c.lastName].filter(Boolean).join(" "), title: c.title, email: c.email, emailStatus: c.emailStatus, phone: c.phone ?? c.mobilePhone, linkedinUrl: c.linkedinUrl, primary: c.isPrimary })),
    offer,
    missing,
    briefBy,
    sequence,
    tier: a.tier,
    research: await researchFor(ctx, a.buckets, a.research),
    owner: takenFrom ? `${a.seller.name} (reassigned from ${takenFrom})` : a.seller.name,
    appUrl,
  });

  const have = opts.properties ?? (await hs.existingProperties());
  const props = Object.fromEntries(Object.entries(context.props).filter(([k]) => have.has(k)));
  const company = await hs.upsertCompany({
    domain: a.domain,
    name: a.name,
    website: a.websiteUrl,
    city: a.city,
    state: a.state,
    country: a.country,
    employees: a.employees,
    description: a.description,
    ownerId,
    ourOwnerId: replaceable,
    props,
  });

  const contactIds: string[] = [];
  for (const c of contacts) {
    const { contactId } = await hs.pushContact({ hubspotContactId: c.hubspotContactId, email: c.email, firstName: c.firstName, lastName: c.lastName, title: c.title, phone: c.phone, mobilePhone: c.mobilePhone, linkedinUrl: c.linkedinUrl, ownerId, takeOverOwner: decision.action === "assign", companyId: company.companyId });
    contactIds.push(contactId);
    if (contactId !== c.hubspotContactId) await ctx.db.contact.update({ where: { id: c.id }, data: { hubspotContactId: contactId } });
  }

  const note = await hs.upsertNote({ noteId: a.hubspotNoteId, expectedHash: a.hubspotNoteHash, companyId: company.companyId, contactIds, html: context.html, ownerId });
  const noteId = note.noteId;
  const { taskId } = await hs.upsertTask({ taskId: a.hubspotTaskId, companyId: company.companyId, contactId: contactIds[0] ?? null, subject: context.taskSubject, body: context.taskBody, ownerId });
  // One dated task per follow-up email, so the rep sees what goes out when. Updated in place on re-push.
  const sequenceTaskIds: string[] = [];
  const buyerName = contacts[0] ? [contacts[0].firstName, contacts[0].lastName].filter(Boolean).join(" ") : null;
  for (const [i, step] of sequence.filter((s) => s.step > 1).entries()) {
    const due = new Date(Date.now() + step.day * 86400_000);
    const r = await hs.upsertTask({
      taskId: a.hubspotSequenceTaskIds[i] ?? null,
      companyId: company.companyId,
      contactId: contactIds[0] ?? null,
      subject: `Follow-up ${step.step} of ${sequence.length} (day ${step.day}): email ${buyerName ?? a.name}`,
      body: `${step.purpose}\n\nSubject: ${step.subject}\n\n${step.body}`,
      ownerId,
      dueAt: due,
    });
    sequenceTaskIds.push(r.taskId);
  }

  // Baseline for follow-through: what was already on the company before this handoff.
  const ft = await hs.followThrough(company.companyId, [taskId, ...sequenceTaskIds]).catch(() => null);
  const ownBatch = !a.batchId && !opts.batchId;
  const batchId = a.batchId ?? opts.batchId ?? (await newBatch(ctx, [{ name: a.name, seller: a.seller.name }])).id;
  await ctx.db.account.update({
    where: { id: a.id },
    data: { batchId, ...(a.batchId ? {} : ft ? { followUp: followUpFrom(ft, ft, new Date()) as unknown as Prisma.InputJsonValue, followUpAt: new Date() } : {}), hubspotCompanyId: company.companyId, hubspotOwnerId: company.ownerId, pushedOwnerId: company.ownerId === ownerId ? ownerId : a.pushedOwnerId, hubspotNoteId: noteId, hubspotNoteHash: note.bodyHash, hubspotTaskId: taskId, hubspotSequenceTaskIds: sequenceTaskIds, hubspotState: a.hubspotState && a.hubspotState !== "new" ? a.hubspotState : "in_crm", pushedAt: new Date(), status: a.status === "NEW" ? "WORKING" : a.status },
  });
  if (ownBatch) await writeHandoffMessages(ctx, batchId);
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "account.pushHubspot", entity: "account", entityId: a.id, data: { companyId: company.companyId, created: company.created, contacts: contactIds.length, noteId, noteKept: note.kept, takenFrom, taskId, owner: a.seller.name, ownerKept: company.ownerId !== ownerId } });
  return { companyId: company.companyId, created: company.created, contacts: contactIds.length, ownerKept: company.ownerId !== ownerId };
}

/** The account's imported research, strongest bucket first, with bucket names. */
async function researchFor(ctx: CompanyContext, slugs: string[], research: unknown) {
  if (!research || typeof research !== "object") return [];
  const names = new Map((await ctx.db.bucket.findMany({ select: { slug: true, name: true } })).map((b) => [b.slug, b.name]));
  return Object.entries(research as Record<string, ResearchEntry>)
    .map(([slug, entry]) => ({ bucket: names.get(slug) ?? (slug === "unfiled" ? "Research" : slug), entry, inBucket: slugs.includes(slug) }))
    .sort((x, y) => (y.entry.score ?? 0) - (x.entry.score ?? 0))
    .map(({ bucket, entry }) => ({ bucket, entry }));
}

/** Push many as one handoff batch. Accounts that can't be pushed are skipped and reported. */
export async function pushMany(ctx: CompanyContext, accountIds: string[]) {
  const properties = await adapters(ctx.db, ctx.company.id).hubspot.existingProperties();
  const out = { pushed: 0, created: 0, skipped: [] as { name: string; reason: string }[], batchId: null as string | null };
  const batch = await newBatch(ctx, []);
  for (const id of accountIds) {
    try {
      const r = await pushToHubSpot(ctx, id, { properties, batchId: batch.id });
      out.pushed++;
      if (r.created) out.created++;
    } catch (e) {
      const a = await ctx.db.account.findUnique({ where: { id }, select: { name: true } });
      out.skipped.push({ name: a?.name ?? id, reason: (e as Error).message });
    }
  }
  const members = await ctx.db.account.findMany({ where: { batchId: batch.id }, select: { name: true, seller: { select: { name: true } } } });
  if (!members.length) await ctx.db.handoffBatch.delete({ where: { id: batch.id } });
  else {
    await ctx.db.handoffBatch.update({ where: { id: batch.id }, data: { name: batchName(members.map((m) => ({ name: m.name, seller: m.seller?.name ?? "unassigned" }))) } });
    await writeHandoffMessages(ctx, batch.id);
    out.batchId = batch.id;
  }
  return out;
}

// ---------- Handoff batches and follow-through ----------

export type FollowUp = { tasksDone: number; tasksTotal: number; overdue: number; emails: number; calls: number; meetings: number; deals: number; openDeals: number; stage: string | null; lastActivityAt: string | null; ownerId: string | null; baseline: { emails: number; calls: number; meetings: number; deals: number } };

/** Follow-through since the handoff: counts above what was on the company when we pushed it. */
export function followUpFrom(now: FollowThrough, baseline: { emails: number; calls: number; meetings: number; deals: number }, at = new Date()): FollowUp {
  const open = now.tasks.filter((t) => t.status !== "COMPLETED");
  return {
    tasksDone: now.tasks.length - open.length,
    tasksTotal: now.tasks.length,
    overdue: open.filter((t) => t.dueAt && new Date(t.dueAt).getTime() < at.getTime()).length,
    emails: Math.max(0, now.emails - baseline.emails),
    calls: Math.max(0, now.calls - baseline.calls),
    meetings: Math.max(0, now.meetings - baseline.meetings),
    deals: Math.max(0, now.deals - baseline.deals),
    openDeals: now.openDeals,
    stage: now.stage,
    lastActivityAt: now.lastActivityAt,
    ownerId: now.ownerId,
    baseline: { emails: baseline.emails, calls: baseline.calls, meetings: baseline.meetings, deals: baseline.deals },
  };
}

/** "Oct 22 · 12 to Ashkan, 3 to Mike" */
export function batchName(members: { name: string; seller: string }[], at = new Date()): string {
  const day = at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (members.length === 1) return `${day} · ${members[0]!.name} to ${members[0]!.seller.split(" ")[0]}`;
  const by = [...members.reduce((m, x) => m.set(x.seller, (m.get(x.seller) ?? 0) + 1), new Map<string, number>())];
  return `${day} · ${by.map(([s, n]) => `${n} to ${s.split(" ")[0]}`).join(", ")}`;
}

/** One message per rep for a batch: their accounts, the offer and buyer for each, where to find them, the ask. */
export async function writeHandoffMessages(ctx: CompanyContext, batchId: string): Promise<HandoffMessage[]> {
  const batch = await ctx.db.handoffBatch.findUniqueOrThrow({
    where: { id: batchId },
    include: {
      accounts: {
        orderBy: [{ sellerId: "asc" }, { bestTotal: { sort: "desc", nulls: "last" } }],
        include: { seller: { select: { id: true, name: true } }, matches: { include: { offering: { select: { name: true } } } }, contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }], take: 1 } },
      },
    },
  });
  const portal = process.env.HUBSPOT_PORTAL_ID;
  const bucketName = new Map((await ctx.db.bucket.findMany({ select: { slug: true, name: true } })).map((b) => [b.slug, b.name]));
  const messages = handoffMessages({
    from: batch.createdBy ?? ctx.user.name,
    at: batch.createdAt,
    accounts: batch.accounts.map((a) => {
      const c = a.contacts[0];
      return {
        sellerId: a.seller?.id ?? null,
        seller: a.seller?.name ?? null,
        name: a.name,
        domain: a.domain,
        // Researched accounts without an approved offer in their bucket go out under the bucket name.
        offer: a.matches.find((m) => m.offeringId === a.bestOfferingId)?.offering.name ?? (a.buckets.map((b) => bucketName.get(b) ?? b).join(", ") || null),
        buyer: c ? { name: [c.firstName, c.lastName].filter(Boolean).join(" "), title: c.title, email: c.email } : null,
        hubspotUrl: portal && a.hubspotCompanyId ? `https://app.hubspot.com/contacts/${portal}/record/0-2/${a.hubspotCompanyId}` : null,
      };
    }),
  });
  await ctx.db.handoffBatch.update({ where: { id: batchId }, data: { messages: messages as unknown as Prisma.InputJsonValue } });
  return messages;
}

async function newBatch(ctx: CompanyContext, members: { name: string; seller: string }[]) {
  return ctx.db.handoffBatch.create({ data: { companyId: ctx.company.id, name: members.length ? batchName(members) : "Sending...", createdBy: ctx.user.name } });
}

/** Read-only: refresh follow-through from HubSpot for sent accounts (one batch, or all). */
export async function refreshFollowUp(ctx: CompanyContext, batchId?: string | null) {
  const hs = adapters(ctx.db, ctx.company.id).hubspot;
  const accounts = await ctx.db.account.findMany({ where: { batchId: batchId ?? { not: null }, hubspotCompanyId: { not: null } } });
  const at = new Date();
  for (const a of accounts) {
    const prev = a.followUp as FollowUp | null;
    const now = await hs.followThrough(a.hubspotCompanyId!, [a.hubspotTaskId, ...a.hubspotSequenceTaskIds].filter((x): x is string => !!x));
    const baseline = prev?.baseline ?? { emails: now.emails, calls: now.calls, meetings: now.meetings, deals: now.deals };
    await ctx.db.account.update({ where: { id: a.id }, data: { followUp: followUpFrom(now, baseline, at) as unknown as Prisma.InputJsonValue, followUpAt: at } });
  }
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "sent.refresh", entity: "handoffBatch", entityId: batchId ?? null, data: { accounts: accounts.length } });
  return accounts.length;
}

/** Take an account out of Sent and back into the queue (it stays in HubSpot as it is). */
export async function returnToQueue(ctx: CompanyContext, accountId: string) {
  await ctx.db.account.update({ where: { id: accountId }, data: { batchId: null } });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "account.returnToQueue", entity: "account", entityId: accountId });
}

/** Create our company fields in HubSpot. Changes HubSpot settings; run from Settings on purpose. */
export async function setUpHubSpotFields(ctx: CompanyContext) {
  const made = await adapters(ctx.db, ctx.company.id).hubspot.createProperties();
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "hubspot.createProperties", entity: "settings", data: { made } });
  return made;
}
