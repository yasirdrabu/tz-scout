// Calls: prep a discovery call from everything we know about the account, then review the call from
// a transcript or recap, score it against the checklist, and write it back to HubSpot.

import { Prisma } from "@prisma/client";
import type { ScopedDb } from "@/lib/db";
import type { CompanyContext } from "./context";
import { runAi } from "@/ai/run";
import { callPrepTask, type CallPrep } from "@/ai/callPrep";
import { callReviewTask, type CallReviewOutput } from "@/ai/callReview";
import { QUALIFICATION, QUAL_STATUS_LABEL, qualificationScore } from "@/lib/qualification";
import { money, relative } from "@/lib/format";
import { adapters } from "@/integrations";
import { audit } from "./audit";

const sizeOf = (a: { employeesRange: string | null; employees: number | null }) => (a.employeesRange ? `${a.employeesRange} employees` : a.employees ? `about ${a.employees} employees` : null);

/** Build (or rebuild) the discovery call plan for an account's best offer, or the given one. */
export async function prepareCall(db: ScopedDb, companyId: string, accountId: string, offeringId?: string | null, now = new Date()): Promise<CallPrep> {
  const a = await db.account.findUniqueOrThrow({ where: { id: accountId }, include: { signals: { orderBy: { occurredAt: "desc" } }, contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] } } });
  const oid = offeringId ?? a.bestOfferingId;
  if (!oid) throw new Error("No offering matches this account yet.");
  const match = await db.accountMatch.findUniqueOrThrow({ where: { accountId_offeringId: { accountId, offeringId: oid } }, include: { offering: { include: { caseStudies: { include: { caseStudy: true } } } } } });
  const o = match.offering;
  const buyer = a.contacts[0];
  const { output } = await runAi(db, companyId, callPrepTask, {
    account: { name: a.name, industry: a.industry, size: sizeOf(a), location: [a.city, a.state].filter(Boolean).join(", ") || null, description: a.description },
    buyer: buyer ? { name: `${buyer.firstName} ${buyer.lastName ?? ""}`.trim(), title: buyer.title } : null,
    signals: a.signals.slice(0, 12).map((s) => ({ type: s.type, title: s.title, when: s.type === "intent" ? "this week" : relative(s.occurredAt, now) })),
    offer: {
      name: o.name,
      promise: o.promise,
      price: o.priceMinCents != null ? money(o.priceMinCents) : null,
      proof: [...o.proofPoints, ...o.caseStudies.map((c) => `${c.caseStudy.title} (${c.caseStudy.client}): ${c.caseStudy.result}`)].slice(0, 5),
      targetTitles: o.targetTitles,
    },
    brief: { whyNow: match.whyNow, angle: match.angle },
  });
  await db.accountMatch.update({ where: { id: match.id }, data: { callPrep: output as unknown as Prisma.InputJsonValue, callPrepAt: now } });
  return output;
}

/** Review a call from a pasted transcript or recap. */
export async function reviewCall(ctx: CompanyContext, accountId: string, input: { title: string; heldAt: Date; transcript: string; offeringId?: string | null; source?: string }) {
  const transcript = input.transcript.trim();
  if (transcript.length < 80) throw new Error("Paste the transcript or a recap of at least a few sentences.");
  const a = await ctx.db.account.findUniqueOrThrow({ where: { id: accountId }, include: { contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] } } });
  const oid = input.offeringId ?? a.bestOfferingId;
  const offering = oid ? await ctx.db.offering.findUnique({ where: { id: oid } }) : null;
  const buyer = a.contacts[0];
  const { output, runId } = await runAi(ctx.db, ctx.company.id, callReviewTask, {
    account: a.name,
    offer: offering ? `${offering.name}: ${offering.promise}` : "not set",
    buyer: buyer ? `${buyer.firstName} ${buyer.lastName ?? ""}`.trim() : null,
    checklist: QUALIFICATION.map((q) => ({ key: q.key, label: q.label, listenFor: q.listenFor })),
    transcript: transcript.slice(0, 60_000),
  });
  const review = await ctx.db.callReview.create({
    data: { companyId: ctx.company.id, accountId, offeringId: oid ?? null, title: input.title || "Call", heldAt: input.heldAt, source: input.source ?? "pasted", transcript, review: output as unknown as Prisma.InputJsonValue, aiRunId: runId, createdBy: ctx.user.name },
  });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "account.callReview", entity: "account", entityId: accountId, data: { reviewId: review.id, recommendedStatus: output.recommendedStatus } });
  return review.id;
}

/** The review as a HubSpot note. */
export function callReviewNoteHtml(title: string, heldAt: Date, r: CallReviewOutput): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const score = qualificationScore(r.qualification);
  const label = (k: string) => QUALIFICATION.find((q) => q.key === k)?.label ?? k;
  return [
    `<p><strong>Call review: ${esc(title)}</strong> (${heldAt.toISOString().slice(0, 10)}) · qualification ${score}% · suggested status: ${r.recommendedStatus.toLowerCase()}</p>`,
    `<p>${esc(r.summary)}</p>`,
    `<p><strong>Qualification</strong></p><ul>${r.qualification.map((q) => `<li>${esc(label(q.key))}: ${QUAL_STATUS_LABEL[q.status]}. ${esc(q.evidence)}</li>`).join("")}</ul>`,
    r.pains.length ? `<p><strong>Their pains, in their words</strong></p><ul>${r.pains.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : "",
    r.objections.length ? `<p><strong>Objections</strong></p><ul>${r.objections.map((o) => `<li>${esc(o.objection)}${o.answered ? " (answered)" : " (open)"}</li>`).join("")}</ul>` : "",
    `<p><strong>Next steps</strong></p><ul>${r.nextSteps.map((n) => `<li>${n.owner === "us" ? "Us" : "Them"}: ${esc(n.action)}${n.due ? ` (by ${esc(n.due)})` : ""}</li>`).join("")}</ul>`,
    r.risks.length ? `<p><strong>Risks</strong></p><ul>${r.risks.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "",
    `<p><em>From the Taazaa acquisition system.</em></p>`,
  ].join("");
}

/** Add the review to the account's HubSpot company (and buyer) as a note. The account must be pushed first. */
export async function pushCallReview(ctx: CompanyContext, reviewId: string) {
  const review = await ctx.db.callReview.findUniqueOrThrow({ where: { id: reviewId }, include: { account: { include: { contacts: true, seller: true } } } });
  const a = review.account;
  if (!a.hubspotCompanyId) throw new Error("Push the account to HubSpot first, then add the call to it.");
  const hs = adapters(ctx.db, ctx.company.id).hubspot;
  const contactIds = a.contacts.map((c) => c.hubspotContactId).filter((x): x is string => !!x);
  const { noteId } = await hs.upsertNote({ noteId: review.hubspotNoteId, companyId: a.hubspotCompanyId, contactIds, html: callReviewNoteHtml(review.title, review.heldAt, review.review as unknown as CallReviewOutput), ownerId: a.seller?.hubspotOwnerId ?? null });
  await ctx.db.callReview.update({ where: { id: reviewId }, data: { hubspotNoteId: noteId } });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "account.callReviewPushed", entity: "account", entityId: a.id, data: { reviewId, noteId } });
  return noteId;
}
