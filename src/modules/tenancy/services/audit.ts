import { and, eq, ilike, inArray, isNotNull, or } from 'drizzle-orm';
import { escapeLike, listAudit, type AuditRow } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { areaOf, areaPrefixes, type AuditArea } from '../domain/audit-areas';
import { apiKey, membership, user } from '../db/schema';

export type AuditEntryView = AuditRow & {
  area: AuditArea;
  /** The person's name, or the key's name for a key; null for the system or an unknown id. */
  actorName: string | null;
  apiKeyName: string | null;
};

export type AuditQuery = {
  /** Finds an action, a target (subject type or id), an IP address, or a person or key by name or email. */
  q?: string;
  area?: AuditArea;
  /** Who: a person's user id or a key id. */
  actorId?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
};

/** The tenant's audit log, newest first, with the area of each entry and the names behind the ids. */
export async function auditEntries(
  ctx: ModuleContext,
  query: AuditQuery,
): Promise<{ data: AuditEntryView[]; nextCursor: string | null }> {
  const text = query.q?.trim();
  let search: { text: string; actorIds: string[] } | undefined;
  if (text) {
    const pattern = `%${escapeLike(text)}%`;
    // People who can act here: this tenant's members (any status, so history still matches) and
    // platform admins (support access). Keys: this tenant's.
    const people = await ctx.tx
      .selectDistinct({ id: user.id })
      .from(user)
      .leftJoin(membership, and(eq(membership.userId, user.id), eq(membership.tenantId, ctx.tenantId)))
      .where(
        and(
          or(isNotNull(membership.id), eq(user.platformAdmin, true)),
          or(ilike(user.name, pattern), ilike(user.email, pattern)),
        ),
      );
    const keys = await ctx.tx
      .select({ id: apiKey.id })
      .from(apiKey)
      .where(and(eq(apiKey.tenantId, ctx.tenantId), ilike(apiKey.name, pattern)));
    search = { text, actorIds: [...people, ...keys].map((r) => r.id) };
  }
  const area = query.area;
  const { rows, nextCursor } = await listAudit(ctx, {
    actorId: query.actorId,
    from: query.from,
    to: query.to,
    cursor: query.cursor,
    limit: query.limit,
    search,
    ...(area === 'other' ? { excludeActionPrefixes: areaPrefixes(area) } : area ? { actionPrefixes: areaPrefixes(area) } : {}),
  });

  const userIds = [...new Set(rows.filter((r) => r.actorKind === 'user').map((r) => r.actorId))];
  const keyIds = [
    ...new Set(rows.flatMap((r) => [r.apiKeyId, r.actorKind === 'agent' ? r.actorId : null]).filter((id): id is string => !!id)),
  ];
  const names = new Map<string, string>();
  if (userIds.length) {
    for (const u of await ctx.tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds))) {
      names.set(u.id, u.name);
    }
  }
  if (keyIds.length) {
    const keys = await ctx.tx
      .select({ id: apiKey.id, name: apiKey.name })
      .from(apiKey)
      .where(and(eq(apiKey.tenantId, ctx.tenantId), inArray(apiKey.id, keyIds)));
    for (const k of keys) names.set(k.id, k.name);
  }
  return {
    data: rows.map((r) => ({
      ...r,
      area: areaOf(r.action),
      actorName: r.actorKind === 'system' ? null : (names.get(r.actorId) ?? null),
      apiKeyName: r.apiKeyId ? (names.get(r.apiKeyId) ?? null) : null,
    })),
    nextCursor,
  };
}
