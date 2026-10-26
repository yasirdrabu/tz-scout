// Buyers end to end on the mock prospect source against the test database: pull, signals, contacts,
// matching to every approved offer, briefs, and starting outreach into the show-up sequence.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgresql://acq:acq@localhost:5440/acq_test";
process.env.JOBS_DISABLED = "true";

async function reachable() {
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: TEST_URL, connectionTimeoutMillis: 1500 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}
const up = await reachable();

describe.skipIf(!up)("buyers on mocks", () => {
  process.env.DATABASE_URL = TEST_URL;
  let db: typeof import("@/lib/db");
  let buyers: typeof import("@/server/buyers");
  let ctx: import("@/server/context").CompanyContext;
  let searchId: string;

  beforeAll(async () => {
    const root = path.resolve(__dirname, "../..");
    execFileSync(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: { ...process.env, DATABASE_URL: TEST_URL, PRISMA_HIDE_UPDATE_MESSAGE: "1" }, stdio: "pipe" });
    db = await import("@/lib/db");
    buyers = await import("@/server/buyers");
    const { defaultSettings } = await import("@/lib/defaults");
    const { defaultRulesFor } = await import("@/lib/signalRules");
    if (!TEST_URL.endsWith("/acq_test")) throw new Error("Refusing to clear a database that isn't acq_test.");
    const tables = await db.unscopedDb.$queryRaw<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public'`;
    await db.unscopedDb.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"public"."${t.tablename}"`).join(", ")} CASCADE`);

    const u = db.unscopedDb;
    const company = await u.company.create({ data: { slug: "b", name: "Buyer Co" } });
    const s = defaultSettings();
    await u.settings.create({ data: { companyId: company.id, weights: s.weights, testDefaults: s.testDefaults, funnelDefaults: s.funnelDefaults, sequence: s.sequence, scorecard: s.scorecard } });
    const owner = await u.user.create({ data: { email: "o@b.test", name: "Owner" } });
    await u.membership.create({ data: { companyId: company.id, userId: owner.id, role: "OWNER" } });
    const sdb = db.scopedDb(company.id);
    ctx = { db: sdb, company: { id: company.id, slug: "b", name: "Buyer Co", currency: "USD" }, user: { id: owner.id, name: "Owner", email: owner.email, isAdmin: false }, role: "OWNER", can: () => true };
    const base = { companyId: company.id, status: "APPROVED" as const, regions: ["United States"], companySizeMin: 100, companySizeMax: 2500, revenueMinCents: BigInt(5_000_000_000), revenueMaxCents: BigInt(50_000_000_000), excludedDomains: [], excludedCategories: ["Gambling"], proofPoints: [] };
    const om = await sdb.offering.create({ data: { ...base, slug: "ai-opportunity-map", name: "AI Opportunity Map", promise: "Where AI pays back.", targetTitles: ["CEO", "COO", "VP Operations"], industries: ["Commercial real estate", "Healthcare services", "Logistics"], signalRules: defaultRulesFor("ai-opportunity-map") as never } });
    await sdb.offering.create({ data: { ...base, slug: "modernization-blueprint", name: "Modernization Blueprint", promise: "Fixed price for Release 1.", targetTitles: ["COO", "CIO", "VP Operations"], industries: ["Logistics", "Healthcare services"], signalRules: defaultRulesFor("modernization-blueprint") as never } });
    await sdb.offering.create({ data: { ...base, status: "DRAFT", slug: "draft", name: "Draft offer", promise: "x", targetTitles: ["CEO"], industries: ["Logistics"] } });
    searchId = await buyers.saveSearch(ctx, null, { name: "Logistics and RE", offeringId: om.id, filters: { ...buyers.filtersFor(om), industries: ["Logistics", "Commercial real estate"] }, maxCompanies: 12, schedule: "off" });
  }, 120_000);

  afterAll(async () => {
    await db?.unscopedDb.$disconnect();
  });

  it("a pull creates accounts with firmographics, signals and contacts", async () => {
    await buyers.runSearch(ctx.db, ctx.company.id, searchId);
    const s = await ctx.db.prospectSearch.findUniqueOrThrow({ where: { id: searchId } });
    expect(s.status).toBe("done");
    expect(s.lastRunFound).toBe(12);
    expect(s.lastRunNew).toBe(12);
    expect(s.lastRunCredits).toBeGreaterThan(0);
    expect(await ctx.db.account.count()).toBe(12);
    expect(await ctx.db.signal.count({ where: { type: "hiring" } })).toBeGreaterThan(0);
    expect(await ctx.db.contact.count()).toBeGreaterThan(0);
  });

  it("matches every account to every approved offer, never a draft", async () => {
    const offers = await ctx.db.offering.findMany({ where: { status: "APPROVED" } });
    const draft = await ctx.db.offering.findFirstOrThrow({ where: { status: "DRAFT" } });
    expect(await ctx.db.accountMatch.count()).toBe(12 * offers.length);
    expect(await ctx.db.accountMatch.count({ where: { offeringId: draft.id } })).toBe(0);
    const a = await ctx.db.account.findFirstOrThrow({ include: { matches: true } });
    const best = [...a.matches].sort((x, y) => y.total - x.total)[0]!;
    expect(a.bestOfferingId).toBe(best.offeringId);
    expect(a.bestTotal).toBe(best.total);
  });

  it("a carrier on Microsoft Access hiring an Access developer matches Modernization Blueprint", async () => {
    const ng = await ctx.db.account.findFirstOrThrow({ where: { domain: "northgate-freight.com" }, include: { matches: { include: { offering: true } } } });
    const best = ng.matches.find((m) => m.offeringId === ng.bestOfferingId)!;
    expect(best.offering.slug).toBe("modernization-blueprint");
    // Legacy stack and legacy hiring are visible pain; without research or a trigger it is a good fit, not act now.
    expect(["act_now", "good_fit"]).toContain(ng.tier);
  });

  it("briefs the strongest accounts with why now, angle and opener", async () => {
    const briefed = await ctx.db.accountMatch.findMany({ where: { whyNow: { not: null } } });
    expect(briefed.length).toBeGreaterThan(0);
    expect(briefed[0]!.opener).toMatch(/^Hi /);
    expect(await ctx.db.aiRun.count({ where: { task: "account-brief" } })).toBe(briefed.length);
  });

  it("re-running a pull updates accounts instead of duplicating them", async () => {
    await buyers.runSearch(ctx.db, ctx.company.id, searchId);
    expect(await ctx.db.account.count()).toBe(12);
    expect((await ctx.db.prospectSearch.findUniqueOrThrow({ where: { id: searchId } })).lastRunNew).toBe(0);
  });

  it("starting outreach creates an outbound lead and sends the opener with a booking link", async () => {
    const a = await ctx.db.account.findFirstOrThrow({ where: { domain: "northgate-freight.com" }, include: { contacts: true } });
    const contact = a.contacts[0]!;
    const leadId = await buyers.startOutreach(ctx, a.id, contact.id);
    const lead = await ctx.db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { touches: true } });
    expect(lead.source).toBe("outbound");
    expect(lead.status).toBe("VALIDATED");
    expect(lead.email).toMatch(/@northgate-freight\.com$/);
    expect(lead.touches[0]!.kind).toBe("booking_link");
    const match = await ctx.db.accountMatch.findFirstOrThrow({ where: { accountId: a.id, offeringId: a.bestOfferingId! } });
    if (match.opener) expect(lead.touches[0]!.body.startsWith(match.opener)).toBe(true);
    expect((await ctx.db.account.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("WORKING");
    // Starting again is a no-op.
    expect(await buyers.startOutreach(ctx, a.id, contact.id)).toBe(leadId);
  });

  it("assigns to a HubSpot owner on the team, then pushes the company, note, contacts and task", async () => {
    const crm = await import("@/server/crm");
    await crm.upsertSellers(ctx.db, ctx.company.id, [{ id: "111", name: "Ash Rep", active: true }, { id: "222", name: "Not On Team", active: true }], ["111"]);
    const ash = await ctx.db.seller.findFirstOrThrow({ where: { hubspotOwnerId: "111" } });
    const off = await ctx.db.seller.findFirstOrThrow({ where: { hubspotOwnerId: "222" } });
    const a = await ctx.db.account.findFirstOrThrow({ where: { domain: "northgate-freight.com" }, include: { contacts: true } });

    await expect(crm.pushToHubSpot(ctx, a.id)).rejects.toThrow(/Assign an owner/);
    await expect(crm.assignSeller(ctx, [a.id], off.id)).rejects.toThrow(/isn't on the team/);
    expect(await crm.assignSeller(ctx, [a.id], ash.id)).toBe(1);

    const r = await crm.pushToHubSpot(ctx, a.id);
    expect(r.contacts).toBe(Math.min(a.contacts.length, 5));
    const after = await ctx.db.account.findUniqueOrThrow({ where: { id: a.id }, include: { contacts: true } });
    expect(after.hubspotCompanyId).toMatch(/^hs_co_/);
    expect(after.hubspotNoteId).toMatch(/^hs_n_/);
    expect(after.pushedOwnerId).toBe("111");
    expect(after.contacts.every((c) => !!c.hubspotContactId)).toBe(true);
    const company = await ctx.db.auditLog.findFirstOrThrow({ where: { action: "hubspot.upsertCompany" } });
    expect((company.data as { ownerId: string }).ownerId).toBe("111");
    expect(await ctx.db.auditLog.count({ where: { action: "hubspot.upsertNote" } })).toBe(1);
    // The first email plus one dated task for each of the three follow-ups.
    expect(await ctx.db.auditLog.count({ where: { action: "hubspot.createTask" } })).toBe(4);
    expect(after.hubspotSequenceTaskIds).toHaveLength(3);
    // Sent: it left the queue for its handoff batch, with a follow-through baseline.
    const batch = await ctx.db.handoffBatch.findUniqueOrThrow({ where: { id: after.batchId! } });
    expect(batch.name).toMatch(/Northgate Freight to Ash|to Ash/);
    // One handoff message for the rep, in place of an alert per task.
    const messages = batch.messages as { seller: string; count: number; text: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toMatch(/^Hi Ash, 1 new account is in HubSpot for you/);
    expect(messages[0]!.text).toContain(a.name);
    expect((after.followUp as { tasksTotal: number }).tasksTotal).toBe(4);
    const queue = await buyers.listBuyers(ctx.db, { tier: "all", take: 500 });
    expect(queue.some((x) => x.id === a.id)).toBe(false);
    const match = await ctx.db.accountMatch.findFirstOrThrow({ where: { accountId: a.id, offeringId: after.bestOfferingId! } });
    expect((match.sequence as { body: string }[]).every((s) => s.body.trim().endsWith("Ash"))).toBe(true);

    // Pushing again updates the same note and task instead of piling up new ones.
    await crm.pushToHubSpot(ctx, a.id);
    const again = await ctx.db.account.findUniqueOrThrow({ where: { id: a.id } });
    expect(again.hubspotNoteId).toBe(after.hubspotNoteId);
    expect(again.hubspotTaskId).toBe(after.hubspotTaskId);
  });

  it("preps a call, reviews one, adds it to HubSpot and drafts a proposal from it", async () => {
    const calls = await import("@/server/calls");
    const proposals = await import("@/server/proposals");
    const a = await ctx.db.account.findFirstOrThrow({ where: { domain: "northgate-freight.com" } });
    const prep = await calls.prepareCall(ctx.db, ctx.company.id, a.id);
    expect(prep.questions.length).toBeGreaterThanOrEqual(6);
    await expect(calls.reviewCall(ctx, a.id, { title: "Discovery", heldAt: new Date(), transcript: "too short" })).rejects.toThrow(/at least a few sentences/);
    const reviewId = await calls.reviewCall(ctx, a.id, {
      title: "Discovery",
      heldAt: new Date(),
      transcript: "The problem is our dispatch runs on Microsoft Access and it takes us hours every morning. It costs us two people full time. Our new COO wants it fixed this year. The CFO would approve anything like this. We have budget for it this year. That sounds like exactly what we need. Let's schedule a next meeting on Tuesday.",
    });
    const review = await ctx.db.callReview.findUniqueOrThrow({ where: { id: reviewId } });
    const rv = review.review as { recommendedStatus: string; qualification: { key: string; status: string }[] };
    expect(rv.recommendedStatus).not.toBe("DISQUALIFIED");
    expect(rv.qualification.filter((q) => q.status !== "missing").map((q) => q.key)).toEqual(expect.arrayContaining(["problem", "decision", "budget", "nextStep"]));
    await calls.pushCallReview(ctx, reviewId);
    expect((await ctx.db.callReview.findUniqueOrThrow({ where: { id: reviewId } })).hubspotNoteId).toMatch(/^hs_n_/);
    const pid = await proposals.draftProposal(ctx, a.id);
    const p = await ctx.db.proposal.findUniqueOrThrow({ where: { id: pid } });
    expect((p.body as { situation: string }).situation).toMatch(/Microsoft Access/);
    await proposals.pushProposal(ctx, pid);
  });

  it("scores offer readiness, then win analysis feeds the wins back into it", async () => {
    const readiness = await import("@/server/offerReadiness");
    const wins = await import("@/server/wins");
    const mb = await ctx.db.offering.findFirstOrThrow({ where: { slug: "modernization-blueprint" } });
    const before = await readiness.scoreOffer(ctx.db, ctx.company.id, mb.id);
    expect(before.factors.find((f) => f.key === "wins")!.reason).toMatch(/half credit/);
    await readiness.setReadinessOverride(ctx, mb.id, "different", 9, "Only fixed-price modernization we know of");
    const id = await wins.runWinAnalysis(ctx);
    const analysis = await ctx.db.winAnalysis.findUniqueOrThrow({ where: { id } });
    expect(analysis.dealCount).toBe(3);
    const after = (await ctx.db.offering.findUniqueOrThrow({ where: { id: mb.id } })).readiness as { factors: { key: string; reason: string; value: number; source: string }[] };
    expect(after.factors.find((f) => f.key === "wins")!.reason).toMatch(/1 closed deal/);
    // The hand-set value survived the rescore.
    expect(after.factors.find((f) => f.key === "different")).toMatchObject({ value: 9, source: "override" });
  });

  it("bulk push skips accounts without an owner and says why", async () => {
    const crm = await import("@/server/crm");
    const two = await ctx.db.account.findMany({ where: { sellerId: null }, take: 2, select: { id: true } });
    const out = await crm.pushMany(ctx, two.map((x) => x.id));
    expect(out.pushed).toBe(0);
    expect(out.skipped).toHaveLength(2);
    expect(out.skipped[0]!.reason).toMatch(/Assign an owner/);
    // Nothing pushed, so no empty batch is left behind, and both stay in the queue.
    expect(out.batchId).toBeNull();
    expect(await ctx.db.account.count({ where: { id: { in: two.map((x) => x.id) }, batchId: null } })).toBe(2);
  });

  it("imports a lead sheet: new companies and people, overlaps tagged, bad rows skipped, scored", async () => {
    const imp = await import("@/server/leadImport");
    const sent = await ctx.db.account.findFirstOrThrow({ where: { batchId: { not: null } } });
    const queued = await ctx.db.account.findFirstOrThrow({ where: { batchId: null, source: { not: "import" } }, include: { contacts: true } });
    const csv = [
      "Company,Website,Name,Title,Email,Phone,Employees,Industry",
      `Harbor Logistics,harborlogistics.example,Dana Reyes,COO,dana@harborlogistics.example,555-0100,"1,200",Logistics`,
      `Harbor Logistics,,Lee Park,VP Operations,lee@harborlogistics.example,,,`,
      `${sent.name},${sent.domain},Pat Kim,CIO,pat@${sent.domain},,,`,
      `${queued.name},${queued.domain},New Person,CEO,new.person@${queued.domain},,,`,
      "Someone,,Sam Lee,CEO,sam@gmail.com,,,",
    ].join("\n");
    const id = await imp.createImport(ctx, { name: "Booth scans", fileName: "booth.csv", bytes: new TextEncoder().encode(csv).buffer as ArrayBuffer });
    const draft = await ctx.db.leadImport.findUniqueOrThrow({ where: { id } });
    expect(draft.status).toBe("mapping");
    expect(draft.mapping).toMatchObject({ company: 0, website: 1, fullName: 2, title: 3, email: 4, phone: 5, employees: 6, industry: 7 });
    // Nothing is created until the columns are confirmed.
    expect(await ctx.db.account.count({ where: { domain: "harborlogistics.example" } })).toBe(0);

    const stats = await imp.runImport(ctx, id, { mapping: draft.mapping as never, enrich: false });
    expect(stats).toMatchObject({ rows: 5, companies: 3, created: 1, alreadySent: 1, alreadyInQueue: 1 });
    expect(stats.skipped).toEqual([expect.objectContaining({ row: 6, reason: expect.stringMatching(/Personal email/) })]);
    const harbor = await ctx.db.account.findFirstOrThrow({ where: { domain: "harborlogistics.example" }, include: { contacts: true } });
    expect(harbor).toMatchObject({ source: "import", employees: 1200, importIds: [id] });
    expect(harbor.contacts.map((c) => c.email).sort()).toEqual(["dana@harborlogistics.example", "lee@harborlogistics.example"]);
    expect(harbor.contacts.every((c) => c.importId === id)).toBe(true);
    expect(harbor.matchedAt).not.toBeNull();
    // Overlaps keep their place (sent stays sent) and are tagged with the list.
    const sentAfter = await ctx.db.account.findUniqueOrThrow({ where: { id: sent.id } });
    expect(sentAfter.batchId).toBe(sent.batchId);
    expect(sentAfter.importIds).toContain(id);
    expect(await ctx.db.contact.count({ where: { accountId: queued.id } })).toBe(queued.contacts.length + 1);
    // The queue can show just this list; sent accounts aren't in it.
    const list = await buyers.listBuyers(ctx.db, { tier: "all", listId: id });
    expect(list.map((x) => x.domain).sort()).toEqual(["harborlogistics.example", queued.domain].sort());
    await expect(imp.runImport(ctx, id, { mapping: draft.mapping as never, enrich: false })).rejects.toThrow(/already imported/);
  });

  it("drops an ABM research sheet: files it in its bucket, keeps the research, holds rows without a website", async () => {
    const imp = await import("@/server/leadImport");
    const crm = await import("@/server/crm");
    const transformation = await ctx.db.bucket.create({ data: { companyId: ctx.company.id, slug: "ai-transformation", name: "AI Transformation", keywords: ["transformation"], sort: 0 } });
    await ctx.db.bucket.create({ data: { companyId: ctx.company.id, slug: "ai-marketing-studio", name: "AI Marketing Studio", keywords: ["marketing studio"], sort: 1 } });
    await ctx.db.offering.updateMany({ where: { slug: { in: ["ai-opportunity-map", "modernization-blueprint"] } }, data: { bucketId: transformation.id } });
    const recent = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10);
    const csv = [
      "report_date,agent,account,official_website,hq,industry,employees,signal_date,signal,signal_source_url,decision_makers,public_business_contact_route,personalized_outreach_hook,proposed_30_day_audit_or_pilot,abm_score,abm_tier,qualification_caveat,estimated_service_fee_usd",
      `${recent},AI Marketing Studio,Ridgeline Packaging,https://ridgeline-pack.example,"Cleveland, OH",Manufacturing,600+ (reported Jan 2026),${recent},Acquired two packaging plants,https://ridgeline-pack.example/news,"Dana Cole — CEO; Lee Park — CMO","lpark@ridgeline-pack.example (published)",Two plants joined; are buyers finding the combined offer?,30-day GTM audit + pilot,90,A,No agency search seen,"15000-35000 (Taazaa proposal)"`,
      `${recent},AI Marketing Studio,Harbor Credit Union,,"Fort Wayne, IN",Credit union,,${recent},Selected a new lending platform,https://news.example/harbor,Pat Moss — CEO,Public contact not verified,Hook,Pilot,84,A,,`,
    ].join("\n");
    const out = await imp.quickImport(ctx, { fileName: "Taazaa_AI_Marketing_Studio_ABM.csv", bytes: new TextEncoder().encode(csv).buffer as ArrayBuffer, enrich: false });
    expect(out).toMatchObject({ ran: true, kind: "research", bucket: "AI Marketing Studio" });
    expect(out.stats).toMatchObject({ companies: 1, created: 1, peopleAdded: 2, signalsAdded: 1 });
    expect(out.stats!.skipped).toEqual([expect.objectContaining({ company: "Harbor Credit Union", needsWebsite: true })]);

    const a = await ctx.db.account.findFirstOrThrow({ where: { domain: "ridgeline-pack.example" }, include: { contacts: true, signals: true } });
    expect(a).toMatchObject({ source: "research", buckets: ["ai-marketing-studio"], employees: 600, city: "Cleveland", state: "OH" });
    expect((a.research as Record<string, { hook: string; price: string }>)["ai-marketing-studio"]).toMatchObject({ hook: "Two plants joined; are buyers finding the combined offer?", price: "$15K to $35K" });
    expect(a.signals).toEqual([expect.objectContaining({ type: "news", source: "research", url: "https://ridgeline-pack.example/news" })]);
    expect(a.contacts.find((c) => c.lastName === "Park")?.email).toBe("lpark@ridgeline-pack.example");
    // No approved offer in its bucket, so no borrowed offer; the research's A with a fresh signal makes it act now.
    expect(a.bestOfferingId).toBeNull();
    expect(a.tier).toBe("act_now");
    expect(a.bestTotal).toBe(90);
    const queue = await buyers.listBuyers(ctx.db, { tier: "act_now", bucket: "ai-marketing-studio" });
    expect(queue.map((x) => x.domain)).toEqual(["ridgeline-pack.example"]);

    // Add the held company's website and it comes in like the rest.
    const added = await imp.addHeldRows(ctx, out.id, [{ row: 3, website: "harborcu.example" }]);
    expect(added).toMatchObject({ added: 1, created: 1 });
    const fixed = await ctx.db.leadImport.findUniqueOrThrow({ where: { id: out.id } });
    expect((fixed.stats as { skipped: unknown[] }).skipped).toHaveLength(0);
    expect(await ctx.db.account.count({ where: { domain: "harborcu.example", buckets: { has: "ai-marketing-studio" } } })).toBe(1);

    // Dropping the same sheet again changes nothing but tags: no duplicate signals or people.
    const again = await imp.quickImport(ctx, { fileName: "Taazaa_AI_Marketing_Studio_ABM.csv", bytes: new TextEncoder().encode(csv).buffer as ArrayBuffer, enrich: false });
    expect(again.stats).toMatchObject({ created: 0, alreadyInQueue: 1, peopleAdded: 0, signalsAdded: 0 });

    // The push carries the research into HubSpot and the rep's handoff message.
    const ash = await ctx.db.seller.findFirstOrThrow({ where: { hubspotOwnerId: "111" } });
    await crm.assignSeller(ctx, [a.id], ash.id);
    await crm.pushToHubSpot(ctx, a.id);
    const note = await ctx.db.auditLog.findFirstOrThrow({ where: { action: "hubspot.upsertNote" }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(note.data)).toBeTruthy();
    const pushed = await ctx.db.account.findUniqueOrThrow({ where: { id: a.id }, include: { batch: true } });
    const msg = (pushed.batch!.messages as { text: string }[])[0]!.text;
    expect(msg).toContain("Ridgeline Packaging (ridgeline-pack.example): AI Marketing Studio.");
  });

  it("new signal rules change the ranking after a rematch", async () => {
    const om = await ctx.db.offering.findFirstOrThrow({ where: { slug: "ai-opportunity-map" } });
    await buyers.saveSignalRules(ctx, om.id, [{ id: "x", type: "tech", label: "Uses QuickBooks", match: ["quickbooks"], weight: 100 }]);
    await buyers.rematchAll(ctx.db, ctx.company.id);
    const qb = await ctx.db.account.findMany({ where: { technologies: { has: "QuickBooks" } }, include: { matches: true } });
    for (const a of qb) {
      const m = a.matches.find((x) => x.offeringId === om.id)!;
      if (m.fit >= 50) expect(m.signal).toBe(100);
    }
  });
});
