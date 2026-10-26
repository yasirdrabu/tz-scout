import { and, desc, eq, gte, lt, lte, or, type SQL } from 'drizzle-orm';
import { adminDb } from './db/client';
import { auditLog } from './db/schema';
import type { Tx } from './db/tenant';
import type { ModuleContext } from './context';
import type { Actor } from './events/envelope';
import { newId } from './ids';

export const PLATFORM_TENANT = 't_platform';
const SENSITIVE = /secret|token|password|key_hash|ciphertext/i;

export type AuditSubject = { type: string; id: string };
export type AuditEntry = {
  action: string;
  subject?: AuditSubject;
  before?: unknown;
  after?: unknown;
  ip?: string;
  /** Set when the actor authenticated with an API key. */
  apiKeyId?: string;
};

/** Copy of `value` with the value of every sensitive-looking key replaced, at any depth. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Date) return value;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE.test(k) ? '[redacted]' : redact(v),
      ]),
    );
  }
  return value;
}

function row(tenantId: string, actor: Actor, correlationId: string | undefined, entry: AuditEntry) {
  return {
    id: newId('aud'),
    tenantId,
    actorKind: actor.kind,
    actorId: actor.id,
    sourceId: actor.sourceId ?? null,
    apiKeyId: entry.apiKeyId ?? null,
    action: entry.action,
    subjectType: entry.subject?.type ?? null,
    subjectId: entry.subject?.id ?? null,
    correlationId: correlationId ?? null,
    ip: entry.ip ?? null,
    before: entry.before === undefined ? null : redact(entry.before),
    after: entry.after === undefined ? null : redact(entry.after),
  };
}

/** Records a change in the caller's transaction: it commits or rolls back with the change. */
export async function audit(ctx: ModuleContext, entry: AuditEntry): Promise<void> {
  await ctx.tx.insert(auditLog).values(row(ctx.tenantId, ctx.actor, ctx.correlationId, entry));
}

/**
 * Records a platform-wide action (tenant `t_platform`) through `adminDb`. Pass `tx` (an adminDb
 * transaction) to commit with the change; otherwise it is written on its own.
 */
export async function platformAudit(
  entry: AuditEntry & { actor: Actor; correlationId?: string },
  tx?: Pick<Tx, 'insert'> | Pick<typeof adminDb, 'insert'>,
): Promise<void> {
  const { actor, correlationId, ...rest } = entry;
  await (tx ?? adminDb).insert(auditLog).values(row(PLATFORM_TENANT, actor, correlationId, rest));
}

export type AuditRow = typeof auditLog.$inferSelect;
export type AuditFilter = {
  actorId?: string;
  apiKeyId?: string;
  sourceId?: string;
  subjectId?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
};

const encodeCursor = (at: Date, id: string) =>
  Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url');
function decodeCursor(cursor: string): [Date, string] {
  const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, string];
  return [new Date(at), id];
}

/** Audit rows of the caller's tenant, newest first. */
export async function listAudit(
  ctx: Pick<ModuleContext, 'tenantId' | 'tx'>,
  f: AuditFilter = {},
): Promise<{ rows: AuditRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const conds: (SQL | undefined)[] = [eq(auditLog.tenantId, ctx.tenantId)];
  if (f.actorId) conds.push(eq(auditLog.actorId, f.actorId));
  if (f.apiKeyId) conds.push(eq(auditLog.apiKeyId, f.apiKeyId));
  if (f.sourceId) conds.push(eq(auditLog.sourceId, f.sourceId));
  if (f.subjectId) conds.push(eq(auditLog.subjectId, f.subjectId));
  if (f.from) conds.push(gte(auditLog.at, f.from));
  if (f.to) conds.push(lte(auditLog.at, f.to));
  if (f.cursor) {
    const [at, id] = decodeCursor(f.cursor);
    conds.push(or(lt(auditLog.at, at), and(eq(auditLog.at, at), lt(auditLog.id, id))));
  }
  const rows = await ctx.tx
    .select()
    .from(auditLog)
    .where(and(...conds))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last.at, last.id) : null,
  };
}
