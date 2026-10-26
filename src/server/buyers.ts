// Buyers: pull companies from a prospect source, read their buying signals, find the people, match
// every account to every approved offering, and brief the best ones. Then act: owner, HubSpot, outreach.

import { z } from "zod";
import { Prisma, type AccountStatus, type Offering } from "@prisma/client";
import type { ScopedDb } from "@/lib/db";
import { unscopedDb } from "@/lib/db";
import type { CompanyContext } from "./context";
import { prospectsAdapter, maxCreditsPerRun, emptyFilters, ApolloCreditsError, type CompanyDetail, type JobPosting, type NewsItem, type ProspectAdapter, type ProspectCompany, type ProspectFilters } from "@/integrations/prospects";
import { bestMatch, DEFAULT_MATCH_WEIGHTS, industryMatches, matchAccount, titleMatches, type MatchOffering, type RuleHit, type SignalRule, type SignalType, type Tier } from "@/lib/matching";
import { defaultRulesFor } from "@/lib/signalRules";
import { bestResearch, higherTier } from "@/lib/research";
import { exclusionFor, industryFor, rangeMid, vibeSignals, type VibeCompany } from "@/integrations/prospects/vibe";
import { seniority, type VibePerson } from "@/integrations/prospects/vibeExport";
import { runAi } from "@/ai/run";
import { accountBriefTask } from "@/ai/accountBrief";
import { outreachSequenceTask } from "@/ai/outreachSequence";
import { money, relative } from "@/lib/format";
import { enqueue, QUEUES } from "@/jobs/queue";
import { startShowUpSequence } from "./meetings";
import { audit } from "./audit";

const DAY = 86400_000;

// ---------- Settings and rules ----------

export type BuyerSettings = { fitWeight: number; signalWeight: number; briefLimit: number; lookbackDays: number; takeOverOwnership: boolean };
export const DEFAULT_BUYER_SETTINGS: BuyerSettings = { fitWeight: DEFAULT_MATCH_WEIGHTS.fit, signalWeight: DEFAULT_MATCH_WEIGHTS.signal, briefLimit: 15, lookbackDays: 180, takeOverOwnership: true };

export async function buyerSettings(db: ScopedDb): Promise<BuyerSettings> {
  const s = await db.settings.findFirst({ select: { buyers: true } });
  const raw = (s?.buyers ?? {}) as Partial<BuyerSettings>;
  return { ...DEFAULT_BUYER_SETTINGS, ...raw };
}

const RuleSchema = z.object({
  id: z.string(),
  type: z.enum(["intent", "leadership", "funding", "news", "risk", "hiring", "growth", "workforce", "tech"]),
  label: z.string(),
  match: z.array(z.string()),
  weight: z.number().min(0).max(100),
  min: z.number().optional(),
  why: z.string().optional(),
});
export const SignalRulesSchema = z.array(RuleSchema);

export function rulesFor(o: Pick<Offering, "slug" | "signalRules">): SignalRule[] {
  const parsed = SignalRulesSchema.safeParse(o.signalRules);
  return parsed.success && parsed.data.length ? parsed.data : defaultRulesFor(o.slug);
}

export async function saveSignalRules(ctx: CompanyContext, offeringId: string, rules: SignalRule[]) {
  const parsed = SignalRulesSchema.parse(rules);
  await ctx.db.offering.update({ where: { id: offeringId }, data: { signalRules: parsed as unknown as Prisma.InputJsonValue } });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "offering.signalRules", entity: "offering", entityId: offeringId, data: { count: parsed.length } });
  await enqueue(QUEUES.buyersRematch, { companyId: ctx.company.id });
}

function toMatchOffering(o: Offering): MatchOffering {
  return {
    id: o.id,
    industries: o.industries,
    excludedCategories: o.excludedCategories,
    excludedDomains: o.excludedDomains,
    companySizeMin: o.companySizeMin,
    companySizeMax: o.companySizeMax,
    revenueMinCents: o.revenueMinCents != null ? Number(o.revenueMinCents) : null,
    revenueMaxCents: o.revenueMaxCents != null ? Number(o.revenueMaxCents) : null,
    regions: o.regions,
    targetTitles: o.targetTitles,
    signalRules: rulesFor(o),
  };
}

// ---------- Searches ----------

export const FiltersSchema = z.object({
  industries: z.array(z.string()).default([]),
  employeeMin: z.number().int().nonnegative().nullable().optional(),
  employeeMax: z.number().int().nonnegative().nullable().optional(),
  revenueMinCents: z.number().nonnegative().nullable().optional(),
  revenueMaxCents: z.number().nonnegative().nullable().optional(),
  locations: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  hiringTitles: z.array(z.string()).default([]),
  technologies: z.array(z.string()).default([]),
  titles: z.array(z.string()).default([]),
  excludeDomains: z.array(z.string()).default([]),
});

export const SearchInput = z.object({
  name: z.string().trim().min(2),
  offeringId: z.string().nullable().optional(),
  segmentId: z.string().nullable().optional(),
  filters: FiltersSchema,
  maxCompanies: z.number().int().min(1).max(200).default(25),
  schedule: z.enum(["off", "daily", "weekly"]).default("off"),
});

