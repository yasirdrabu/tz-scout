// Import Vibe Prospecting dataset exports into Buyers.
//
//   node --env-file=.env --import tsx scripts/import-vibe.mts <company-slug> data/vibe/<date>-<offering-slug>.json[:credits] ...
//
// Each file is a get-dataset page (load_into "context") saved as JSON. The offering slug in the
// file name links the pull to an offering; one ProspectSearch per offering records the run.
// Exports are bought in the Vibe connector first; this script never calls Vibe or spends credits.

import { readFileSync } from "node:fs";
import path from "node:path";
import { scopedDb, unscopedDb } from "@/lib/db";
import { filtersFor, importVibeCompanies } from "@/server/buyers";
import { fromVibeExportRow, type VibeExportRow } from "@/integrations/prospects/vibeExport";
import { exclusionFor, industryFor, vibeSignals } from "@/integrations/prospects/vibe";

const dry = process.argv.includes("--dry"); // print what would be imported, write nothing
const [slug, ...files] = process.argv.slice(2).filter((a) => a !== "--dry");
if (!slug || !files.length) {
  console.error("Usage: scripts/import-vibe.mts <company-slug> <export.json> ...");
  process.exit(1);
}

const company = await unscopedDb.company.findUniqueOrThrow({ where: { slug } });
const db = scopedDb(company.id);
const now = new Date();

for (const arg of files) {
  const [, file = arg, spent] = arg.match(/^(.*?)(?::(\d+))?$/) ?? [];
  const data = JSON.parse(readFileSync(file, "utf8")) as { dataset_id?: string; rows: VibeExportRow[] };
  const offeringSlug = path.basename(file, ".json").replace(/^\d{4}-\d{2}-\d{2}-/, "");
  const offering = await db.offering.findFirst({ where: { slug: offeringSlug } });
  if (!offering) {
    console.error(`${file}: no offering with slug "${offeringSlug}", skipped.`);
    continue;
  }
  const rows = data.rows.map((r) => fromVibeExportRow(r, now));
  if (dry) {
    console.log(`\n== ${offering.name} (${rows.length})`);
    for (const r of rows) {
      const sig = vibeSignals(r, now);
      console.log(`- ${r.name} | ${industryFor(r.naics, r.naicsDescription)} | ${r.employeesRange} | ${r.revenueRange}${exclusionFor(r) ? ` | OUT: ${exclusionFor(r)}` : ""}`);
      for (const g of sig.filter((x) => x.type !== "workforce" || x.externalId === "workforce:ops-share").slice(0, 6)) console.log(`    [${g.type}] ${g.title}${g.type !== "intent" ? ` (${g.occurredAt.toISOString().slice(0, 10)})` : ""}`);
    }
    continue;
  }
  const topics = [...new Set(rows.flatMap((r) => (r.intent ?? []).filter((i) => i.score >= 60).map((i) => i.topic.split(":").pop()!.trim())))].slice(0, 8);
  const name = `${offering.name}: buyers in research (Vibe)`;
  const filters = { ...filtersFor(offering), keywords: topics, source: { provider: "vibe", datasetId: data.dataset_id ?? null } };
  const existing = await db.prospectSearch.findFirst({ where: { name } });
  const search = existing
    ? await db.prospectSearch.update({ where: { id: existing.id }, data: { filters, status: "running" } })
    : await db.prospectSearch.create({ data: { companyId: company.id, name, provider: "vibe", offeringId: offering.id, filters, maxCompanies: rows.length, status: "running", createdBy: "Vibe import" } });
  const touched = await importVibeCompanies(db, company.id, rows, { searchId: search.id, now });
  if (spent) await db.prospectSearch.update({ where: { id: search.id }, data: { lastRunCredits: Number(spent) } });
  console.log(`${offering.name}: ${touched.length} companies imported from ${path.basename(file)}`);
}

const tiers = await db.account.groupBy({ by: ["tier"], _count: true });
console.log("Tiers now:", Object.fromEntries(tiers.map((t) => [t.tier ?? "unscored", t._count])));
await unscopedDb.$disconnect();
