"use server";

import { authorize } from "@/server/context";
import { act, optStr, str, type ActionResult } from "@/server/action";
import { audit } from "@/server/audit";
import { briefAccount, refreshAccount, revealEmail, setAccountStatus, setExclusionOverride, startOutreach } from "@/server/buyers";
import { assignSeller, checkHubSpot, pushMany, pushToHubSpot } from "@/server/crm";
import { prepareCall, pushCallReview, reviewCall } from "@/server/calls";
import { draftProposal, pushProposal, saveProposal } from "@/server/proposals";
import { redirect } from "next/navigation";
import { isAccountStatus } from "./labels";

const path = (slug: string) => `/c/${slug}/buyers`;

export async function assignSellerAction(slug: string, accountId: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      await assignSeller(ctx, [accountId], optStr(fd, "sellerId"));
    },
    { revalidate: path(slug), message: "Owner saved. Push to HubSpot to hand it over." },
  );
}

/** Bulk: assign the checked accounts, push them, or both. */
export async function bulkBuyersAction(slug: string, _prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const ids = fd.getAll("ids").filter((x): x is string => typeof x === "string" && !!x);
  const op = String(fd.get("op") ?? "");
  const sellerId = optStr(fd, "sellerId");
  let message = "";
  const r = await act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      if (!ids.length) throw new Error("Check at least one company first.");
      if (op === "assign" || op === "assign_push") {
        if (!sellerId && op === "assign_push") throw new Error("Pick who follows up before pushing.");
        const n = await assignSeller(ctx, ids, sellerId);
        message = sellerId ? `Assigned ${n} ${n === 1 ? "company" : "companies"}.` : `Unassigned ${n}.`;
      }
      if (op === "push" || op === "assign_push") {
        const out = await pushMany(ctx, ids);
        message = [message, `Pushed ${out.pushed} to HubSpot (${out.created} new). They moved to Sent, with one handoff message per rep ready to copy there.`, out.skipped.length ? `Skipped ${out.skipped.length}: ${out.skipped.map((x) => `${x.name} (${x.reason})`).join("; ")}` : ""].filter(Boolean).join(" ");
      }
      if (op === "check") {
        const t = await checkHubSpot(ctx, ids);
        message = `Checked ${ids.length} in HubSpot: ${t.new} not there, ${t.in_crm} already there, ${t.open_deal} with an open deal, ${t.customer} customers.`;
      }
    },
    { revalidate: path(slug) },
  );
  return r.ok ? { ...r, message } : r;
}

export async function setAccountStatusAction(slug: string, accountId: string, status: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      if (!isAccountStatus(status)) throw new Error("Pick a valid status.");
      await setAccountStatus(ctx, accountId, status);
    },
    { revalidate: path(slug) },
  );
}

export async function pushToHubSpotAction(slug: string, accountId: string, allowOtherOwner: boolean, _prev: ActionResult | null, _fd: FormData): Promise<ActionResult> {
  let message = "";
  const r = await act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      const out = await pushToHubSpot(ctx, accountId, { allowOtherOwner });
      message = `${out.created ? "Created in" : "Updated in"} HubSpot with the full context and ${out.contacts} ${out.contacts === 1 ? "contact" : "contacts"}. The handoff message for the rep is on Sent.${out.ownerKept ? " The owner already set in HubSpot was kept." : ""}`;
    },
    { revalidate: path(slug) },
  );
  return r.ok ? { ...r, message } : r;
}

export async function checkHubSpotAction(slug: string, accountId: string | null, _prev: ActionResult | null, _fd: FormData): Promise<ActionResult> {
  let message = "";
  const r = await act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      const t = await checkHubSpot(ctx, accountId ? [accountId] : undefined);
      const n = t.new + t.in_crm + t.open_deal + t.customer;
      message = accountId ? "Checked HubSpot." : `Checked ${n} in HubSpot: ${t.new} not there, ${t.in_crm} already there, ${t.open_deal} with an open deal, ${t.customer} customers.`;
    },
    { revalidate: path(slug) },
  );
  return r.ok ? { ...r, message } : r;
}

export async function refreshAccountAction(slug: string, accountId: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.pull");
      await refreshAccount(ctx, accountId);
      await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "account.refresh", entity: "account", entityId: accountId });
    },
    { revalidate: path(slug), message: "Data refreshed." },
  );
}

export async function briefAccountAction(slug: string, accountId: string, offeringId: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      await briefAccount(ctx.db, ctx.company.id, accountId, offeringId);
      await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "account.brief", entity: "account", entityId: accountId, data: { offeringId } });
    },
    { revalidate: path(slug), message: "Brief written." },
  );
}