/** Starting filters for a pull, from an offering and optionally one of its segments. */
export function filtersFor(o: Offering, segment?: { industry: string | null } | null): ProspectFilters {
  return {
    ...emptyFilters(),
    industries: segment?.industry ? [segment.industry] : o.industries,
    employeeMin: o.companySizeMin,
    employeeMax: o.companySizeMax,
    revenueMinCents: o.revenueMinCents != null ? Number(o.revenueMinCents) : null,
    revenueMaxCents: o.revenueMaxCents != null ? Number(o.revenueMaxCents) : null,
    locations: o.regions,
    titles: o.targetTitles,
    excludeDomains: o.excludedDomains,
  };
}

export async function saveSearch(ctx: CompanyContext, id: string | null, input: z.infer<typeof SearchInput>) {
  const data = { name: input.name, offeringId: input.offeringId ?? null, segmentId: input.segmentId ?? null, filters: input.filters as unknown as Prisma.InputJsonValue, maxCompanies: input.maxCompanies, schedule: input.schedule };
  if (input.offeringId) await ctx.db.offering.findUniqueOrThrow({ where: { id: input.offeringId } });
  if (id) {
    await ctx.db.prospectSearch.update({ where: { id }, data });
    return id;
  }
  const s = await ctx.db.prospectSearch.create({ data: { ...data, companyId: ctx.company.id, createdBy: ctx.user.name } });
  return s.id;
}

export async function deleteSearch(ctx: CompanyContext, id: string) {
  await ctx.db.prospectSearch.delete({ where: { id } });
}

/** What a pull of this size would cost, and how many companies the credit cap allows. */
export function pullEstimate(maxCompanies: number, adapter: ProspectAdapter = prospectsAdapter()) {
  const cap = maxCreditsPerRun();
  let n = maxCompanies;
  while (n > 1 && adapter.estimateCredits(n) > cap) n--;
  return { requested: maxCompanies, allowed: n, credits: adapter.estimateCredits(n), cap, live: adapter.mode === "live", provider: adapter.provider };
}

export async function queueSearch(ctx: CompanyContext, searchId: string) {
  const s = await ctx.db.prospectSearch.findUniqueOrThrow({ where: { id: searchId } });
  if (s.status === "running") throw new Error("This pull is already running.");
  if (s.provider === "vibe") throw new Error("Vibe pulls run through the Vibe connector in Claude for now. Ask Claude to refresh this one.");
  await ctx.db.prospectSearch.update({ where: { id: searchId }, data: { status: "running", error: null } });
  await enqueue(QUEUES.buyersSearch, { companyId: ctx.company.id, searchId, userId: ctx.user.id }, { singletonKey: `search:${searchId}` });
}

/** The pull itself. Runs as a background job. */
export async function runSearch(db: ScopedDb, companyId: string, searchId: string, now = new Date()) {
  const search = await db.prospectSearch.findUniqueOrThrow({ where: { id: searchId } });
  if (search.provider === "vibe") return; // imported with scripts/import-vibe.mts, never re-run against Apollo
  const adapter = prospectsAdapter();
  const filters = FiltersSchema.parse(search.filters) as ProspectFilters;
  const est = pullEstimate(search.maxCompanies, adapter);
  let credits = 0;
  try {
    await db.prospectSearch.update({ where: { id: searchId }, data: { status: "running", error: null } });
    const found = await adapter.searchCompanies(filters, est.allowed);
    credits += found.credits;
    const titles = filters.titles.length ? filters.titles : await allTargetTitles(db);
    const touched: string[] = [];
    let created = 0;
    let stopped: string | null = null;
    for (const c of found.companies) {
      try {
        const r = await ingestCompany(db, companyId, adapter, c, titles, now);
        credits += r.credits;
        if (r.created) created++;
        touched.push(r.accountId);
      } catch (e) {
        // Out of credits: stop now and keep what we have, instead of failing company by company.
        if (e instanceof ApolloCreditsError) {
          stopped = e.message;
          break;
        }
        console.error("[buyers] ingest failed", c.domain, (e as Error).message);
      }
    }
    if (!stopped) {
      try {
        credits += await ingestNews(db, companyId, adapter, touched, now);
      } catch (e) {
        if (e instanceof ApolloCreditsError) stopped = e.message;
        else throw e;
      }
    }
    // Also score anything left unscored, e.g. a company half-saved when credits ran out mid-way.
    const unscored = (await db.account.findMany({ where: { matchedAt: null }, select: { id: true } })).map((x) => x.id);
    await matchAccounts(db, companyId, [...new Set([...touched, ...unscored])], now);
    await briefTop(db, companyId, touched);
    await db.prospectSearch.update({
      where: { id: searchId },
      data: { status: stopped ? "error" : "done", error: stopped ? `${stopped} Got ${touched.length} of ${found.companies.length} companies before stopping.` : null, lastRunAt: now, lastRunFound: found.companies.length, lastRunNew: created, lastRunCredits: credits },
    });
    await audit(db, companyId, { action: "buyers.pull", entity: "search", entityId: searchId, data: { found: found.companies.length, created, credits, provider: adapter.provider } });
  } catch (e) {
    await db.prospectSearch.update({ where: { id: searchId }, data: { status: "error", error: (e as Error).message.slice(0, 300), lastRunCredits: credits } });
    throw e;
  }
}

