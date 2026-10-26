// Import people (with emails) from a Vibe prospects export onto their Buyers accounts.
//
//   node --env-file=.env --import tsx scripts/import-vibe-contacts.mts <company-slug> data/vibe/<file>.json [--dry]
//
// The file is a get-dataset page (load_into "context") saved as JSON. Never calls Vibe or spends credits.

import { readFileSync } from "node:fs";
import { scopedDb, unscopedDb } from "@/lib/db";
import { importVibeContacts } from "@/server/buyers";
import { fromVibeProspectRow, type VibeExportRow, type VibePerson } from "@/integrations/prospects/vibeExport";

const dry = process.argv.includes("--dry");
const [slug, ...files] = process.argv.slice(2).filter((a) => a !== "--dry");
if (!slug || !files.length) {
  console.error("Usage: scripts/import-vibe-contacts.mts <company-slug> <export.json> ... [--dry]");
  process.exit(1);
}

const people: VibePerson[] = [];
for (const f of files) {
  const data = JSON.parse(readFileSync(f, "utf8")) as { rows: VibeExportRow[] };
  for (const r of data.rows) {
    const p = fromVibeProspectRow(r);
    if (p) people.push(p);
  }
}
console.log(`${people.length} people, ${people.filter((p) => p.email).length} with email (${people.filter((p) => p.emailStatus === "valid").length} verified)`);

const company = await unscopedDb.company.findUniqueOrThrow({ where: { slug } });
const db = scopedDb(company.id);
if (dry) {
  const accounts = await db.account.findMany({ where: { externalId: { in: people.map((p) => p.businessId) } }, select: { externalId: true, name: true } });
  const name = new Map(accounts.map((a) => [a.externalId, a.name]));
  for (const p of people) console.log(`- ${name.get(p.businessId) ?? "NO ACCOUNT"} | ${p.firstName} ${p.lastName ?? ""} | ${p.title} | ${p.email} (${p.emailStatus})`);
} else {
  const r = await importVibeContacts(db, company.id, people);
  console.log(`Added ${r.added} contacts across ${r.accounts} accounts.${r.unmatched.length ? ` No account for: ${r.unmatched.join(", ")}` : ""}`);
}
await unscopedDb.$disconnect();
