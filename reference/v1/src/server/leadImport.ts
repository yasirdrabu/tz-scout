// Lead sheet import: someone drops a CSV, Excel or Markdown list and every row becomes a company with
// its people in Buyers: de-duplicated against what we have, checked against HubSpot, optionally enriched
// with Apollo, scored and matched to an offer. Two kinds of sheet:
// - lead lists (people: name, title, email, company), mapped by column with a confirm step when unsure;
// - ABM research sheets (one company per row with a dated signal, decision-makers, pilot, hook, score),
//   recognised by their columns and filed into a practice bucket. See src/lib/research.ts.

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { CompanyContext } from "./context";
import { readSheet, groupRows, suggestMapping, domainOf, LEAD_FIELDS, type Mapping, type SheetCompany, type SkippedRow } from "@/lib/leadSheet";
import { bucketFor, detectResearch, groupResearchRows, signalKey, type ResearchCompany, type ResearchEntry } from "@/lib/research";
import { industryFor } from "@/integrations/prospects/vibe";
import { prospectsAdapter, ApolloCreditsError } from "@/integrations/prospects";
import { modeOf } from "@/integrations/mode";
import { allTargetTitles, briefTop, ingestCompany, matchAccounts } from "./buyers";
import { checkHubSpot } from "./crm";
import { audit } from "./audit";

export const MAX_ROWS = 5000;
export const MAX_BYTES = 8 * 1024 * 1024;

export type ImportStats = {
  rows: number;
  companies: number;
  created: number;
  alreadyInQueue: number;
  alreadySent: number;
  peopleAdded: number;
  signalsAdded?: number;
  enriched: number;
  enrichStopped: string | null;
  skipped: SkippedRow[];
  hubspot: { checked: number; inCrm: number; error: string | null };
  tiers: Record<string, number>;
};

/** Can this import run without a person confirming the columns? Research sheets always can. */
export function readyToRun(kind: string, m: Mapping): boolean {
  if (kind === "research") return true;
  return (m.website != null || m.email != null) && (m.company != null || m.fullName != null || m.firstName != null || m.email != null);
}

/** Read the file and keep its rows. Research sheets are filed into a bucket (picked, or from the file). */
export async function createImport(ctx: CompanyContext, input: { name: string; fileName: string; bytes: ArrayBuffer; bucketId?: string | null }) {
  if (input.bytes.byteLength > MAX_BYTES) throw new Error("That file is over 8 MB. Split it or save it as CSV.");
  const sheet = await readSheet(input.fileName, input.bytes);
  if (sheet.rows.length > MAX_ROWS) throw new Error(`That's ${sheet.rows.length.toLocaleString("en-US")} rows; the limit is ${MAX_ROWS.toLocaleString("en-US")} per file. Split it and import in parts.`);
  const research = detectResearch(sheet.headers);
  let bucketId = input.bucketId || null;
  if (!bucketId) {
    const buckets = await ctx.db.bucket.findMany({ select: { id: true, slug: true, name: true, keywords: true } });
    const col = research?.agent?.[0];
    const agent = col != null ? (sheet.rows.find((r) => r[col])?.[col] ?? null) : null;
    bucketId = bucketFor(input.fileName, agent, buckets)?.id ?? null;
  }
  const imp = await ctx.db.leadImport.create({
    data: {
      companyId: ctx.company.id,
      name: input.name.trim() || input.fileName.replace(/\.[^.]+$/, "").replace(/_+/g, " "),
      fileName: input.fileName,
      kind: research ? "research" : "leads",
      bucketId,
      headers: sheet.headers,
      rows: sheet.rows,
      mapping: suggestMapping(sheet.headers) as Prisma.InputJsonValue,
      createdBy: ctx.user.name,
    },
  });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "import.upload", entity: "leadImport", entityId: imp.id, data: { fileName: input.fileName, rows: sheet.rows.length, kind: imp.kind } });
  return imp.id;
}

const contactKey = (p: { email: string | null; firstName: string; lastName: string | null }) => p.email ?? `name:${createHash("sha1").update(`${p.firstName} ${p.lastName ?? ""}`.toLowerCase()).digest("hex").slice(0, 16)}`;
const isResearch = (c: SheetCompany | ResearchCompany): c is ResearchCompany => "research" in c;