export async function allTargetTitles(db: ScopedDb) {
  const os = await db.offering.findMany({ where: { status: "APPROVED" }, select: { targetTitles: true } });
  return [...new Set(os.flatMap((o) => o.targetTitles))];
}

type SignalDraft = { type: SignalType; title: string; detail?: string | null; url?: string | null; value?: number | null; occurredAt: Date; externalId: string };

export function signalsFromDetail(d: CompanyDetail, now: Date): SignalDraft[] {
  const out: SignalDraft[] = [];
  if (d.headcountGrowth6m != null && d.headcountGrowth6m >= 0.05) {
    out.push({ type: "growth", title: `Headcount up ${Math.round(d.headcountGrowth6m * 100)}% in six months`, value: d.headcountGrowth6m, occurredAt: now, externalId: "growth-6m" });
  }
  for (const f of d.funding) {
    const at = new Date(f.date);
    if (Number.isNaN(at.getTime()) || now.getTime() - at.getTime() > 540 * DAY) continue;
    out.push({ type: "funding", title: `Raised ${f.amountCents ? money(f.amountCents, "USD", { compact: true }) : "new funding"}${f.type ? ` (${f.type})` : ""}`, url: f.url, occurredAt: at, externalId: `funding:${f.id}` });
  }
  return out;
}

export function signalsFromJobs(jobs: JobPosting[]): SignalDraft[] {
  return jobs.map((j) => ({ type: "hiring" as const, title: `Hiring: ${j.title}`, detail: j.location, url: j.url, occurredAt: new Date(j.postedAt), externalId: `job:${j.id}` }));
}

export function classifyNews(n: Pick<NewsItem, "title" | "categories">): SignalType {
  const cats = n.categories.map((c) => c.toLowerCase());
  if (cats.some((c) => /hire|leadership|executive/.test(c)) || /\b(names|appoints|hires|joins as|new (chief|ceo|coo|cio|cto|president)|to retire|retires|steps down)\b/i.test(n.title)) return "leadership";
  if (cats.some((c) => /invest|fund/.test(c)) || /\b(raises|secures|funding|investment)\b/i.test(n.title)) return "funding";
  return "news";
}

async function upsertSignals(db: ScopedDb, companyId: string, accountId: string, source: string, drafts: SignalDraft[]) {
  for (const s of drafts) {
    if (Number.isNaN(s.occurredAt.getTime())) continue;
    await db.signal.upsert({
      where: { accountId_source_externalId: { accountId, source, externalId: s.externalId } },
      create: { companyId, accountId, source, ...s },
      // Growth is re-read on every refresh; keep the date it was first seen so it ages like other signals.
      update: { title: s.title, detail: s.detail ?? null, url: s.url ?? null, value: s.value ?? null, ...(s.type === "growth" ? {} : { occurredAt: s.occurredAt }) },
    });
  }
}

/** Create or refresh one account: firmographics, hiring, derived signals, and buyer contacts. */
export async function ingestCompany(db: ScopedDb, companyId: string, adapter: ProspectAdapter, c: ProspectCompany, titles: string[], now: Date) {
  let credits = 0;
  const existing = await db.account.findFirst({ where: { domain: c.domain } });
  const ref = { externalId: existing?.externalId ?? c.externalId, domain: c.domain };
  const { detail, credits: ec } = await adapter.enrichCompany(ref);
  credits += ec;
  const base = {
    name: detail?.name ?? c.name,
    industry: detail?.industry ?? null,
    employees: detail?.employees ?? null,
    revenueCents: detail?.revenueCents != null ? BigInt(detail.revenueCents) : null,
    city: detail?.city ?? null,
    state: detail?.state ?? null,
    country: detail?.country ?? null,
    websiteUrl: detail?.websiteUrl ?? c.websiteUrl ?? null,
    linkedinUrl: detail?.linkedinUrl ?? c.linkedinUrl ?? null,
    description: detail?.description ?? null,
    technologies: detail?.technologies ?? [],
    keywords: detail?.keywords ?? [],
    headcountGrowth6m: detail?.headcountGrowth6m ?? null,
    foundedYear: detail?.foundedYear ?? c.foundedYear ?? null,
    enrichedAt: now,
  };
  const account = existing
    ? await db.account.update({ where: { id: existing.id }, data: { ...base, externalId: ref.externalId } })
    : await db.account.create({ data: { ...base, companyId, domain: c.domain, source: adapter.provider, externalId: c.externalId } });

  const { jobs, credits: jc } = await adapter.jobPostings(ref.externalId, c.domain);
  credits += jc;
  await upsertSignals(db, companyId, account.id, adapter.provider, [...(detail ? signalsFromDetail(detail, now) : []), ...signalsFromJobs(jobs)]);

  const { people } = await adapter.searchPeople(ref, titles);
  for (const p of people) {
    await db.contact.upsert({
      where: { accountId_source_externalId: { accountId: account.id, source: adapter.provider, externalId: p.externalId } },
      create: { companyId, accountId: account.id, source: adapter.provider, externalId: p.externalId, firstName: p.firstName, lastName: p.lastName, title: p.title, seniority: p.seniority, linkedinUrl: p.linkedinUrl },
      update: { title: p.title, seniority: p.seniority },
    });
  }
  await db.account.update({ where: { id: account.id }, data: { signalsAt: now } });
  return { accountId: account.id, created: !existing, credits };
}

