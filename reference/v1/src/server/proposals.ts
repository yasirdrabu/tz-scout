// Proposals: draft from the account, the offer and the reviewed calls; edit; add to HubSpot.

import { Prisma } from "@prisma/client";
import type { CompanyContext } from "./context";
import { runAi } from "@/ai/run";
import { proposalTask, ProposalSchema, proposalText, type ProposalDraft } from "@/ai/proposal";
import type { CallReviewOutput } from "@/ai/callReview";
import { money } from "@/lib/format";
import { adapters } from "@/integrations";
import { audit } from "./audit";

export async function draftProposal(ctx: CompanyContext, accountId: string, offeringId?: string | null) {
  const a = await ctx.db.account.findUniqueOrThrow({ where: { id: accountId }, include: { contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] }, callReviews: { orderBy: { heldAt: "desc" }, take: 5 } } });
  const oid = offeringId ?? a.bestOfferingId;
  if (!oid) throw new Error("No offering matches this account yet.");
  const match = await ctx.db.accountMatch.findUniqueOrThrow({ where: { accountId_offeringId: { accountId, offeringId: oid } }, include: { offering: { include: { caseStudies: { include: { caseStudy: true } } } } } });
  const o = match.offering;
  const buyer = a.contacts[0];
  const price = o.priceMinCents != null ? (o.priceMaxCents && o.priceMaxCents !== o.priceMinCents ? `${money(o.priceMinCents)} to ${money(o.priceMaxCents)}` : money(o.priceMinCents)) : null;
  const { output, runId } = await runAi(ctx.db, ctx.company.id, proposalTask, {
    account: { name: a.name, industry: a.industry, size: a.employeesRange ? `${a.employeesRange} employees` : null },
    buyer: buyer ? { name: `${buyer.firstName} ${buyer.lastName ?? ""}`.trim(), title: buyer.title } : null,
    whyNow: match.whyNow,
    offer: { name: o.name, promise: o.promise, price, salesCycleDays: o.salesCycleDays, proof: [...o.proofPoints, ...o.caseStudies.map((c) => `${c.caseStudy.client}: ${c.caseStudy.result}`)].slice(0, 5) },
    calls: a.callReviews.map((c) => {
      const r = c.review as unknown as CallReviewOutput;
      return { title: c.title, summary: r.summary, pains: r.pains, nextSteps: r.nextSteps.map((n) => n.action) };
    }),
  });
  const p = await ctx.db.proposal.create({ data: { companyId: ctx.company.id, accountId, offeringId: oid, title: output.title, body: output as unknown as Prisma.InputJsonValue, aiRunId: runId, createdBy: ctx.user.name } });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "account.proposalDraft", entity: "account", entityId: accountId, data: { proposalId: p.id } });
  return p.id;
}

export async function saveProposal(ctx: CompanyContext, proposalId: string, body: ProposalDraft, status?: "draft" | "sent") {
  const parsed = ProposalSchema.parse(body);
  await ctx.db.proposal.update({ where: { id: proposalId }, data: { title: parsed.title, body: parsed as unknown as Prisma.InputJsonValue, ...(status ? { status } : {}) } });
}

/** Add the proposal to the account's HubSpot company as a note (plain text, kept updated). */
export async function pushProposal(ctx: CompanyContext, proposalId: string) {
  const p = await ctx.db.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { account: { include: { contacts: true, seller: true } } } });
  const a = p.account;
  if (!a.hubspotCompanyId) throw new Error("Push the account to HubSpot first.");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<p><strong>Proposal draft</strong> (${p.status})</p>${esc(proposalText(p.body as unknown as ProposalDraft)).split("\n\n").map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`).join("")}`;
  const { noteId } = await adapters(ctx.db, ctx.company.id).hubspot.upsertNote({ noteId: p.hubspotNoteId, companyId: a.hubspotCompanyId, contactIds: a.contacts.map((c) => c.hubspotContactId).filter((x): x is string => !!x), html, ownerId: a.seller?.hubspotOwnerId ?? null });
  await ctx.db.proposal.update({ where: { id: proposalId }, data: { hubspotNoteId: noteId } });
  return noteId;
}