export async function revealEmailAction(slug: string, contactId: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      await revealEmail(ctx, contactId);
    },
    { revalidate: path(slug) },
  );
}

export async function startOutreachAction(slug: string, accountId: string, contactId: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      return startOutreach(ctx, accountId, contactId);
    },
    { revalidate: [path(slug), `/c/${slug}/leads`], message: "Outreach started." },
  );
}

export async function setExclusionAction(slug: string, accountId: string, include: boolean, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      await setExclusionOverride(ctx, accountId, include);
    },
    { revalidate: `/c/${slug}/buyers` },
  );
}
// ---------- Calls ----------

export async function prepareCallAction(slug: string, accountId: string, offeringId: string | null, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      await prepareCall(ctx.db, ctx.company.id, accountId, offeringId);
    },
    { revalidate: path(slug), message: "Call plan ready." },
  );
}

export async function reviewCallAction(slug: string, accountId: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      const when = optStr(fd, "heldAt");
      const heldAt = when ? new Date(`${when}T12:00:00`) : new Date();
      if (Number.isNaN(heldAt.getTime())) throw new Error("Pick a valid date.");
      return reviewCall(ctx, accountId, { title: optStr(fd, "title") ?? "Discovery call", heldAt, transcript: String(fd.get("transcript") ?? ""), source: optStr(fd, "source") ?? "pasted" });
    },
    { revalidate: path(slug), message: "Call reviewed." },
  );
}

export async function pushCallReviewAction(slug: string, reviewId: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      await pushCallReview(ctx, reviewId);
    },
    { revalidate: path(slug), message: "Added to HubSpot." },
  );
}

// ---------- Proposals ----------

export async function draftProposalAction(slug: string, accountId: string, offeringId: string | null, _prev: ActionResult | null, _fd: FormData): Promise<ActionResult> {
  let id = "";
  const r = await act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      id = await draftProposal(ctx, accountId, offeringId);
    },
    { revalidate: path(slug) },
  );
  if (r.ok) redirect(`/c/${slug}/buyers/${accountId}/proposals/${id}`);
  return r;
}

const lines = (fd: FormData, k: string) => String(fd.get(k) ?? "").split("\n").map((s) => s.replace(/^[-•*]\s*/, "").trim()).filter(Boolean);

/** Phases are edited as blocks: "Name (duration)", then "- activity" lines, then "You get: a, b". */
function parsePhases(text: string) {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.split("\n").map((l) => l.trim()).filter(Boolean))
    .filter((b) => b.length)
    .map((b) => {
      const head = b[0]!.match(/^(.*?)\s*\((.*)\)\s*$/);
      const gets = b.find((l) => /^you get:/i.test(l));
      return {
        name: (head?.[1] ?? b[0]!).trim(),
        duration: (head?.[2] ?? "").trim(),
        activities: b.slice(1).filter((l) => !/^you get:/i.test(l)).map((l) => l.replace(/^[-•*]\s*/, "")),
        deliverables: gets ? gets.replace(/^you get:\s*/i, "").split(/,\s*/).filter(Boolean) : [],
      };
    });
}

export async function saveProposalAction(slug: string, accountId: string, proposalId: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      await saveProposal(ctx, proposalId, {
        title: str(fd, "title"),
        situation: str(fd, "situation"),
        objectives: lines(fd, "objectives"),
        phases: parsePhases(String(fd.get("phases") ?? "")),
        deliverables: lines(fd, "deliverables"),
        timeline: str(fd, "timeline"),
        investment: { price: str(fd, "price"), terms: str(fd, "terms") },
        assumptions: lines(fd, "assumptions"),
        whyUs: lines(fd, "whyUs"),
        nextSteps: lines(fd, "nextSteps"),
      });
    },
    { revalidate: `/c/${slug}/buyers/${accountId}/proposals/${proposalId}`, message: "Saved." },
  );
}

export async function setProposalStatusAction(slug: string, accountId: string, proposalId: string, status: "draft" | "sent", _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      await ctx.db.proposal.update({ where: { id: proposalId }, data: { status } });
    },
    { revalidate: `/c/${slug}/buyers/${accountId}/proposals/${proposalId}` },
  );
}

export async function pushProposalAction(slug: string, accountId: string, proposalId: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      await pushProposal(ctx, proposalId);
    },
    { revalidate: `/c/${slug}/buyers/${accountId}/proposals/${proposalId}`, message: "Added to HubSpot." },
  );
}