async function ingestNews(db: ScopedDb, companyId: string, adapter: ProspectAdapter, accountIds: string[], now: Date) {
  if (accountIds.length === 0) return 0;
  const accounts = await db.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, externalId: true, domain: true } });
  const orgs = accounts.filter((a) => a.externalId).map((a) => ({ externalId: a.externalId!, domain: a.domain }));
  const { lookbackDays } = await buyerSettings(db);
  const { items, credits } = await adapter.news(orgs, new Date(now.getTime() - lookbackDays * DAY).toISOString());
  for (const n of items) {
    for (const orgId of n.orgIds) {
      const a = accounts.find((x) => x.externalId === orgId);
      if (!a) continue;
      await upsertSignals(db, companyId, a.id, adapter.provider, [{ type: classifyNews(n), title: n.title, detail: n.snippet, url: n.url, occurredAt: new Date(n.publishedAt), externalId: `news:${n.id}` }]);
    }
  }
  return credits;
}

// ---------- Matching ----------

export type MatchReasons = { fit: { key: string; label: string; points: number; max: number; note: string }[]; signals: RuleHit[]; disqualified: string | null };

/** Score accounts against every approved offering and store the best on the account. */
/** Who to approach first at an account: a title the offer targets, then seniority, then a verified email. */
export function pickPrimary<T extends { title: string | null; emailStatus?: string | null }>(contacts: T[], targetTitles: string[]): T | undefined {
  const rank = (c: T) => (titleMatches(c.title, targetTitles) ? 100 : 0) + seniority(c.title) + (c.emailStatus === "valid" ? 5 : 0);
  return [...contacts].sort((x, y) => rank(y) - rank(x))[0];
}

export async function matchAccounts(db: ScopedDb, companyId: string, accountIds?: string[], now = new Date()) {
  const [offerings, settings, segments, buckets] = await Promise.all([
    db.offering.findMany({ where: { status: "APPROVED" } }),
    buyerSettings(db),
    db.segment.findMany({ where: { status: { in: ["ACTIVE", "SHORTLISTED"] } }, select: { id: true, offeringId: true, industry: true, status: true } }),
    db.bucket.findMany({ select: { id: true, slug: true } }),
  ]);
  const bucketSlug = new Map(buckets.map((b) => [b.id, b.slug]));
  const offerBucket = new Map(offerings.map((o) => [o.id, o.bucketId ? (bucketSlug.get(o.bucketId) ?? null) : null]));
  const weights = { fit: settings.fitWeight, signal: settings.signalWeight };
  const accounts = await db.account.findMany({ where: accountIds ? { id: { in: accountIds } } : {}, include: { signals: true, contacts: true } });
  const mo = offerings.map((o) => ({ o, m: toMatchOffering(o) }));
  for (const a of accounts) {
    const ma = { domain: a.domain, industry: a.industry, employees: a.employees, revenueCents: a.revenueCents != null ? Number(a.revenueCents) : null, country: a.country, technologies: a.technologies, excluded: a.excludedOverride ? null : a.excludedReason };
    // Tech is read from the account's stack, so tech signal rows aren't counted twice.
    const sigs = a.signals.filter((s) => s.type !== "tech").map((s) => ({ id: s.id, type: s.type, title: s.title, detail: s.detail, value: s.value, occurredAt: s.occurredAt }));
    const results = mo.map(({ o, m }) => {
      const r = matchAccount(ma, sigs, a.contacts, m, weights, now);
      const seg = segments.filter((s) => s.offeringId === o.id && industryMatches(s.industry ?? "", a.industry)).sort((x, y) => (x.status === "ACTIVE" ? -1 : 1) - (y.status === "ACTIVE" ? -1 : 1))[0];
      return { offeringId: o.id, segmentId: seg?.id ?? null, ...r };
    });
    for (const r of results) {
      const reasons: MatchReasons = { fit: r.fitParts, signals: r.hits, disqualified: r.disqualified };
      await db.accountMatch.upsert({
        where: { accountId_offeringId: { accountId: a.id, offeringId: r.offeringId } },
        create: { companyId, accountId: a.id, offeringId: r.offeringId, segmentId: r.segmentId, fit: r.fit, signal: r.signal, total: r.total, tier: r.tier, reasons: reasons as unknown as Prisma.InputJsonValue, computedAt: now },
        update: { segmentId: r.segmentId, fit: r.fit, signal: r.signal, total: r.total, tier: r.tier, reasons: reasons as unknown as Prisma.InputJsonValue, computedAt: now },
      });
    }
    await db.accountMatch.deleteMany({ where: { accountId: a.id, offeringId: { notIn: offerings.map((o) => o.id) } } });
    // An account filed under a bucket is matched to that bucket's offers (and offers in no bucket).
    const inBucket = a.buckets.length ? results.filter((r) => { const b = offerBucket.get(r.offeringId); return !b || a.buckets.includes(b); }) : results;
    const best = bestMatch(inBucket);
    // Imported research is a floor: the app never ranks an account below what the researcher found.
    const researched = bestResearch(a.research, now);
    const tier = higherTier((best?.tier ?? "not_fit") as Tier, researched?.tier ?? null);
    const total = Math.max(best?.total ?? 0, researched?.tier ? (researched.entry.score ?? 0) : 0) || null;
    // The primary contact: a title the best offer targets, then seniority, then a verified email.
    const bestOffer = offerings.find((o) => o.id === best?.offeringId);
    const primary = pickPrimary(a.contacts, bestOffer?.targetTitles ?? []);
    await db.contact.updateMany({ where: { accountId: a.id }, data: { isPrimary: false } });
    if (primary) await db.contact.update({ where: { id: primary.id }, data: { isPrimary: true } });
    await db.account.update({
      where: { id: a.id },
      data: { bestOfferingId: best?.offeringId ?? null, bestTotal: total, bestFit: best?.fit ?? null, bestSignal: best?.signal ?? null, tier, matchedAt: now },
    });
  }
}

