// Creates the practice buckets, files the existing offers into them, and adds a DRAFT offer for each
// bucket that has none. Safe to re-run: existing buckets and offers are left as they are.
//   node --env-file=.env --import tsx scripts/setup-buckets.mts <company-slug>

import { scopedDb, unscopedDb } from "@/lib/db";
import { DEFAULT_BUCKETS, DRAFT_OFFERS } from "@/lib/buckets";
import { defaultRulesFor } from "@/lib/signalRules";

const slug = process.argv[2];
if (!slug) {
  console.error("Usage: scripts/setup-buckets.mts <company-slug>");
  process.exit(1);
}
const company = await unscopedDb.company.findUniqueOrThrow({ where: { slug } });
const db = scopedDb(company.id);

for (const [i, d] of DRAFT_OFFERS.entries()) {
  const had = await db.offering.findFirst({ where: { slug: d.slug } });
  if (had) continue;
  await db.offering.create({ data: { companyId: company.id, ...d, regions: ["United States"], status: "DRAFT", signalRules: defaultRulesFor(d.slug) as never } });
  console.log(`draft offer ${i + 1}: ${d.name}`);
}
for (const [sort, b] of DEFAULT_BUCKETS.entries()) {
  const bucket = await db.bucket.upsert({
    where: { companyId_slug: { companyId: company.id, slug: b.slug } },
    create: { companyId: company.id, slug: b.slug, name: b.name, description: b.description, keywords: b.keywords, sort },
    update: {},
  });
  const r = await db.offering.updateMany({ where: { slug: { in: b.offers }, bucketId: null }, data: { bucketId: bucket.id } });
  console.log(`${b.name}: ${r.count} offers filed`);
}
await unscopedDb.$disconnect();
