import { and, desc, eq, gte, ilike, inArray, like, lte, not, or, sql, type SQL } from 'drizzle-orm';
import { adminDb } from './db/client';
import { auditLog } from './db/schema';
import type { Tx } from './db/tenant';
import type { ModuleContext } from './context';
import type { Actor } from './events/envelope';
import { ScoutError } from './errors';
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

/** Copy of `value` with the value of every sensitive-looking key replaced, at any depth. Never throws. */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out = Array.isArray(value)
      ? value.map((v) => redact(v, seen))
      : Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [
            k,
            SENSITIVE.test(k) ? '[redacted]' : redact(v, seen),
          ]),
        );
    seen.delete(value);
    return out;
  }
  return value;
}

function row(tenantId: string, actor: Actor, correlationId: string | undefined, entry: AuditEntry, ip?: string) {
  return {
    id: newId('aud'),
    tenantId,
    actorKind: actor.kind,
    actorId: actor.id,
    sourceId: actor.sourceId ?? null,
    apiKeyId: entry.apiKeyId ?? null,
    supportAccess: actor.supportAccess === true,
    action: entry.action,
    subjectType: entry.subject?.type ?? null,
    subjectId: entry.subject?.id ?? null,
    correlationId: correlationId ?? null,
    ip: entry.ip ?? ip ?? null,
    before: entry.before === undefined ? null : redact(entry.before),
    after: entry.after === undefined ? null : redact(entry.after),
  };
}

/** Records a change in the caller's transaction: it commits or rolls back with the change. The IP is `entry.ip`, else `ctx.ip`. */
export async function audit(ctx: ModuleContext, entry: AuditEntry): Promise<void> {
  await ctx.tx.insert(auditLog).values(row(ctx.tenantId, ctx.actor, ctx.correlationId, entry, ctx.ip));
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
  /** Only actions starting with one of these. */
  actionPrefixes?: string[];
  /** No action starting with one of these. */
  excludeActionPrefixes?: string[];
  /** Text in the action, subject type or id, or IP address; or an actor among `actorIds` (people or keys whose name matched). */
  search?: { text: string; actorIds: string[] };
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
};

/** The cursor carries `at` as Postgres text, so microseconds survive (JS Dates keep only milliseconds). */
const encodeCursor = (atText: string, id: string) => Buffer.from(JSON.stringify([atText, id])).toString('base64url');
function decodeCursor(cursor: string): [string, string] {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') {
      if (!Number.isNaN(Date.parse(v[0]))) return [v[0], v[1]];
    }
  } catch {
    // fall through
  }
  throw new ScoutError({ slug: 'invalid-cursor', status: 400, title: 'Invalid cursor' });
}

/** `value` with LIKE wildcards escaped, to match literally. */
export const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

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
  if (f.actionPrefixes) conds.push(or(...f.actionPrefixes.map((p) => like(auditLog.action, `${escapeLike(p)}%`))));
  if (f.excludeActionPrefixes?.length) {
    conds.push(not(or(...f.excludeActionPrefixes.map((p) => like(auditLog.action, `${escapeLike(p)}%`)))!));
  }
  if (f.search) {
    const t = `%${escapeLike(f.search.text)}%`;
    conds.push(
      or(
        ilike(auditLog.action, t),
        ilike(auditLog.subjectType, t),
        ilike(auditLog.subjectId, t),
        ilike(auditLog.ip, t),
        f.search.actorIds.length ? inArray(auditLog.actorId, f.search.actorIds) : undefined,
      ),
    );
  }
  if (f.cursor) {
    const [at, id] = decodeCursor(f.cursor);
    conds.push(
      or(
        sql`${auditLog.at} < ${at}::timestamptz`,
        and(sql`${auditLog.at} = ${at}::timestamptz`, sql`${auditLog.id} < ${id}`),
      ),
    );
  }
  const fetched = await ctx.tx
    .select({ row: auditLog, atText: sql<string>`${auditLog.at}::text` })
    .from(auditLog)
    .where(and(...conds))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(limit + 1);
  const page = fetched.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((p) => p.row),
    nextCursor: fetched.length > limit && last ? encodeCursor(last.atText, last.row.id) : null,
  };
}