export async function rematchAll(db: ScopedDb, companyId: string) {
  await matchAccounts(db, companyId);
}

/** Claude writes why now, the angle, an opener and who to contact, for the account's best offer. */
export async function briefAccount(db: ScopedDb, companyId: string, accountId: string, offeringId?: string | null, now = new Date()) {
  const a = await db.account.findUniqueOrThrow({ where: { id: accountId }, include: { signals: { orderBy: { occurredAt: "desc" } }, contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] } } });
  const oid = offeringId ?? a.bestOfferingId;
  if (!oid) throw new Error("No offering matches this account yet.");
  const match = await db.accountMatch.findUniqueOrThrow({ where: { accountId_offeringId: { accountId, offeringId: oid } }, include: { offering: { include: { caseStudies: { include: { caseStudy: true } } } } } });
  const reasons = match.reasons as unknown as MatchReasons;
  // Lead with the signals that earned the most points for this offer.
  const pointsBySignal = new Map<string, number>();
  for (const h of reasons.signals) for (const id of h.signalIds) pointsBySignal.set(id, Math.max(pointsBySignal.get(id) ?? 0, h.points));
  const counted = new Set(pointsBySignal.keys());
  const techHits = reasons.signals.filter((h) => h.type === "tech").flatMap((h) => h.matched);
  const ranked = [...a.signals.filter((s) => counted.has(s.id)).sort((x, y) => (pointsBySignal.get(y.id) ?? 0) - (pointsBySignal.get(x.id) ?? 0)), ...a.signals.filter((s) => !counted.has(s.id))].slice(0, 6);
  const techFirst = reasons.signals.find((h) => h.type === "tech" && h.points >= (pointsBySignal.get(ranked[0]?.id ?? "") ?? 0));
  const segment = match.segmentId ? await db.segment.findUnique({ where: { id: match.segmentId } }) : null;
  const winners = segment ? (await db.statement.findMany({ where: { segmentId: segment.id, inLibrary: true }, select: { text: true }, take: 4 })).map((s) => s.text) : [];
  const o = match.offering;
  const { output, runId } = await runAi(db, companyId, accountBriefTask, {
    account: { name: a.name, industry: a.industry, employees: a.employees, revenue: a.revenueCents != null ? money(Number(a.revenueCents), "USD", { compact: true }) : null, location: [a.city, a.state].filter(Boolean).join(", ") || null, description: a.description, technologies: techHits },
    signals: (() => {
      const tech = techHits.map((t) => ({ type: "tech", title: `Uses ${t}`, when: "current stack" }));
      const dated = ranked.map((s) => ({ type: s.type, title: s.title, when: s.type === "intent" ? "research this week" : s.type === "workforce" ? "current" : relative(s.occurredAt, now) }));
      return techFirst ? [...tech, ...dated] : [...dated, ...tech];
    })(),
    offer: { name: o.name, promise: o.promise, targetTitles: o.targetTitles, proof: [...o.proofPoints.slice(0, 2), ...o.caseStudies.slice(0, 2).map((c) => `${c.caseStudy.client}: ${c.caseStudy.result}`)] },
    segment: segment?.name ?? null,
    winners,
    contacts: a.contacts.map((c) => ({ name: `${c.firstName} ${c.lastName ?? ""}`.trim(), title: c.title })),
  });
  await db.accountMatch.update({ where: { id: match.id }, data: { whyNow: output.whyNow, angle: output.angle, opener: output.opener, contactTitle: output.contactTitle, aiRunId: runId, briefedAt: now } });
  await generateSequence(db, companyId, accountId, oid, now).catch((e) => console.error("[buyers] sequence failed", (e as Error).message));
}

// Signals that are fine to mention to a buyer. Research intent, staff makeup and legal trouble tell us
// why now, but quoting them reads as surveillance.
const PUBLIC_SIGNAL_TYPES = new Set(["leadership", "funding", "news", "tech", "growth", "hiring"]);

