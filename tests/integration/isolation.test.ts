// Company isolation against a real Postgres (TEST_DATABASE_URL). Proves the scoped client never
// returns, changes or creates another company's rows. Skips when the test database isn't reachable.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgresql://acq:acq@localhost:5440/acq_test";

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

describe.skipIf(!up)("company isolation", () => {
  // Point Prisma at the test database before the client is created.
  process.env.DATABASE_URL = TEST_URL;
  let db: typeof import("@/lib/db");
  let A: string, B: string, offeringB: string;

  beforeAll(async () => {
    const root = path.resolve(__dirname, "../..");
    execFileSync(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "db", "push", "--skip-generate"], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: TEST_URL, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
      stdio: "pipe",
    });
    db = await import("@/lib/db");
    // Fresh state in the dedicated test database only.
    if (!TEST_URL.endsWith("/acq_test")) throw new Error("Refusing to clear a database that isn't acq_test.");
    const tables = await db.unscopedDb.$queryRaw<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public'`;
    await db.unscopedDb.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"public"."${t.tablename}"`).join(", ")} CASCADE`);
    const a = await db.unscopedDb.company.create({ data: { slug: "a", name: "Company A" } });
    const b = await db.unscopedDb.company.create({ data: { slug: "b", name: "Company B" } });
    A = a.id;
    B = b.id;
    await db.unscopedDb.offering.create({ data: { companyId: A, slug: "x", name: "A offering", targetTitles: [], industries: [], regions: [], excludedDomains: [], excludedCategories: [], proofPoints: [] } });
    offeringB = (await db.unscopedDb.offering.create({ data: { companyId: B, slug: "x", name: "B offering", targetTitles: [], industries: [], regions: [], excludedDomains: [], excludedCategories: [], proofPoints: [] } })).id;
    await db.unscopedDb.caseStudy.create({ data: { companyId: B, title: "B case", client: "B", industry: "Software", result: "r" } });
  }, 120_000);

  afterAll(async () => {
    await db?.unscopedDb.$disconnect();
  });

  it("findMany only returns the company's rows", async () => {
    const rows = await db.scopedDb(A).offering.findMany();
    expect(rows.map((r) => r.name)).toEqual(["A offering"]);
    expect(await db.scopedDb(A).caseStudy.count()).toBe(0);
  });

  it("findUnique by another company's id returns nothing", async () => {
    expect(await db.scopedDb(A).offering.findUnique({ where: { id: offeringB } })).toBeNull();
    await expect(db.scopedDb(A).offering.findUniqueOrThrow({ where: { id: offeringB } })).rejects.toThrow();
  });

  it("asking for another company's rows by companyId is refused", async () => {
    await expect(db.scopedDb(A).offering.findMany({ where: { companyId: B } })).rejects.toThrow(/another company/);
    expect(await db.scopedDb(A).offering.findMany({ where: { companyId: A } })).toHaveLength(1);
  });

  it("update and delete can't touch another company's row", async () => {
    await expect(db.scopedDb(A).offering.update({ where: { id: offeringB }, data: { name: "hijacked" } })).rejects.toThrow();
    const r = await db.scopedDb(A).offering.updateMany({ where: { id: offeringB }, data: { name: "hijacked" } });
    expect(r.count).toBe(0);
    const d = await db.scopedDb(A).offering.deleteMany({});
    expect(d.count).toBe(1); // only A's own
    expect((await db.unscopedDb.offering.findUniqueOrThrow({ where: { id: offeringB } })).name).toBe("B offering");
  });

  it("create refuses a different companyId", async () => {
    await expect(db.scopedDb(A).caseStudy.create({ data: { companyId: B, title: "t", client: "c", industry: "i", result: "r" } })).rejects.toThrow(/another company/);
    await expect(db.scopedDb(A).caseStudy.createMany({ data: [{ companyId: B, title: "t", client: "c", industry: "i", result: "r" }] })).rejects.toThrow(/another company/);
  });

  it("create stamps the scoped company", async () => {
    const c = await db.scopedDb(A).caseStudy.create({ data: { companyId: A, title: "t", client: "c", industry: "i", result: "r" } });
    expect(c.companyId).toBe(A);
  });

  it("the company model is scoped by id", async () => {
    expect((await db.scopedDb(A).company.findMany()).map((c) => c.slug)).toEqual(["a"]);
    await expect(db.scopedDb(A).company.create({ data: { slug: "z", name: "Z" } })).rejects.toThrow();
  });

  it("aggregates are scoped", async () => {
    expect(await db.scopedDb(B).offering.count()).toBe(1);
    const g = await db.scopedDb(B).caseStudy.groupBy({ by: ["industry"], _count: true });
    expect(g).toEqual([{ industry: "Software", _count: 1 }]);
  });
});