type Imp = { id: string; bucketId: string | null };

/** Bring companies and their people (and research) in. Shared by the first run and by adding held rows. */
async function ingest(ctx: CompanyContext, imp: Imp, companies: (SheetCompany | ResearchCompany)[], stats: ImportStats, now: Date) {
  const bucket = imp.bucketId ? await ctx.db.bucket.findUnique({ where: { id: imp.bucketId }, select: { slug: true } }) : null;
  const key = bucket?.slug ?? "unfiled";
  const touched: string[] = [];
  const created: string[] = [];
  for (const c of companies) {
    const existing = await ctx.db.account.findFirst({ where: { domain: c.domain } });
    const research: ResearchEntry | null = isResearch(c) ? { ...c.research, listId: imp.id, bucket: bucket?.slug ?? null } : null;
    let accountId: string;
    if (existing) {
      accountId = existing.id;
      if (existing.batchId) stats.alreadySent++;
      else stats.alreadyInQueue++;
      await ctx.db.account.update({
        where: { id: existing.id },
        data: {
          importIds: [...new Set([...existing.importIds, imp.id])],
          ...(bucket ? { buckets: [...new Set([...existing.buckets, bucket.slug])] } : {}),
          ...(research ? { research: { ...((existing.research as Record<string, unknown> | null) ?? {}), [key]: research } as Prisma.InputJsonValue } : {}),
          // Fill gaps only.
          industry: existing.industry ?? (c.industry ? industryFor(null, c.industry) : null),
          employees: existing.employees ?? c.employees,
          city: existing.city ?? c.city,
          state: existing.state ?? c.state,
        },
      });
    } else {
      const a = await ctx.db.account.create({
        data: {
          companyId: ctx.company.id,
          domain: c.domain,
          name: c.name,
          source: research ? "research" : "import",
          industry: c.industry ? industryFor(null, c.industry) : null,
          employees: c.employees,
          revenueRange: research?.scale?.slice(0, 120) ?? null,
          city: c.city,
          state: c.state,
          country: c.country,
          websiteUrl: `https://${c.domain}`,
          description: c.notes.length ? c.notes.slice(0, 3).join(" · ").slice(0, 800) : null,
          importIds: [imp.id],
          buckets: bucket ? [bucket.slug] : [],
          research: research ? ({ [key]: research } as Prisma.InputJsonValue) : Prisma.JsonNull,
        },
      });
      accountId = a.id;
      created.push(a.id);
      stats.created++;
    }
    if (isResearch(c)) {
      for (const s of c.signals) {
        const externalId = signalKey(c.domain, s);
        const had = await ctx.db.signal.findUnique({ where: { accountId_source_externalId: { accountId, source: "research", externalId } }, select: { id: true } });
        if (had) continue;
        await ctx.db.signal.create({ data: { companyId: ctx.company.id, accountId, type: s.type, title: s.title, url: s.url, occurredAt: new Date(`${s.date}T12:00:00Z`), source: "research", externalId } });
        stats.signalsAdded = (stats.signalsAdded ?? 0) + 1;
      }
      await ctx.db.account.update({ where: { id: accountId }, data: { signalsAt: now } });
    }
    for (const p of c.people) {
      const externalId = contactKey(p);
      const dup = await ctx.db.contact.findFirst({
        where: { accountId, OR: [{ externalId }, ...(p.email ? [{ email: p.email }] : []), { firstName: { equals: p.firstName, mode: "insensitive" as const }, lastName: { equals: p.lastName ?? "", mode: "insensitive" as const } }] },
      });
      if (dup) {
        // Fill gaps only; never overwrite what we already know about a person.
        await ctx.db.contact.update({ where: { id: dup.id }, data: { title: dup.title ?? p.title, phone: dup.phone ?? p.phone, email: dup.email ?? p.email, linkedinUrl: dup.linkedinUrl ?? p.linkedin } });
        continue;
      }
      await ctx.db.contact.create({
        data: { companyId: ctx.company.id, accountId, source: "import", externalId, importId: imp.id, firstName: p.firstName, lastName: p.lastName, title: p.title, email: p.email, emailStatus: p.email ? "provided" : null, phone: p.phone, linkedinUrl: p.linkedin },
      });
      stats.peopleAdded++;
    }
    touched.push(accountId);
  }
  return { touched, created };
}