/** The follow-up sequence after the opener, signed by the account's owner. Stored on the match. */
export async function generateSequence(db: ScopedDb, companyId: string, accountId: string, offeringId?: string | null, now = new Date()) {
  const a = await db.account.findUniqueOrThrow({ where: { id: accountId }, include: { seller: true, signals: { orderBy: { occurredAt: "desc" } }, contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] } } });
  const oid = offeringId ?? a.bestOfferingId;
  if (!oid) return null;
  const match = await db.accountMatch.findUniqueOrThrow({ where: { accountId_offeringId: { accountId, offeringId: oid } }, include: { offering: { include: { caseStudies: { include: { caseStudy: true } } } } } });
  const reasons = match.reasons as unknown as MatchReasons;
  const techHits = reasons.signals.filter((h) => h.type === "tech").flatMap((h) => h.matched);
  const buyer = a.contacts[0];
  const o = match.offering;
  const { output } = await runAi(db, companyId, outreachSequenceTask, {
    account: { name: a.name, industry: a.industry, location: [a.city, a.state].filter(Boolean).join(", ") || null },
    buyer: buyer ? { name: `${buyer.firstName} ${buyer.lastName ?? ""}`.trim(), title: buyer.title } : null,
    signals: [
      ...a.signals.filter((s) => PUBLIC_SIGNAL_TYPES.has(s.type)).slice(0, 6).map((s) => ({ type: s.type, title: s.title, when: relative(s.occurredAt, now) })),
      ...techHits.slice(0, 3).map((t) => ({ type: "tech", title: `Uses ${t}`, when: "current stack" })),
    ],
    offer: { name: o.name, promise: o.promise, proof: [...o.proofPoints.slice(0, 2), ...o.caseStudies.slice(0, 2).map((c) => `${c.caseStudy.client}: ${c.caseStudy.result}`)] },
    opener: match.opener,
    angle: match.angle,
    sender: a.seller?.name ?? null,
  });
  const steps = [...output.steps].sort((x, y) => x.step - y.step).slice(0, 4);
  await db.accountMatch.update({ where: { id: match.id }, data: { sequence: steps as unknown as Prisma.InputJsonValue, sequenceAt: now } });
  return steps;
}

/** Brief the strongest accounts from a pull, up to the configured limit. */
export async function briefTop(db: ScopedDb, companyId: string, accountIds: string[]) {
  const { briefLimit } = await buyerSettings(db);
  const top = await db.account.findMany({ where: { id: { in: accountIds }, tier: { in: ["act_now", "good_fit"] } }, orderBy: { bestTotal: "desc" }, take: briefLimit, select: { id: true } });
  for (const a of top) await briefAccount(db, companyId, a.id).catch((e) => console.error("[buyers] brief failed", (e as Error).message));
}

/** Pull fresh firmographics, hiring, news and people for one account, then rematch and rebrief. */
export async function refreshAccount(ctx: CompanyContext, accountId: string) {
  const a = await ctx.db.account.findUniqueOrThrow({ where: { id: accountId } });
  const adapter = prospectsAdapter();
  const titles = await allTargetTitles(ctx.db);
  await ingestCompany(ctx.db, ctx.company.id, adapter, { externalId: a.externalId ?? a.domain, name: a.name, domain: a.domain }, titles, new Date());
  await ingestNews(ctx.db, ctx.company.id, adapter, [a.id], new Date());
  await matchAccounts(ctx.db, ctx.company.id, [a.id]);
  await briefAccount(ctx.db, ctx.company.id, a.id);
}

// ---------- Acting on an account ----------

export async function revealEmail(ctx: CompanyContext, contactId: string) {
  const c = await ctx.db.contact.findUniqueOrThrow({ where: { id: contactId }, include: { account: true } });
  if (c.email) return c.email;
  if (!c.externalId) throw new Error("This contact has no source id to look up.");
  const r = await prospectsAdapter().revealEmail({ externalId: c.externalId, firstName: c.firstName, lastName: c.lastName, domain: c.account.domain });
  if (!r.email) throw new Error("No email found for this person.");
  await ctx.db.contact.update({ where: { id: contactId }, data: { email: r.email, emailStatus: r.status } });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "contact.revealEmail", entity: "contact", entityId: contactId, data: { credits: r.credits } });
  return r.email;
}

export async function setAccountStatus(ctx: CompanyContext, accountId: string, status: AccountStatus) {
  await ctx.db.account.update({ where: { id: accountId }, data: { status } });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: `account.${status.toLowerCase()}`, entity: "account", entityId: accountId });
}

// Assigning and pushing to HubSpot live in ./crm.ts.

/**
 * Start outreach to one contact: an outbound lead on the best offer, sent the brief's opener with a
 * booking link through the same show-up sequence as inbound leads.
 */
