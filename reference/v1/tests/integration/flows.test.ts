// End-to-end flows through the real services on mocks, against the test database.
// Covers acceptance criteria that span modules: overrides survive regeneration, the active cap,
// batch launch to verdicts, lead validation timing and routing, and the show-up sequence.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgresql://acq:acq@localhost:5440/acq_test";
process.env.JOBS_DISABLED = "true";
process.env.MOCK_AD_TEST_SECONDS = "1";

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

describe.skipIf(!up)("flows on mocks", () => {
  process.env.DATABASE_URL = TEST_URL;
  type Mods = {
    db: typeof import("@/lib/db");
    segments: typeof import("@/server/segments");
    tests: typeof import("@/server/tests");
    leads: typeof import("@/server/leads");
    meetings: typeof import("@/server/meetings");
    defaults: typeof import("@/lib/defaults");
  };
  let m: Mods;
  let ctx: import("@/server/context").CompanyContext;
  let offeringId: string;

  beforeAll(async () => {
    const root = path.resolve(__dirname, "../..");
    execFileSync(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "db", "push", "--skip-generate"], { cwd: root, env: { ...process.env, DATABASE_URL: TEST_URL, PRISMA_HIDE_UPDATE_MESSAGE: "1" }, stdio: "pipe" });
    m = {
      db: await import("@/lib/db"),
      segments: await import("@/server/segments"),
      tests: await import("@/server/tests"),
      leads: await import("@/server/leads"),
      meetings: await import("@/server/meetings"),
      defaults: await import("@/lib/defaults"),
    };
    if (!TEST_URL.endsWith("/acq_test")) throw new Error("Refusing to clear a database that isn't acq_test.");
    const tables = await m.db.unscopedDb.$queryRaw<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public'`;
    await m.db.unscopedDb.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"public"."${t.tablename}"`).join(", ")} CASCADE`);

    const u = m.db.unscopedDb;
    const company = await u.company.create({ data: { slug: "flow", name: "Flow Co" } });
    const s = m.defaults.defaultSettings();
    await u.settings.create({ data: { companyId: company.id, weights: s.weights, maxActiveSegments: 2, testDefaults: s.testDefaults, funnelDefaults: s.funnelDefaults, sequence: s.sequence, scorecard: s.scorecard } });
    const owner = await u.user.create({ data: { email: "owner@flow.test", name: "Owner" } });
    const rep = await u.user.create({ data: { email: "rep@flow.test", name: "Rep" } });
    await u.membership.createMany({ data: [{ companyId: company.id, userId: owner.id, role: "OWNER" }, { companyId: company.id, userId: rep.id, role: "SALES" }] });
    const db = m.db.scopedDb(company.id);
    ctx = { db, company: { id: company.id, slug: "flow", name: "Flow Co", currency: "USD" }, user: { id: owner.id, name: "Owner", email: owner.email, isAdmin: false }, role: "OWNER", can: () => true };
    const cs = await db.caseStudy.create({ data: { companyId: company.id, title: "Dispatch", client: "Tobi", industry: "Transportation and healthcare services", result: "+32% revenue" } });
    const o = await db.offering.create({
      data: {
        companyId: company.id, slug: "ai-opportunity-map", name: "AI Opportunity Map", promise: "Know where AI pays back.", status: "APPROVED",
        dealSizeCents: 1_000_000, grossMargin: 0.6, targetTitles: ["CEO", "COO", "VP Operations"], industries: ["Commercial real estate", "Healthcare services", "Logistics"],
        regions: ["United States"], companySizeMin: 100, companySizeMax: 2500, revenueMinCents: BigInt(5_000_000_000), revenueMaxCents: BigInt(50_000_000_000),
        excludedDomains: [], excludedCategories: ["Gambling"], proofPoints: [], timelineWindowDays: 180,
      },
    });
    offeringId = o.id;
    await db.offeringCaseStudy.create({ data: { companyId: company.id, offeringId, caseStudyId: cs.id } });
  }, 120_000);

  afterAll(async () => {
    await m?.db.unscopedDb.$disconnect();
  });

  it("generates 8 to 12 segments, each with all ten factors and reasons", async () => {
    const ids = await m.segments.generateSegments(ctx, offeringId);
    expect(ids.length).toBeGreaterThanOrEqual(8);
    expect(ids.length).toBeLessThanOrEqual(12);
    const factors = await ctx.db.segmentFactor.findMany({ where: { segmentId: ids[0] } });
    expect(factors).toHaveLength(10);
    expect(factors.every((f) => f.reason.length > 0)).toBe(true);
  });

  it("overrides survive regeneration", async () => {
    const seg = await ctx.db.segment.findFirstOrThrow({ where: { key: "om-cre-ops" } });
    await m.segments.overrideFactor(ctx, seg.id, "pain", 3, "Testing");
    await m.segments.generateSegments(ctx, offeringId);
    const f = await ctx.db.segmentFactor.findUniqueOrThrow({ where: { segmentId_factor: { segmentId: seg.id, factor: "pain" } } });
    expect(f.overrideValue).toBe(3);
    expect(f.overrideNote).toBe("Testing");
    expect(await ctx.db.segment.count({ where: { offeringId } })).toBe(8); // updated, not duplicated
  });

  it("caps active segments per offering", async () => {
    const segs = await ctx.db.segment.findMany({ where: { offeringId }, take: 3, orderBy: { key: "asc" } });
    await m.segments.setSegmentStatus(ctx, segs[0]!.id, "ACTIVE");
    await m.segments.setSegmentStatus(ctx, segs[1]!.id, "ACTIVE");
    await expect(m.segments.setSegmentStatus(ctx, segs[2]!.id, "ACTIVE")).rejects.toThrow(/Only 2 segments/);
  });

  it("runs a message test from draft to verdicts", async () => {
    const seg = await ctx.db.segment.findFirstOrThrow({ where: { status: "ACTIVE" } });
    const d = m.defaults.DEFAULT_TEST;
    const batchId = await m.tests.createBatch(ctx, seg.id, { channel: "meta", budgetCents: d.budgetCents, durationHours: d.durationHours, targetCtr: d.targetCtr, targetCpcCents: d.targetCpcCents, minImpressions: d.minImpressions, statementCount: 12 });
    const st = await ctx.db.statement.findMany({ where: { batchId } });
    expect(st.length).toBe(12);
    expect(st.filter((s) => s.kind === "PROBLEM").length).toBe(6);
    expect(st.every((s) => s.text.split(/\s+/).length <= 25)).toBe(true);
    await expect(m.tests.launchBatch(ctx, batchId)).rejects.toThrow(/approve/i);
    await m.tests.approveBatch(ctx, batchId);
    await m.tests.launchBatch(ctx, batchId);
    expect(await m.tests.collectResults(ctx.db, ctx.company.id, batchId)).toBe(false);
    await new Promise((r) => setTimeout(r, 1200));
    expect(await m.tests.collectResults(ctx.db, ctx.company.id, batchId)).toBe(true);
    const b = await ctx.db.batch.findUniqueOrThrow({ where: { id: batchId }, include: { statements: { include: { result: true } } } });
    expect(b.status).toBe("COMPLETE");
    expect(b.statements.every((s) => s.result)).toBe(true);
    const spend = b.statements.reduce((sum, s) => sum + s.result!.spendCents, 0);
    expect(spend).toBeLessThanOrEqual(b.budgetCents);
  });

  it("validates a good-fit lead within 2 minutes and routes it", async () => {
    const lead = await ctx.db.lead.create({ data: { companyId: ctx.company.id, offeringId, email: "dana@keystone-ridge-properties.com", firstName: "Dana", lastName: "Reyes", title: "Chief Operating Officer", domain: "keystone-ridge-properties.com", timelineAnswer: "3m" } });
    const t0 = Date.now();
    await m.leads.validateLead(ctx.db, ctx.company.id, lead.id);
    expect(Date.now() - t0).toBeLessThan(120_000);
    const l = await ctx.db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { checks: true, touches: true } });
    expect(l.status).toBe("VALIDATED");
    expect(l.checks).toHaveLength(7);
    expect(l.researchNote?.split("\n").length).toBeGreaterThanOrEqual(3);
    expect(l.ownerUserId).toBeTruthy();
    expect(l.hubspotContactId).toBeTruthy();
    expect(l.touches.map((t) => t.kind)).toEqual(["booking_link"]);
  });

  it("routes failures to not qualified and unknowns to review", async () => {
    const mk = (email: string, title: string, timeline: string) => ctx.db.lead.create({ data: { companyId: ctx.company.id, offeringId, email, firstName: "X", lastName: "Y", title, domain: email.split("@")[1], timelineAnswer: timeline } });
    const free = await mk("x@gmail.com", "COO", "3m");
    const unknown = await mk("x@quietwater-partners.com", "COO", "3m");
    await m.leads.validateLead(ctx.db, ctx.company.id, free.id);
    await m.leads.validateLead(ctx.db, ctx.company.id, unknown.id);
    expect((await ctx.db.lead.findUniqueOrThrow({ where: { id: free.id } })).status).toBe("NOT_QUALIFIED");
    expect((await ctx.db.lead.findUniqueOrThrow({ where: { id: unknown.id } })).status).toBe("REVIEW");
  });

  it("logs a human override and starts the sequence", async () => {
    const lead = await ctx.db.lead.findFirstOrThrow({ where: { status: "REVIEW" } });
    await m.leads.overrideLead(ctx, lead.id, "VALIDATED", "Checked LinkedIn");
    const l = await ctx.db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { touches: true } });
    expect(l.overrideStatus).toBe("VALIDATED");
    expect(l.touches.some((t) => t.kind === "booking_link")).toBe(true);
    const log = await ctx.db.auditLog.findFirst({ where: { entity: "lead", entityId: lead.id, action: "lead.override" } });
    expect(log).toBeTruthy();
  });

  it("books, reminds, and rebooks after a no-show", async () => {
    const lead = await ctx.db.lead.findFirstOrThrow({ where: { email: "dana@keystone-ridge-properties.com" } });
    const at = new Date(Date.now() + 3 * 86400_000);
    const meetingId = await m.meetings.bookMeeting(ctx.db, ctx.company.id, lead.id, at);
    const touches = await ctx.db.meetingTouch.findMany({ where: { meetingId } });
    expect(touches.map((t) => t.kind).sort()).toEqual(["confirmation", "precall_note", "reminder_1h", "reminder_24h"]);
    expect(touches.find((t) => t.kind === "reminder_24h")!.dueAt.getTime()).toBe(at.getTime() - 24 * 3600_000);
    expect((await ctx.db.meeting.findUniqueOrThrow({ where: { id: meetingId } })).caseStudyId).toBeTruthy();

    await m.meetings.setMeetingStatus(ctx, meetingId, "NO_SHOW");
    const rebook = await ctx.db.meetingTouch.findMany({ where: { meetingId, kind: { startsWith: "rebook" } } });
    expect(rebook).toHaveLength(3);
    const next = await m.meetings.bookMeeting(ctx.db, ctx.company.id, lead.id, new Date(Date.now() + 5 * 86400_000));
    expect((await ctx.db.meeting.findUniqueOrThrow({ where: { id: meetingId } })).status).toBe("REBOOKED");
    expect((await ctx.db.meeting.findUniqueOrThrow({ where: { id: next } })).rebookOfId).toBe(meetingId);
    expect(await ctx.db.meetingTouch.count({ where: { meetingId, status: "SCHEDULED" } })).toBe(0);
  });

  it("sends due touches through the messaging adapter", async () => {
    const sent = await m.meetings.sendDueTouches(new Date(Date.now() + 60_000));
    expect(sent).toBeGreaterThan(0);
    expect(await ctx.db.meetingTouch.count({ where: { kind: "confirmation", status: "SENT" } })).toBeGreaterThan(0);
  });
});