/** After ingest: optional Apollo enrichment, a read-only HubSpot check, then scoring and briefs. */
async function finish(ctx: CompanyContext, touched: string[], created: string[], enrich: boolean, stats: ImportStats, now: Date) {
  if (enrich && created.length && (modeOf("prospects") === "live" || process.env.NODE_ENV === "test")) {
    const adapter = prospectsAdapter();
    const titles = await allTargetTitles(ctx.db);
    for (const id of created) {
      const a = await ctx.db.account.findUniqueOrThrow({ where: { id } });
      try {
        await ingestCompany(ctx.db, ctx.company.id, adapter, { externalId: a.domain, name: a.name, domain: a.domain }, titles, now);
        stats.enriched++;
      } catch (e) {
        if (e instanceof ApolloCreditsError) {
          stats.enrichStopped = e.message;
          break;
        }
        console.error("[import] enrich failed", a.domain, (e as Error).message);
      }
    }
  }
  if (touched.length && (modeOf("hubspot") === "live" || process.env.NODE_ENV === "test")) {
    try {
      const t = await checkHubSpot(ctx, touched);
      stats.hubspot = { checked: stats.hubspot.checked + touched.length, inCrm: stats.hubspot.inCrm + t.in_crm + t.open_deal + t.customer, error: null };
    } catch (e) {
      stats.hubspot.error = (e as Error).message;
    }
  }
  if (touched.length) await matchAccounts(ctx.db, ctx.company.id, touched, now);
  if (created.length) await briefTop(ctx.db, ctx.company.id, created);
}

async function tiersOf(ctx: CompanyContext, importId: string) {
  const tiers = await ctx.db.account.groupBy({ by: ["tier"], _count: true, where: { importIds: { has: importId } } });
  return Object.fromEntries(tiers.map((t) => [t.tier ?? "unscored", t._count]));
}

/** Run the import with the confirmed (or detected) columns. */
export async function runImport(ctx: CompanyContext, importId: string, opts: { mapping: Mapping; enrich: boolean }) {
  const imp = await ctx.db.leadImport.findUniqueOrThrow({ where: { id: importId } });
  if (imp.status === "done") throw new Error("This list was already imported.");
  const rows = imp.rows as string[][];
  const m = opts.mapping;
  let grouped: { companies: (SheetCompany | ResearchCompany)[]; skipped: SkippedRow[] };
  if (imp.kind === "research") grouped = groupResearchRows(rows, detectResearch(imp.headers as string[])!);
  else {
    if (m.website == null && m.email == null) throw new Error("Pick the column with the website or the email, so each row can be tied to a company.");
    grouped = groupRows(rows, m);
  }
  const now = new Date();
  const stats: ImportStats = { rows: rows.length, companies: grouped.companies.length, created: 0, alreadyInQueue: 0, alreadySent: 0, peopleAdded: 0, signalsAdded: 0, enriched: 0, enrichStopped: null, skipped: grouped.skipped, hubspot: { checked: 0, inCrm: 0, error: null }, tiers: {} };
  const { touched, created } = await ingest(ctx, imp, grouped.companies, stats, now);
  await finish(ctx, touched, created, opts.enrich, stats, now);
  stats.tiers = await tiersOf(ctx, importId);

  await ctx.db.leadImport.update({ where: { id: importId }, data: { status: "done", mapping: m as Prisma.InputJsonValue, enrich: opts.enrich, stats: stats as unknown as Prisma.InputJsonValue } });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "import.run", entity: "leadImport", entityId: importId, data: { companies: stats.companies, created: stats.created, people: stats.peopleAdded, skipped: grouped.skipped.length } });
  return stats;
}