export async function startOutreach(ctx: CompanyContext, accountId: string, contactId: string) {
  const a = await ctx.db.account.findUniqueOrThrow({ where: { id: accountId }, include: { matches: { include: { offering: true } } } });
  const contact = await ctx.db.contact.findUniqueOrThrow({ where: { id: contactId }, include: { lead: true } });
  if (contact.accountId !== a.id) throw new Error("That contact belongs to a different account.");
  if (contact.lead) return contact.lead.id;
  const best = a.matches.find((m) => m.offeringId === a.bestOfferingId);
  if (!best) throw new Error("Match this account to an offering first.");
  const email = contact.email ?? (await revealEmail(ctx, contactId));
  const lead = await ctx.db.lead.create({
    data: {
      companyId: ctx.company.id,
      offeringId: best.offeringId,
      source: "outbound",
      accountId: a.id,
      contactId,
      email,
      firstName: contact.firstName,
      lastName: contact.lastName ?? "",
      title: contact.title,
      companyName: a.name,
      domain: a.domain,
      status: "VALIDATED",
      decisionReason: `Outbound target from Buyers (${best.tier.replace("_", " ")}, score ${Math.round(best.total)}).`,
      researchNote: [best.whyNow, best.angle].filter(Boolean).join("\n") || null,
      ownerUserId: a.ownerUserId ?? ctx.user.id,
      validatedAt: new Date(),
    },
  });
  await startShowUpSequence(ctx.db, ctx.company.id, lead.id, new Date(), { subject: `${a.name} and ${best.offering.name.toLowerCase().includes("map") ? "where AI pays back" : best.offering.name}`, opener: best.opener ?? undefined });
  await ctx.db.account.update({ where: { id: a.id }, data: { status: a.status === "NEW" ? "WORKING" : a.status, ownerUserId: a.ownerUserId ?? ctx.user.id } });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "account.outreach", entity: "account", entityId: a.id, data: { contactId, leadId: lead.id } });
  return lead.id;
}

// ---------- Reads for pages ----------

export type BuyerRow = Awaited<ReturnType<typeof listBuyers>>[number];

export async function listBuyers(db: ScopedDb, opts: { tier?: Tier | "all"; offeringId?: string | null; status?: AccountStatus | null; q?: string | null; sellerId?: string | null; listId?: string | null; bucket?: string | null; take?: number } = {}) {
  return db.account.findMany({
    where: {
      batchId: null, // sent accounts live in their handoff batch, not the queue
      ...(opts.tier && opts.tier !== "all" ? { tier: opts.tier } : {}),
      ...(opts.offeringId ? { bestOfferingId: opts.offeringId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.sellerId ? { sellerId: opts.sellerId === "none" ? null : opts.sellerId } : {}),
      ...(opts.listId ? { importIds: { has: opts.listId } } : {}),
      ...(opts.bucket ? { buckets: { has: opts.bucket } } : {}),
      ...(opts.q ? { OR: [{ name: { contains: opts.q, mode: "insensitive" } }, { domain: { contains: opts.q, mode: "insensitive" } }] } : {}),
    },
    orderBy: [{ bestTotal: { sort: "desc", nulls: "last" } }, { name: "asc" }],
    take: opts.take ?? 200,
    include: {
      matches: { include: { offering: { select: { id: true, name: true, slug: true } } } },
      signals: { orderBy: { occurredAt: "desc" }, take: 8 },
      contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }], take: 1 },
      seller: { select: { id: true, name: true } },
    },
  });
}

export async function tierCounts(db: ScopedDb, offeringId?: string | null, listId?: string | null, bucket?: string | null) {
  const g = await db.account.groupBy({ by: ["tier"], _count: true, where: { batchId: null, ...(offeringId ? { bestOfferingId: offeringId } : {}), ...(listId ? { importIds: { has: listId } } : {}), ...(bucket ? { buckets: { has: bucket } } : {}) } });
  // Add up rather than overwrite: unscored accounts (tier null) count with "not a fit" until matched.
  const out: Partial<Record<Tier, number>> = {};
  for (const x of g) { const k = (x.tier ?? "not_fit") as Tier; out[k] = (out[k] ?? 0) + x._count; }
  return out;
}

/** Daily job: run scheduled pulls (weekly ones on Mondays) for every company. */
export async function runScheduledSearches(now = new Date()) {
  const due = await unscopedDb.prospectSearch.findMany({ where: { OR: [{ schedule: "daily" }, ...(now.getUTCDay() === 1 ? [{ schedule: "weekly" }] : [])], status: { not: "running" } } });
  for (const s of due) await enqueue(QUEUES.buyersSearch, { companyId: s.companyId, searchId: s.id }, { singletonKey: `search:${s.id}` });
}

/** Remove every account that came from the sample (mock) source, with its signals, contacts and matches. */
export async function clearSampleAccounts(ctx: CompanyContext) {
  const r = await ctx.db.account.deleteMany({ where: { source: "mock" } });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "buyers.clearSample", entity: "account", data: { removed: r.count } });
  return r.count;
}


// ---------- Vibe Prospecting import ----------

/**
 * Load companies pulled from Vibe Prospecting: firmographics, tech stack, research intent, events,
 * team makeup and contacts become accounts and explained signals, then everything is matched and the
 * strongest are briefed. Returns the account ids touched.
 */
