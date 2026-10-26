// Database access. App code uses scopedDb(companyId): every read is filtered to that company and
// every write is stamped with it. A write that names a different companyId throws.
// `unscopedDb` is for the few places that legitimately span companies (sign-in, admin, job routing)
// and must not be used to read company data on a user's behalf.

import { Prisma, PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const unscopedDb: PrismaClient = globalForPrisma.prisma ?? new PrismaClient({ log: process.env.PRISMA_LOG ? ["query"] : ["error"] });
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = unscopedDb;

/** Models without a companyId column. Company itself is scoped by id. */
const GLOBAL_MODELS = new Set(["User"]);

const READ_OPS = new Set([
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy",
  "update", "updateMany", "updateManyAndReturn", "delete", "deleteMany", "upsert",
]);

export class CrossCompanyError extends Error {
  constructor(model: string) {
    super(`Refused a ${model} query for another company.`);
    this.name = "CrossCompanyError";
  }
}

function stamp(model: string, data: unknown, companyId: string): unknown {
  if (Array.isArray(data)) return data.map((d) => stamp(model, d, companyId));
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (d.companyId !== undefined && d.companyId !== companyId) throw new CrossCompanyError(model);
    return { ...d, companyId };
  }
  return data;
}

export function scopedDb(companyId: string) {
  if (!companyId) throw new Error("scopedDb needs a companyId");
  return unscopedDb.$extends({
    name: `company:${companyId}`,
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (GLOBAL_MODELS.has(model)) return query(args);
          const a = (args ?? {}) as Record<string, unknown>;
          const key = model === "Company" ? "id" : "companyId";

          if (READ_OPS.has(operation)) {
            const where = (a.where as Record<string, unknown> | undefined) ?? {};
            if (key === "companyId" && where.companyId !== undefined && where.companyId !== companyId) throw new CrossCompanyError(model);
            a.where = { ...where, [key]: companyId };
          }
          if (model !== "Company") {
            if (operation === "create" || operation === "createMany" || operation === "createManyAndReturn") {
              a.data = stamp(model, a.data, companyId);
            }
            if (operation === "upsert") a.create = stamp(model, a.create, companyId);
            if ((operation === "update" || operation === "updateMany" || operation === "upsert") && a.data && typeof a.data === "object") {
              const d = (operation === "upsert" ? a.update : a.data) as Record<string, unknown> | undefined;
              if (d && d.companyId !== undefined && d.companyId !== companyId) throw new CrossCompanyError(model);
            }
          } else if (operation === "create" || operation === "createMany" || operation === "delete" || operation === "deleteMany") {
            throw new Error("Companies are created and deleted by admins through unscopedDb.");
          }
          return query(a as typeof args);
        },
      },
    },
  });
}

export type ScopedDb = ReturnType<typeof scopedDb>;
export type Tx = Prisma.TransactionClient;
export { Prisma };
