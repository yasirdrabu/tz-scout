// Seed: Taazaa with its six productized offerings and six verified case studies, ten weeks of
// pipeline history that runs through the same services the app uses, plus a second sample
// company so company isolation is visible. Margins, rates and history are placeholder
// assumptions until Phase 0 replaces them with real numbers.

process.env.JOBS_DISABLED = "true";

import { Prisma, type Offering } from "@prisma/client";
import { scopedDb, unscopedDb, type ScopedDb } from "../src/lib/db";
import { defaultSettings } from "../src/lib/defaults";
import { between, intBetween, pick, rng } from "../src/lib/rand";
import { addDays, weekStart } from "../src/lib/scorecard";
import { checkIndustry, checkNotExisting, checkRange, checkRole, checkTimeline, checkWorkEmail, decide, type CheckOutcome } from "../src/lib/leadChecks";
import { mockLeadResearch } from "../src/ai/leadResearch";
import { money, num } from "../src/lib/format";
import { generateSegments, overrideFactor, setSegmentStatus } from "../src/server/segments";
import { createBatch, approveBatch, collectResults, decideStatement } from "../src/server/tests";
import { buildWeeks, diagnoseWeek } from "../src/server/scorecard";
import { validateLead } from "../src/server/leads";
import { SAMPLE_SUBMISSIONS } from "../src/server/leads";
import type { CompanyContext } from "../src/server/context";

const M = 100_000_000; // $1M in cents
const NOW = new Date();
const r = rng("acq-seed-v1");