export async function importVibeCompanies(db: ScopedDb, companyId: string, rows: VibeCompany[], opts: { searchId?: string | null; now?: Date; brief?: boolean } = {}) {
  const now = opts.now ?? new Date();
  const touched: string[] = [];
  let created = 0;
  for (const v of rows) {
    const domain = v.domain.toLowerCase().replace(/^www\./, "");
    if (!domain) continue;
    const employees = rangeMid(v.employeesRange);
    const revenue = rangeMid(v.revenueRange, 100);
    const base = {
      name: v.name,
      industry: industryFor(v.naics, v.linkedinCategory ? v.linkedinCategory.replace(/^\w/, (x) => x.toUpperCase()) : v.naicsDescription),
      employees,
      employeesRange: v.employeesRange ?? null,
      revenueCents: revenue != null ? BigInt(revenue) : null,
      revenueRange: v.revenueRange ?? null,
      city: v.city ? v.city.replace(/\b\w/g, (x) => x.toUpperCase()) : null,
      state: v.region ? v.region.replace(/\b\w/g, (x) => x.toUpperCase()) : null,
      country: v.country ? v.country.replace(/\b\w/g, (x) => x.toUpperCase()) : null,
      websiteUrl: v.website ? (v.website.startsWith("http") ? v.website : `https://${v.website}`) : null,
      linkedinUrl: v.linkedin ?? null,
      description: v.description ?? null,
      technologies: v.techStack ?? [],
      externalId: v.businessId,
      excludedReason: exclusionFor(v),
      enrichedAt: now,
      signalsAt: now,
    };
    const existing = await db.account.findFirst({ where: { domain } });
    const account = existing
      ? await db.account.update({ where: { id: existing.id }, data: base })
      : await db.account.create({ data: { ...base, companyId, domain, source: "vibe" } });
    if (!existing) created++;
    await upsertSignals(db, companyId, account.id, "vibe", vibeSignals(v, now));
    for (const p of v.contacts ?? []) {
      await db.contact.upsert({
        where: { accountId_source_externalId: { accountId: account.id, source: "vibe", externalId: p.id } },
        create: { companyId, accountId: account.id, source: "vibe", externalId: p.id, firstName: p.firstName, lastName: p.lastName ?? null, title: p.title ?? null, seniority: p.level ?? null, email: p.email ?? null, emailStatus: p.email ? "provided" : null, linkedinUrl: p.linkedin ?? null },
        update: { title: p.title ?? null, seniority: p.level ?? null, ...(p.email ? { email: p.email } : {}) },
      });
    }
    touched.push(account.id);
  }
  await matchAccounts(db, companyId, touched, now);
  if (opts.brief !== false) await briefTop(db, companyId, touched);
  if (opts.searchId) {
    await db.prospectSearch.update({ where: { id: opts.searchId }, data: { status: "done", lastRunAt: now, lastRunFound: rows.length, lastRunNew: created } });
  }
  await audit(db, companyId, { action: "buyers.importVibe", entity: "search", entityId: opts.searchId ?? null, data: { rows: rows.length, created } });
  return touched;
}

/**
 * Load people from a Vibe prospects export onto their accounts (matched by Vibe business id). The
 * best person for the account's best offer becomes primary (pickPrimary, applied when rescoring).
 * Then rescore (a buyer on file counts toward fit) and rebrief.
 */
export async function importVibeContacts(db: ScopedDb, companyId: string, people: VibePerson[], opts: { brief?: boolean } = {}) {
  const ids = [...new Set(people.map((p) => p.businessId))];
  const accounts = await db.account.findMany({ where: { externalId: { in: ids } }, include: { matches: { include: { offering: { select: { id: true, targetTitles: true } } } } } });
  const byBusiness = new Map(accounts.map((a) => [a.externalId!, a]));
  let added = 0;
  const unmatched: string[] = [];
  for (const a of accounts) {
    const mine = people.filter((p) => p.businessId === a.externalId);
    for (const p of mine) {
      const existing = await db.contact.findUnique({ where: { accountId_source_externalId: { accountId: a.id, source: "vibe", externalId: p.prospectId } } });
      const data = { firstName: p.firstName, lastName: p.lastName, title: p.title, email: p.email, emailStatus: p.emailStatus, mobilePhone: p.phone, linkedinUrl: p.linkedin };
      if (existing) await db.contact.update({ where: { id: existing.id }, data });
      else {
        await db.contact.create({ data: { ...data, companyId, accountId: a.id, source: "vibe", externalId: p.prospectId } });
        added++;
      }
    }
  }
  for (const p of people) if (!byBusiness.has(p.businessId)) unmatched.push(`${p.firstName} ${p.lastName ?? ""}`.trim());
  const touched = accounts.map((a) => a.id);
  await matchAccounts(db, companyId, touched);
  if (opts.brief !== false) for (const id of touched) await briefAccount(db, companyId, id).catch((e) => console.error("[buyers] brief failed", (e as Error).message));
  await audit(db, companyId, { action: "buyers.importVibeContacts", entity: "contact", data: { people: people.length, added, accounts: accounts.length, unmatched: unmatched.length } });
  return { added, accounts: accounts.length, unmatched };
}

/** Undo or apply a company-level exclusion by hand, then rescore. */
export async function setExclusionOverride(ctx: CompanyContext, accountId: string, include: boolean) {
  await ctx.db.account.update({ where: { id: accountId }, data: { excludedOverride: include } });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: include ? "account.includeAnyway" : "account.excludeAgain", entity: "account", entityId: accountId });
  await matchAccounts(ctx.db, ctx.company.id, [accountId]);
}