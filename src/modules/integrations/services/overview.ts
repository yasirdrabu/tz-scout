import { and, asc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import { tenantTimezone } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { scrubError } from '@/platform/scrub-error';
import { CREDENTIAL_LABELS, providerGroup } from '../domain/labels';
import { callLog, connection, credential } from '../db/schema';
import { PROVIDERS, needsCredential, providerName } from '../providers';
import { periodBounds } from '../domain/caps';
import { listCaps, type CapView } from './caps';
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
  /** Calls since the tenant's local midnight, not counting calls a limit refused; with a daily calls limit, the limit's own count. */
  callsToday: number;
  /** The limit of a daily calls limit, else null. */
  callsTodayCap: number | null;
  /** The service's usage limit with this period's usage, null when it has none. */
  cap: CapView | null;
  errorsToday: number;
  /** Average response time of today's calls, null when there were none. */
  avgMs: number | null;
  credentials: IntegrationCredential[];
  /** False for a service that needs no key (the company website): the screen shows no key field. */
  needsCredential: boolean;
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
  const timeZone = await tenantTimezone(ctx);
  const day = periodBounds('day', new Date(), timeZone);
  const caps = await listCaps(ctx);
  const today = await ctx.tx
    .select({
      provider: callLog.provider,
      n: sql<number>`count(*)::int`,
      errors: sql<number>`(count(*) filter (where ${callLog.outcome} <> 'ok'))::int`,
      avg: sql<number>`round(avg(${callLog.durationMs}))::int`,
    })
    .from(callLog)
    .where(
      and(
        eq(callLog.tenantId, ctx.tenantId),
        inArray(callLog.provider, keys),
        ne(callLog.outcome, 'blocked_by_cap'),
        gte(callLog.at, sql`(${day.start}::date)::timestamp at time zone ${timeZone}`),
      ),
    )
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
    const cap = caps.find((c) => c.providerKey === key) ?? null;
    const dailyCalls = cap?.unit === 'calls' && cap.period === 'day' ? cap : null;
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
      // With a daily calls limit, "n of cap" counts what the limit counts, so the two never disagree.
      callsToday: dailyCalls ? dailyCalls.used : (usage?.n ?? 0),
      callsTodayCap: dailyCalls ? dailyCalls.limit : null,
      cap,
      errorsToday: usage?.errors ?? 0,
      avgMs: usage ? usage.avg : null,
      needsCredential: needsCredential(key),
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