async function reset() {
  const tables = await unscopedDb.$queryRaw<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public'`;
  const names = tables.map((t) => `"public"."${t.tablename}"`).join(", ");
  if (names) await unscopedDb.$executeRawUnsafe(`TRUNCATE ${names} CASCADE`);
  await unscopedDb.$executeRawUnsafe(`DROP SCHEMA IF EXISTS pgboss CASCADE`);
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

async function createCompany(slug: string, name: string) {
  const c = await unscopedDb.company.create({ data: { slug, name } });
  const s = defaultSettings();
  await unscopedDb.settings.create({ data: { companyId: c.id, weights: json(s.weights), maxActiveSegments: s.maxActiveSegments, testDefaults: json(s.testDefaults), funnelDefaults: json(s.funnelDefaults), sequence: json(s.sequence), scorecard: json(s.scorecard) } });
  for (const provider of ["hubspot", "meta", "linkedin", "googleAds", "companyData", "booking", "messaging", "anthropic"]) {
    await unscopedDb.integrationConnection.create({ data: { companyId: c.id, provider, status: "connected", note: "Mock data" } });
  }
  return c;
}

type OfferingSeed = Omit<Prisma.OfferingUncheckedCreateInput, "companyId"> & { cases: string[] };

const REGION = ["United States"];
const EXCLUDE = ["Gambling", "Adult entertainment", "Tobacco", "Firearms"];
const MIDMARKET = { companySizeMin: 100, companySizeMax: 2500, revenueMinCents: BigInt(50 * M), revenueMaxCents: BigInt(500 * M), regions: REGION, excludedCategories: EXCLUDE, excludedDomains: ["taazaa.com"] };

const OFFERINGS: OfferingSeed[] = [
  {
    slug: "ai-opportunity-map",
    name: "AI Opportunity Map",
    promise: "In two weeks, know exactly where AI pays back in your business, ranked, with the first build ready to start.",
    priceMinCents: 1_000_000, priceMaxCents: 1_000_000, dealSizeCents: 1_000_000, grossMargin: 0.6, salesCycleDays: 30,
    targetTitles: ["CEO", "COO", "VP Operations", "President", "Operating Partner"],
    industries: ["Commercial real estate", "Property management", "Healthcare services", "Logistics", "Professional services", "Insurance", "Private equity", "Manufacturing"],
    proofPoints: ["Scored opportunity register and a number one build brief in two weeks", "Tobi: 32% more revenue and 100% on-time trips after AI-assisted dispatch", "Snapform: intake from 3 hours to 45 minutes"],
    status: "APPROVED", approvedAt: addDays(NOW, -60), ...MIDMARKET, cases: ["Tobi", "Snapform", "Safeguard AI", "Taurex"],
  },
  {
    slug: "agentready-diagnostic",
    name: "AgentReady Diagnostic",
    promise: "A clear go, fix first, or not ready answer on AI, scored across six domains, in two to three weeks.",
    priceMinCents: 1_000_000, priceMaxCents: 1_000_000, dealSizeCents: 1_000_000, grossMargin: 0.6, salesCycleDays: 45,
    targetTitles: ["CIO", "CISO", "Head of Data", "Chief Compliance Officer", "CTO", "VP Engineering"],
    industries: ["Healthcare services", "Financial services", "Insurance", "Legal services", "Software", "Commercial real estate", "Professional services"],
    proofPoints: ["Readiness and governance score across six domains, 0 to 4", "Gap to control map plus a remediation roadmap that becomes the next SOW", "MediPulse AI: clinician-facing assistant built with retrieval and per-user memory"],
    status: "APPROVED", approvedAt: addDays(NOW, -40), ...MIDMARKET, cases: ["MediPulse AI", "Taurex", "Safeguard AI"],
  },
  {
    slug: "fde-sprint",
    name: "FDE Sprint",
    promise: "A forward-deployed engineer takes one workflow from we know what to fix to a working result in your environment.",
    priceMinCents: 0, priceMaxCents: 1_000_000, dealSizeCents: 1_000_000, grossMargin: 0.5, salesCycleDays: 21,
    targetTitles: ["COO", "VP Operations", "Director of Operations", "Controller", "Revenue Cycle Director"],
    industries: ["Commercial real estate", "Healthcare services", "Logistics", "Legal services", "Insurance", "Transportation", "Property management"],
    proofPoints: ["Snapform: intake from 3 hours to 45 minutes", "Safeguard AI: 80% less processing time at 98% accuracy", "Quote Harness: worked example of a Sprint build"],
    status: "APPROVED", approvedAt: addDays(NOW, -10), ...MIDMARKET, cases: ["Snapform", "Tobi", "Safeguard AI"],
  },
  {
    slug: "smart-space-poc",
    name: "Smart Space POC Build",
    promise: "A client-owned AI application for one department, live on your data with governance built in.",
    priceMinCents: 2_500_000, priceMaxCents: 4_500_000, dealSizeCents: 3_500_000, grossMargin: 0.55, salesCycleDays: 60,
    targetTitles: ["VP Operations", "Head of Investments", "Chief Risk Officer", "VP Medical Affairs", "VP Customer Success", "Head of Corporate Development"],
    industries: ["Commercial real estate", "Private equity", "Financial services", "Healthcare services", "Life sciences", "Food and beverage", "Software"],
    proofPoints: ["About 70% reusable shell, 30% configured to your data and systems", "Every answer cites its source; every step is audited", "Taurex: 85% faster responses with numbers computed outside the model"],
    status: "APPROVED", approvedAt: addDays(NOW, -21), ...MIDMARKET, cases: ["MediPulse AI", "Taurex", "Civi"],
  },
  {
    slug: "company-brain",
    name: "Company Brain",
    promise: "One department running on a maintained company memory any AI model can use, live in six to eight weeks.",
    priceMinCents: 1_000_000, priceMaxCents: 4_500_000, dealSizeCents: 3_500_000, grossMargin: 0.55, salesCycleDays: 60,
    targetTitles: ["CEO", "COO", "President"],
    industries: ["Commercial real estate", "Professional services", "Healthcare services", "Distribution", "IT services", "Construction"],
    proofPoints: ["Taazaa runs on it first: sales, bid discovery and content", "Blueprint fee credited if you proceed"],
    status: "DRAFT", ...MIDMARKET, cases: ["Civi", "Snapform"],
  },
  {
    slug: "modernization-blueprint",
    name: "Modernization Blueprint",
    promise: "A current-state map, target architecture and a fixed price for Release 1 in two weeks, or the Blueprint is free.",
    priceMinCents: 1_000_000, priceMaxCents: 1_000_000, dealSizeCents: 1_000_000, grossMargin: 0.6, salesCycleDays: 30,
    targetTitles: ["COO", "CIO", "IT Director", "Owner", "VP Operations"],
    industries: ["Logistics", "Property management", "Healthcare services", "Insurance", "Manufacturing", "Nonprofit", "Government services", "Professional services"],
    proofPoints: ["Guarantee: if Release 1 can't be fixed-priced from the Blueprint, the Blueprint is free"],
    status: "APPROVED", approvedAt: addDays(NOW, -10), ...MIDMARKET, cases: [],
  },
];

const CASES = [
  { title: "AI-assisted dispatch for non-emergency medical transport", client: "Tobi", industry: "Transportation and healthcare services", result: "32% more revenue and 100% on-time trips.", link: null },
  { title: "AI document processing for payment cycles", client: "Safeguard AI", industry: "Financial services", result: "80% less processing time at 98% accuracy.", link: null },
  { title: "Legal intake and document abstraction", client: "Snapform", industry: "Legal services", result: "Intake from 3 hours to 45 minutes, with 60 to 80% less paralegal time.", link: null },
  { title: "AI trading coach with deterministic metrics", client: "Taurex", industry: "Financial services", result: "Responses from 148 to 22 seconds, 88% fewer tokens per request, 95% of 75,523 load-test requests under 650 ms.", link: "https://www.taazaa.com/success-story/ai-trading-coach-gives-taurex-a-competitive-moat" },
  { title: "Clinical AI assistant hospital clinicians can trust", client: "MediPulse AI", industry: "Healthcare services", result: "Clinician-facing assistant with layered retrieval and per-user memory. Outcome metrics still to confirm.", link: "https://www.taazaa.com/success-story/medipulse-ai-streamlines-healthcare-workflows-for-hospitals" },
  { title: "AI tax assistant", client: "Civi", industry: "Professional services", result: "AI assistant for tax workflows. Outcome metrics still to confirm.", link: null },
];

// ---------- Synthetic pipeline history ----------

const FIRST = ["Avery", "Blake", "Casey", "Dana", "Elliot", "Frankie", "Gray", "Harper", "Indy", "Jordan", "Kai", "Logan", "Morgan", "Noel", "Oakley", "Parker", "Quinn", "Reese", "Sage", "Taylor", "Val", "Wren", "Rowan", "Emerson", "Jules", "Shea", "Robin", "Drew", "Hayden", "Marlo"];
const LAST = ["Abbott", "Banks", "Carver", "Delgado", "Ellis", "Foster", "Garza", "Hughes", "Ibarra", "Jensen", "Kim", "Lowe", "Mendez", "Nash", "Ortiz", "Pryor", "Quill", "Rhodes", "Soto", "Tran", "Underwood", "Vance", "Walsh", "Young", "Zimmer", "Okafor", "Patel", "Haddad", "Nguyen", "Brennan"];
const CO_A = ["Granite", "Harbor", "Summit", "Cedar", "Northfield", "Bluestone", "Ironwood", "Silverline", "Oakmont", "Riverbend", "Westlake", "Crescent", "Pinecrest", "Redrock", "Lakeshore", "Fairview", "Stonegate", "Meridian", "Clearwater", "Highland"];
const CO_B: Record<string, string[]> = {
  "Commercial real estate": ["Properties", "Realty Partners", "Commercial", "Real Estate Group"],
  "Property management": ["Residential", "Property Management", "Living", "Communities"],
  "Healthcare services": ["Health", "Medical Group", "Care Partners", "Clinics"],
  Logistics: ["Freight", "Logistics", "Transport", "Carriers"],
  "Professional services": ["Advisors", "Consulting", "Partners", "Group"],
  Insurance: ["Insurance", "Underwriters", "Risk Partners", "Mutual"],
  "Private equity": ["Capital", "Equity Partners", "Investments", "Holdings"],
  Manufacturing: ["Manufacturing", "Industries", "Fabrication", "Works"],
  "Financial services": ["Financial", "Bank", "Credit Union", "Trust"],
  "Legal services": ["Law Group", "Legal", "Attorneys", "Law"],
  Software: ["Software", "Labs", "Systems", "Cloud"],
  "Life sciences": ["Therapeutics", "Bio", "Pharma", "Sciences"],
  "Food and beverage": ["Foods", "Beverage Co", "Brands", "Kitchens"],
  Transportation: ["Transit", "Mobility", "Rides", "Transport"],
  Gambling: ["Gaming", "Casino Group"],
};
const JUNIOR = ["Operations Analyst", "Marketing Coordinator", "Project Manager", "Executive Assistant"];
const SENIOR_OTHER = ["Director of Marketing", "VP Sales", "Head of People"];
const FREE = ["gmail.com", "yahoo.com", "outlook.com"];

type LeadPlan = { offering: Offering; submittedAt: Date };

/** Show-up dips over the last three weeks so the scorecard has a real bottleneck to find. */
const showRateFor = (weeksAgo: number) => (weeksAgo <= 4 ? 0.4 : between(r, 0.72, 0.8));

async function seedHistory(db: ScopedDb, companyId: string, offerings: Offering[], salesUserIds: string[], caseIdsByOffering: Map<string, string[]>) {
  const thisMonday = weekStart(NOW);
  const firstMonday = addDays(thisMonday, -70);
  const weights = [
    ["ai-opportunity-map", 0.4],
    ["agentready-diagnostic", 0.28],
    ["smart-space-poc", 0.12],
    ["modernization-blueprint", 0.12],
    ["fde-sprint", 0.08],
  ] as const;
  const bySlug = new Map(offerings.map((o) => [o.slug, o]));
  const pickOffering = () => {
    let x = r();
    for (const [slug, w] of weights) { if ((x -= w) <= 0) return bySlug.get(slug)!; }
    return bySlug.get("ai-opportunity-map")!;
  };

  const plans: LeadPlan[] = [];
  for (let m = firstMonday; m <= thisMonday; m = addDays(m, 7)) {
    const partial = m.getTime() === thisMonday.getTime();
    const days = partial ? Math.max(1, Math.floor((NOW.getTime() - m.getTime()) / 86400000)) : 7;
    const n = partial ? Math.round(8 * days) : intBetween(r, 50, 62);
    for (let i = 0; i < n; i++) {
      const at = new Date(m.getTime() + r() * days * 86400000);
      if (at < NOW) plans.push({ offering: pickOffering(), submittedAt: at });
    }
  }

  let rr = 0;
  const count = { leads: 0, validated: 0, meetings: 0, won: 0 };
  for (const p of plans) {
    const o = p.offering;
    const industry = r() < 0.04 ? "Gambling" : r() < 0.04 ? null : pick(r, o.industries);
    const coName = `${pick(r, CO_A)} ${pick(r, CO_B[industry ?? "Professional services"] ?? ["Group"])}`;
    const slug = coName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const domain = `${slug}-${intBetween(r, 10, 99)}.com`;
    const first = pick(r, FIRST);
    const last = pick(r, LAST);
    const email = r() < 0.04 ? `${first.toLowerCase()}${last.toLowerCase()}${intBetween(r, 1, 99)}@${pick(r, FREE)}` : `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`;
    const sizeOut = r() < 0.08;
    const employees = sizeOut ? intBetween(r, 8, 80) : intBetween(r, 140, 2200);
    const revenueCents = sizeOut ? employees * 150_000 * 100 : Math.min(480 * M, Math.max(55 * M, employees * Math.round(between(r, 180_000, 260_000)) * 100));
    const roll = r();
    const title = roll < 0.06 ? pick(r, JUNIOR) : roll < 0.12 ? pick(r, SENIOR_OTHER) : pick(r, o.targetTitles);
    const t = r();
    const timeline = t < 0.2 ? "now" : t < 0.6 ? "3m" : t < 0.85 ? "6m" : t < 0.93 ? "12m" : "research";
    const openDeal = r() < 0.03;

    const checks: CheckOutcome[] = [
      checkWorkEmail(email, true),
      checkRange("company_size", employees, o.companySizeMin, o.companySizeMax, (x) => `${num(x)} employees`),
      checkRange("revenue", revenueCents, Number(o.revenueMinCents), Number(o.revenueMaxCents), (x) => money(x, "USD", { compact: true })),
      checkIndustry(industry, domain, o.industries, o.excludedCategories, o.excludedDomains),
      checkRole(title, o.targetTitles),
      checkTimeline(timeline, o.timelineWindowDays),
      checkNotExisting({ existingCustomer: false, openDeal, detail: openDeal ? "Open deal already in the CRM." : undefined }),
    ];
    const decision = decide(checks);
    const validatedAt = new Date(p.submittedAt.getTime() + intBetween(r, 40, 110) * 1000);
    const ownerUserId = salesUserIds[rr++ % salesUserIds.length]!;
    const note = mockLeadResearch({
      lead: { name: `${first} ${last}`, title, email, companyName: coName, timeline },
      profile: { name: coName, employees, revenue: money(revenueCents, "USD", { compact: true }), industry, hq: pick(r, ["Charlotte, NC", "Atlanta, GA", "Dallas, TX", "Chicago, IL", "Denver, CO", "Raleigh, NC", "Columbus, OH", "Nashville, TN"]) },
      website: null,
      offering: { name: o.name, promise: o.promise },
    }).note;

    const lead = await db.lead.create({
      data: {
        companyId, offeringId: o.id, email, firstName: first, lastName: last, title, companyName: coName, domain, phone: r() < 0.6 ? `+1555${intBetween(r, 1000000, 9999999)}` : null, smsConsent: r() < 0.5,
        timelineAnswer: timeline, status: decision.status, decisionReason: decision.reason, researchNote: note, ownerUserId,
        hubspotContactId: `hs_c_${lead_id()}`, submittedAt: p.submittedAt, validatedAt,
      },
    });
    await db.leadCheck.createMany({ data: checks.map((c) => ({ companyId, leadId: lead.id, check: c.check, result: c.result, reason: c.reason, evidence: json(c.evidence ?? {}) })) });
    count.leads++;

    // Some review-queue leads get resolved by a human.
    if (decision.status === "REVIEW" && p.submittedAt < addDays(NOW, -3) && r() < 0.6) {
      const to = r() < 0.6 ? "VALIDATED" : "NOT_QUALIFIED";
      await db.lead.update({ where: { id: lead.id }, data: { overrideStatus: to, overrideReason: to === "VALIDATED" ? "Checked LinkedIn: right company size and buyer." : "Not a fit after a quick look.", overrideById: ownerUserId, overrideAt: addDays(validatedAt, 1) } });
      if (to !== "VALIDATED") continue;
    } else if (decision.status !== "VALIDATED") continue;
    count.validated++;

    // Booking link touch.
    await db.meetingTouch.create({ data: { companyId, leadId: lead.id, kind: "booking_link", channel: "EMAIL", dueAt: validatedAt, sentAt: validatedAt, status: "SENT", subject: `${first}, pick a time to talk`, body: `Hi ${first}, thanks for reaching out about ${o.name}. Pick a 30 minute slot that suits you.` } });
    if (r() > 0.78) continue; // never booked

    const weeksAgo = Math.floor((thisMonday.getTime() - weekStart(p.submittedAt).getTime()) / (7 * 86400000));
    let discAt = businessHour(addDays(p.submittedAt, intBetween(r, 2, 6)));
    const caseIds = caseIdsByOffering.get(o.id) ?? [];
    const caseStudyId = caseIds.length ? pick(r, caseIds) : null;
    let disc = await makeMeeting(db, companyId, lead.id, "DISCOVERY", discAt, addDays(validatedAt, 0), caseStudyId, showRateFor(weeksAgo));
    count.meetings++;
    if (disc.status === "NO_SHOW" && r() < 0.45) {
      discAt = businessHour(addDays(discAt, intBetween(r, 3, 6)));
      await db.meeting.update({ where: { id: disc.id }, data: { status: "REBOOKED" } });
      const again = await makeMeeting(db, companyId, lead.id, "DISCOVERY", discAt, addDays(disc.scheduledAt, 1), caseStudyId, 0.6, disc.id);
      disc = again;
    }
    if (disc.status !== "HELD") continue;
    if (r() > 0.45) continue; // not qualified

    const amount = o.slug === "smart-space-poc" ? pick(r, [2_500_000, 3_500_000, 4_500_000]) : o.dealSizeCents ?? 1_000_000;
    const qualifiedAt = addDays(disc.scheduledAt, 1);
    if (qualifiedAt > NOW) continue;
    const deal = await db.dealLink.create({ data: { companyId, leadId: lead.id, hubspotDealId: `hs_d_${lead_id()}`, stage: "Qualified", amountCents: amount, qualifiedAt } });
    const salesAt = businessHour(addDays(qualifiedAt, intBetween(r, 4, 9)));
    const sales = await makeMeeting(db, companyId, lead.id, "SALES", salesAt, qualifiedAt, null, 0.86);
    if (sales.status !== "HELD") { if (sales.scheduledAt < NOW) await db.dealLink.update({ where: { id: deal.id }, data: { stage: "Stalled" } }); continue; }
    const closeAt = addDays(sales.scheduledAt, intBetween(r, 6, 18));
    if (closeAt > NOW) { await db.dealLink.update({ where: { id: deal.id }, data: { stage: "Proposal" } }); continue; }
    const won = r() < 0.3;
    await db.dealLink.update({ where: { id: deal.id }, data: { stage: won ? "Closed won" : "Closed lost", closedAt: closeAt, isWon: won, conversionSentAt: won && closeAt < addDays(NOW, -2) ? addDays(closeAt, 1) : null } });
    if (won) count.won++;
  }
  console.log(`  history: ${count.leads} leads, ${count.validated} validated, ${count.meetings} discovery calls, ${count.won} won`);
}

let idCounter = 1000;
const lead_id = () => (idCounter++).toString(36) + Math.floor(r() * 1e6).toString(36);

function businessHour(d: Date) {
  const x = new Date(d);
  const dow = x.getUTCDay();
  if (dow === 0) x.setUTCDate(x.getUTCDate() + 1);
  if (dow === 6) x.setUTCDate(x.getUTCDate() + 2);
  x.setUTCHours(intBetween(r, 14, 21), pick(r, [0, 30]), 0, 0); // 10am to 5pm Eastern
  return x;
}

async function makeMeeting(db: ScopedDb, companyId: string, leadId: string, type: "DISCOVERY" | "SALES", scheduledAt: Date, bookedAt: Date, caseStudyId: string | null, showRate: number, rebookOfId?: string) {
  const past = scheduledAt < NOW;
  const status = !past ? "BOOKED" : r() < showRate ? "HELD" : r() < 0.06 ? "CANCELLED" : "NO_SHOW";
  const m = await db.meeting.create({ data: { companyId, leadId, type, status, scheduledAt, bookedAt, heldAt: status === "HELD" ? scheduledAt : null, caseStudyId, rebookOfId: rebookOfId ?? null, hubspotMeetingId: `hs_m_${lead_id()}` } });
  const label = type === "DISCOVERY" ? "discovery call" : "call";
  const touches = [
    { kind: "confirmation", dueAt: bookedAt, subject: `Confirmed: ${label}`, body: `You're booked. A calendar invite is on its way.` },
    { kind: "reminder_24h", dueAt: addDays(scheduledAt, -1), subject: `Reminder: ${label} tomorrow`, body: `A reminder about our ${label} tomorrow.` },
    { kind: "reminder_1h", dueAt: new Date(scheduledAt.getTime() - 3600_000), subject: `Reminder: ${label} in 1 hour`, body: `A reminder about our ${label} in one hour.` },
    ...(caseStudyId ? [{ kind: "precall_note", dueAt: addDays(scheduledAt, -1), subject: "Before we talk: a story from a company like yours", body: "Ahead of our call, here is a short case study." }] : []),
  ];
  await db.meetingTouch.createMany({
    data: touches.map((t) => {
      const dueAt = t.dueAt < bookedAt ? bookedAt : t.dueAt;
      const sent = dueAt <= NOW && status !== "CANCELLED";
      return { companyId, leadId, meetingId: m.id, kind: t.kind, channel: "EMAIL" as const, dueAt, subject: t.subject, body: t.body, status: sent ? ("SENT" as const) : status === "BOOKED" ? ("SCHEDULED" as const) : ("SKIPPED" as const), sentAt: sent ? dueAt : null };
    }),
  });
  if (status === "NO_SHOW") {
    await db.meetingTouch.createMany({
      data: [0, 3, 7].map((d, i) => {
        const dueAt = addDays(scheduledAt, d);
        return { companyId, leadId, meetingId: m.id, kind: `rebook_${i + 1}`, channel: "EMAIL" as const, dueAt, subject: ["Sorry we missed you", "Still want to talk?", "Last note from me"][i]!, body: "Grab another time that works.", status: dueAt <= NOW ? ("SENT" as const) : ("SCHEDULED" as const), sentAt: dueAt <= NOW ? dueAt : null };
      }),
    });
  }
  return m;
}

// ---------- Main ----------

async function main() {
  console.log("Seeding...");
  await reset();

  const taazaa = await createCompany("taazaa", "Taazaa");
  const zach = await unscopedDb.user.create({ data: { email: "zach.wiant@taazaa.com", name: "Zach Wiant", isAdmin: true } });
  const operator = await unscopedDb.user.create({ data: { email: "operator@taazaa.test", name: "Sample Operator" } });
  const sdr = await unscopedDb.user.create({ data: { email: "sdr@taazaa.test", name: "Sample SDR" } });
  const ae = await unscopedDb.user.create({ data: { email: "ae@taazaa.test", name: "Sample AE" } });
  await unscopedDb.membership.createMany({
    data: [
      { companyId: taazaa.id, userId: zach.id, role: "OWNER" },
      { companyId: taazaa.id, userId: operator.id, role: "OPERATOR" },
      { companyId: taazaa.id, userId: sdr.id, role: "SALES" },
      { companyId: taazaa.id, userId: ae.id, role: "SALES" },
    ],
  });

  const db = scopedDb(taazaa.id);
  const cases = new Map<string, string>();
  for (const c of CASES) {
    const row = await db.caseStudy.create({ data: { ...c, companyId: taazaa.id } });
    cases.set(c.client, row.id);
  }
  const offerings: Offering[] = [];
  const caseIdsByOffering = new Map<string, string[]>();
  for (const { cases: names, ...o } of OFFERINGS) {
    const row = await db.offering.create({ data: { ...o, companyId: taazaa.id, approvedById: o.status === "APPROVED" ? zach.id : null } });
    const ids = names.map((n) => cases.get(n)!).filter(Boolean);
    for (const id of ids) await db.offeringCaseStudy.create({ data: { companyId: taazaa.id, offeringId: row.id, caseStudyId: id } });
    caseIdsByOffering.set(row.id, ids);
    offerings.push(row);
  }
  console.log(`  ${offerings.length} offerings, ${CASES.length} case studies`);

  // Segments through the real generation path (mock Claude + mock enrichment).
  const ctx = { db, company: { id: taazaa.id, slug: "taazaa", name: "Taazaa", currency: "USD" }, user: { id: zach.id, name: zach.name, email: zach.email, isAdmin: true }, role: "OWNER" as const, can: () => true } satisfies CompanyContext;
  for (const o of offerings.filter((x) => x.status === "APPROVED")) await generateSegments(ctx, o.id);
  const segByKey = async (key: string) => db.segment.findFirstOrThrow({ where: { key } });
  const status: [string, "ACTIVE" | "SHORTLISTED" | "REJECTED"][] = [
    ["om-cre-ops", "ACTIVE"], ["om-mf-reporting", "ACTIVE"], ["om-3pl", "SHORTLISTED"], ["om-pe-portco", "SHORTLISTED"], ["om-mfg", "REJECTED"],
    ["ar-health-cio", "ACTIVE"], ["ar-proptech-cto", "ACTIVE"], ["ar-eu-exposure", "SHORTLISTED"], ["ar-bank-ciso", "REJECTED"],
    ["ss-pe-diligence", "SHORTLISTED"], ["ss-re-fund-memos", "SHORTLISTED"],
  ];
  for (const [key, s] of status) await setSegmentStatus(ctx, (await segByKey(key)).id, s);
  await overrideFactor(ctx, (await segByKey("om-pe-portco")).id, "urgency", 6, "Funds we talk to are not prioritizing AI until Q1.");
  await overrideFactor(ctx, (await segByKey("om-mf-reporting")).id, "delivery_fit", 10, "We built the Real Estate Hub; this is squarely our work.");
  console.log("  segments generated, statuses and two overrides set");

  // Message tests: one finished batch with decisions, one approved and ready to launch, one draft.
  const defaults = defaultSettings().testDefaults;
  const settings = { channel: "meta" as const, budgetCents: defaults.budgetCents, durationHours: defaults.durationHours, targetCtr: defaults.targetCtr, targetCpcCents: defaults.targetCpcCents, minImpressions: defaults.minImpressions, statementCount: 14 };
  const cre = await segByKey("om-cre-ops");
  const b1 = await createBatch(ctx, cre.id, { ...settings, name: "Batch 1" });
  await approveBatch(ctx, b1);
  const launched = addDays(NOW, -18);
  const stmts = await db.statement.findMany({ where: { batchId: b1 } });
  for (const s of stmts) await db.statement.update({ where: { id: s.id }, data: { externalId: `meta_mock_${s.id}` } });
  await db.batch.update({ where: { id: b1 }, data: { status: "RUNNING", launchedAt: launched, endsAt: new Date(launched.getTime() + 72 * 3600_000) } });
  await collectResults(db, taazaa.id, b1);
  await db.batch.update({ where: { id: b1 }, data: { completedAt: addDays(launched, 3) } });
  const results = await db.statement.findMany({ where: { batchId: b1 }, include: { result: true, batch: true } });
  const { verdict } = await import("../src/lib/verdict");
  let rewrites = 0;
  for (const s of results) {
    const v = verdict(s.result, s.batch);
    if (v.status === "pass") await decideStatement(ctx, s.id, "KEEP");
    else if (v.status === "not_enough_data") await decideStatement(ctx, s.id, "RETEST");
    else if (rewrites++ < 2) await decideStatement(ctx, s.id, "REWRITE");
    else await decideStatement(ctx, s.id, "DROP");
  }
  const health = await segByKey("ar-health-cio");
  const b2 = await createBatch(ctx, health.id, { ...settings, statementCount: 12, name: "Batch 1" });
  await approveBatch(ctx, b2);
  await createBatch(ctx, (await segByKey("om-mf-reporting")).id, { ...settings, statementCount: 12, name: "Batch 1" });
  console.log("  message tests: 1 complete with decisions, 1 approved, 1 draft, 1 retest draft");

  // Pipeline history, then scorecard weeks and diagnoses through the real services.
  await seedHistory(db, taazaa.id, offerings, [sdr.id, ae.id], caseIdsByOffering);
  const thisMonday = weekStart(NOW);
  await buildWeeks(db, taazaa.id, addDays(thisMonday, -70), NOW);
  for (const back of [3, 2, 1]) {
    const w = await db.week.findFirst({ where: { startDate: addDays(thisMonday, -7 * back) } });
    if (w) await diagnoseWeek(db, taazaa.id, w.id);
  }
  // Earlier fixes partly done, so carry-over shows.
  const older = await db.fix.findMany({ where: { diagnosis: { week: { startDate: { lt: addDays(thisMonday, -7) } } } }, orderBy: { createdAt: "asc" } });
  for (const [i, f] of older.entries()) if (i % 2 === 0) await db.fix.update({ where: { id: f.id }, data: { done: true, doneAt: addDays(NOW, -5), doneById: operator.id } });
  console.log("  scorecard: 11 weeks built, 3 diagnoses");

  // Funnel scenarios for the Opportunity Map.
  const om = offerings.find((o) => o.slug === "ai-opportunity-map")!;
  const { funnelDefaults } = await import("../src/server/funnel");
  const base = (await funnelDefaults(db, taazaa.id, om.id)).inputs;
  const withExp = { ...base, expansion: { rate: 0.4, valueCents: 3_500_000, margin: 0.5 } };
  await db.funnelScenario.createMany({
    data: [
      { companyId: taazaa.id, offeringId: om.id, name: "Today, from history", inputs: json(withExp), createdBy: zach.name },
      { companyId: taazaa.id, offeringId: om.id, name: "Show-up back to 75%", inputs: json({ ...withExp, discoveryShowRate: 0.75 }), createdBy: zach.name },
      { companyId: taazaa.id, offeringId: om.id, name: "Sharper ads, 1.6% clickthrough", inputs: json({ ...withExp, ctr: 0.016, discoveryShowRate: 0.75 }), createdBy: zach.name },
    ],
  });

  // Buyers: default signal rules on every offering, one saved weekly pull per approved offering run
  // through the same service as the app (mock prospect source), and one buyer moved into outreach.
  const { defaultRulesFor } = await import("../src/lib/signalRules");
  const buyers = await import("../src/server/buyers");
  for (const o of offerings) await db.offering.update({ where: { id: o.id }, data: { signalRules: json(defaultRulesFor(o.slug)) } });
  for (const o of offerings.filter((x) => x.status === "APPROVED")) {
    const fresh = await db.offering.findUniqueOrThrow({ where: { id: o.id } });
    const s = await db.prospectSearch.create({ data: { companyId: taazaa.id, name: `${o.name}: target buyers`, offeringId: o.id, filters: json(buyers.filtersFor(fresh)), maxCompanies: 25, schedule: "weekly", createdBy: zach.name } });
    await buyers.runSearch(db, taazaa.id, s.id);
  }
  const topBuyer = await db.account.findFirst({ where: { tier: "act_now" }, orderBy: { bestTotal: "desc" }, include: { contacts: { where: { isPrimary: true } } } });
  if (topBuyer?.contacts[0]) await buyers.startOutreach(ctx, topBuyer.id, topBuyer.contacts[0].id);
  const tiers = await buyers.tierCounts(db);
  console.log(`  buyers: ${await db.account.count()} accounts, ${await db.signal.count()} signals, ${await db.contact.count()} contacts; tiers ${JSON.stringify(tiers)}`);

  // A few fresh form fills run through the real validation agent.
  for (const s of SAMPLE_SUBMISSIONS.slice(0, 8)) {
    const { label: _label, offering, ...f } = s;
    void _label;
    const o = offerings.find((x) => x.slug === offering);
    const lead = await db.lead.create({ data: { companyId: taazaa.id, offeringId: o?.id ?? null, email: f.email, firstName: f.firstName, lastName: f.lastName, title: f.title, companyName: f.company, domain: f.email.split("@")[1], smsConsent: f.smsConsent, phone: f.smsConsent ? "+15555550142" : null, timelineAnswer: f.timeline, submittedAt: new Date(NOW.getTime() - intBetween(r, 5, 300) * 60_000) } });
    await validateLead(db, taazaa.id, lead.id);
  }
  // One of them books a discovery call for later this week.
  const dana = await db.lead.findFirst({ where: { email: "dana.reyes@keystone-ridge-properties.com" } });
  if (dana) {
    const { bookMeeting } = await import("../src/server/meetings");
    await bookMeeting(db, taazaa.id, dana.id, businessHour(addDays(NOW, 2)));
  }
  console.log("  8 fresh leads validated by the agent");

  // Second company, to prove isolation.
  const nw = await createCompany("northwind", "Northwind Sample Co");
  const nwOwner = await unscopedDb.user.create({ data: { email: "owner@northwind.test", name: "Northwind Owner" } });
  await unscopedDb.membership.create({ data: { companyId: nw.id, userId: nwOwner.id, role: "OWNER" } });
  const ndb = scopedDb(nw.id);
  await ndb.offering.create({ data: { companyId: nw.id, slug: "fractional-cfo", name: "Fractional CFO Retainer", promise: "A part-time CFO who closes your books in five days and builds the board pack.", priceMinCents: 600_000, priceMaxCents: 1_200_000, dealSizeCents: 900_000, grossMargin: 0.45, salesCycleDays: 30, targetTitles: ["CEO", "Founder"], industries: ["Software", "Professional services"], regions: REGION, companySizeMin: 20, companySizeMax: 200, status: "DRAFT" } });
  await ndb.caseStudy.create({ data: { companyId: nw.id, title: "Board pack in five days", client: "Sample client", industry: "Software", result: "Close from 15 days to 5." } });
  console.log("  second company: Northwind Sample Co");
  console.log("Done. Sign in at http://localhost:4240 as zach.wiant@taazaa.com (dev sign-in).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => unscopedDb.$disconnect());
