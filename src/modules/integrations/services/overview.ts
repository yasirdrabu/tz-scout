import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { scrubError } from '@/platform/scrub-error';
import { CREDENTIAL_LABELS, providerGroup } from '../domain/labels';
import { callLog, connection, credential } from '../db/schema';
import { PROVIDERS, providerName } from '../providers';
import { requireProvider, type ConnectionMode, type ConnectionStatus } from './connections';

/** A saved credential as the screen shows it: never the value, only its last 4 characters (null for short values). */
export type IntegrationCredential = { kind: string; label: string; last4: string | null; savedAt: Date };

/** One service on the Integrations screen (screens.md §21b). */
export type IntegrationRow = {
  key: string;
  name: string;
  usedFor: string;
  group: string;
  mode: ConnectionMode;
  status: ConnectionStatus;
  lastError: string | null;
  lastTestedAt: Date | null;
  lastCallAt: Date | null;
  callsToday: number;
  /** Usage caps arrive in R1d; null until then. */
  callsTodayCap: null;
  errorsToday: number;
  /** Average response time of today's calls, null when there were none. */
  avgMs: number | null;
  credentials: IntegrationCredential[];
};

/** Microsoft sign-in is set up for all of Scout, not per workspace, so it is not a row (screens.md §21b). */
const NOT_LISTED = new Set(['microsoft']);

async function rowsFor(ctx: ModuleContext, keys: string[]): Promise<IntegrationRow[]> {
  const conns = await ctx.tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, ctx.tenantId), inArray(connection.provider, keys)))
    .orderBy(asc(connection.createdAt), asc(connection.id));
  const creds = await ctx.tx
    .select({ connectionId: credential.connectionId, kind: credential.kind, hint: credential.hint, createdAt: credential.createdAt })
    .from(credential)
    .where(and(eq(credential.tenantId, ctx.tenantId), isNull(credential.replacedAt)))
    .orderBy(asc(credential.createdAt), asc(credential.id));
  const today = await ctx.tx
    .select({
      provider: callLog.provider,
      n: sql<number>`count(*)::int`,
      errors: sql<number>`(count(*) filter (where ${callLog.outcome} <> 'ok'))::int`,
      avg: sql<number>`round(avg(${callLog.durationMs}))::int`,
    })
    .from(callLog)
    .where(and(eq(callLog.tenantId, ctx.tenantId), inArray(callLog.provider, keys), gte(callLog.at, sql`date_trunc('day', now())`)))
    .groupBy(callLog.provider);
  const lasts = await ctx.tx
    .select({ provider: callLog.provider, at: sql<string>`max(${callLog.at})` })
    .from(callLog)
    .where(and(eq(callLog.tenantId, ctx.tenantId), inArray(callLog.provider, keys)))
    .groupBy(callLog.provider);

  return keys.map((key) => {
    const p = PROVIDERS.find((x) => x.key === key);
    const row = conns.find((r) => r.provider === key);
    const usage = today.find((u) => u.provider === key);
    const last = lasts.find((l) => l.provider === key);
    return {
      key,
      name: p?.name ?? providerName(key),
      usedFor: p?.usedFor ?? '',
      group: providerGroup(p?.interfaceOwner ?? ''),
      mode: (row?.mode as ConnectionMode | undefined) ?? 'mock',
      status: (row?.status as ConnectionStatus | undefined) ?? 'not_set_up',
      lastError: row?.lastError ? scrubError(row.lastError) : null,
      lastTestedAt: row?.lastTestedAt ?? null,
      lastCallAt: last ? new Date(last.at) : null,
      callsToday: usage?.n ?? 0,
      callsTodayCap: null,
      errorsToday: usage?.errors ?? 0,
      avgMs: usage ? usage.avg : null,
      credentials: row
        ? creds
            .filter((c) => c.connectionId === row.id)
            .map((c) => ({ kind: c.kind, label: CREDENTIAL_LABELS[c.kind] ?? c.kind, last4: c.hint, savedAt: c.createdAt }))
        : [],
    };
  });
}

/** Every service a workspace connects, in the shared provider order. */
export async function listIntegrations(ctx: ModuleContext): Promise<IntegrationRow[]> {
  return rowsFor(
    ctx,
    PROVIDERS.filter((p) => !NOT_LISTED.has(p.key)).map((p) => p.key),
  );
}

/** One service, shaped as in `listIntegrations`. 404 for an unknown key. */
export async function integration(ctx: ModuleContext, key: string): Promise<IntegrationRow> {
  requireProvider(key);
  return (await rowsFor(ctx, [key]))[0]!;
}
