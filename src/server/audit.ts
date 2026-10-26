import type { ScopedDb } from "@/lib/db";
import { Prisma } from "@prisma/client";

export async function audit(db: ScopedDb, companyId: string, entry: { userId?: string | null; action: string; entity: string; entityId?: string | null; data?: unknown }) {
  await db.auditLog.create({
    data: {
      companyId,
      userId: entry.userId ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      data: entry.data === undefined ? Prisma.JsonNull : (JSON.parse(JSON.stringify(entry.data)) as Prisma.InputJsonValue),
    },
  });
}