/** Rows held for a missing website: the person types the website and they come in like the rest. */
export async function addHeldRows(ctx: CompanyContext, importId: string, fixes: { row: number; website: string }[]) {
  const imp = await ctx.db.leadImport.findUniqueOrThrow({ where: { id: importId } });
  if (imp.status !== "done") throw new Error("Run the import first.");
  const stats = imp.stats as unknown as ImportStats;
  const bad = fixes.find((f) => f.website.trim() && !domainOf(f.website));
  if (bad) throw new Error(`"${bad.website}" isn't a website. Use the form example.com.`);
  const valid = fixes.filter((f) => f.website.trim() && stats.skipped.some((s) => s.row === f.row)).map((f) => ({ row: f.row, domain: domainOf(f.website)! }));
  if (!valid.length) throw new Error("Type a website like example.com next to at least one company.");

  // Put each website into the row's website column (adding one if the sheet has none), then group as usual.
  const rows = imp.rows as string[][];
  const hdrs = [...(imp.headers as string[])];
  let siteCol = imp.kind === "research" ? detectResearch(hdrs)?.website?.[0] : (imp.mapping as Mapping | null)?.website;
  if (siteCol == null) {
    siteCol = hdrs.length;
    hdrs.push(imp.kind === "research" ? "official_website" : "Website");
  }
  const col = siteCol;
  const patched = valid.map((f) => {
    const r = [...(rows[f.row - 2] ?? [])];
    while (r.length < hdrs.length) r.push("");
    r[col] = f.domain;
    return r;
  });
  const grouped = imp.kind === "research" ? groupResearchRows(patched, detectResearch(hdrs)!) : groupRows(patched, { ...((imp.mapping as Mapping | null) ?? {}), website: col });
  // Grouping numbers rows by position in `patched`; map them back to the sheet's row numbers.
  for (const c of grouped.companies) c.rows = c.rows.map((n) => valid[n - 2]!.row);

  const now = new Date();
  const before = stats.created;
  const { touched, created } = await ingest(ctx, imp, grouped.companies, stats, now);
  await finish(ctx, touched, created, imp.enrich, stats, now);
  const done = new Set(grouped.companies.flatMap((c) => c.rows));
  stats.skipped = stats.skipped.filter((s) => !done.has(s.row));
  stats.companies += grouped.companies.length;
  stats.tiers = await tiersOf(ctx, importId);
  await ctx.db.leadImport.update({ where: { id: importId }, data: { stats: stats as unknown as Prisma.InputJsonValue } });
  await audit(ctx.db, ctx.company.id, { userId: ctx.user.id, action: "import.addHeld", entity: "leadImport", entityId: importId, data: { added: grouped.companies.length } });
  return { added: grouped.companies.length, created: stats.created - before };
}

/** Drop and go: read the file, and run it straight away when the columns are clear. */
export async function quickImport(ctx: CompanyContext, input: { fileName: string; bytes: ArrayBuffer; bucketId?: string | null; enrich: boolean }) {
  const id = await createImport(ctx, { name: "", fileName: input.fileName, bytes: input.bytes, bucketId: input.bucketId });
  const imp = await ctx.db.leadImport.findUniqueOrThrow({ where: { id }, select: { kind: true, mapping: true, name: true, bucketId: true } });
  const mapping = (imp.mapping ?? {}) as Mapping;
  const bucket = imp.bucketId ? await ctx.db.bucket.findUnique({ where: { id: imp.bucketId }, select: { name: true } }) : null;
  if (!readyToRun(imp.kind, mapping)) return { id, name: imp.name, ran: false as const, kind: imp.kind, bucket: bucket?.name ?? null, stats: null };
  const stats = await runImport(ctx, id, { mapping, enrich: input.enrich });
  return { id, name: imp.name, ran: true as const, kind: imp.kind, bucket: bucket?.name ?? null, stats };
}

/** Parse the mapping form: one select per field, value is the column index or "" for none. */
export function mappingFromForm(fd: FormData): Mapping {
  const m: Mapping = {};
  for (const f of LEAD_FIELDS) {
    const v = fd.get(`map_${f.key}`);
    if (typeof v === "string" && v !== "") m[f.key] = Number(v);
  }
  return m;
}
