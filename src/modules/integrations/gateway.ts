import { and, asc, eq, sql } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { withTenant, type Tx } from '@/platform/db/tenant';
import { ScoutError } from '@/platform/errors';
import { newId } from '@/platform/ids';
import { log } from '@/platform/log';
import { config } from '@/platform/config';
import { callLog, connection, credential } from './db/schema';
import { adapterFactories, isKnownProvider, providerName, type Adapter } from './providers';
import { credentialAad, openValue } from './services/vault';

/** Throw this from a call to log it as `rate_limited` (not counted as a failure). */
export class RateLimitedError extends Error {
  constructor(
    message = 'The service asked us to slow down.',
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

export type CallOpts = {
  units?: number;
  unit?: string;
  costCents?: number;
  apiKeyId?: string;
  /** Module making the call, for the call log. */
  module?: string;
  /** Non-secret facts about the request. Secrets, emails and phone numbers are dropped before it is stored. */
  requestSummary?: unknown;
};

const REDACT_KEY = /secret|token|password|key|authorization|email|phone/i;

/** Copy of `value` without any key that looks like a secret or personal data, at any depth. */
export function redactSummary(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value && typeof value === 'object') {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const out = Array.isArray(value)
      ? value.map((v) => redactSummary(v, seen))
      : Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([k]) => !REDACT_KEY.test(k))
            .map(([k, v]) => [k, redactSummary(v, seen)]),
        );
    seen.delete(value);
    return out;
  }
  return value;
}

const MAX_ERROR = 500;
export const FAILING_AFTER = 3;
const LOCK_TIMEOUT = '5s';

type ConnectionRow = typeof connection.$inferSelect;

async function findConnection(tx: Tx, tenantId: string, provider: string): Promise<ConnectionRow | undefined> {
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.provider, provider)))
    .orderBy(asc(connection.createdAt), asc(connection.id))
    .limit(1);
  return row;
}

/** One connection per provider here (the earliest). Creates the default row when none exists. */
export async function ensureConnection(
  tx: Tx,
  tenantId: string,
  provider: string,
  createdBy?: string,
): Promise<ConnectionRow> {
  await tx
    .insert(connection)
    .values({ id: newId('con'), tenantId, provider, name: providerName(provider), createdBy: createdBy ?? null })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.provider, provider)))
    .orderBy(asc(connection.createdAt), asc(connection.id))
    .limit(1);
  return row!;
}

type Prepared = { conn: ConnectionRow; cred?: typeof credential.$inferSelect };

/** Reads through the caller's transaction, so a credential saved earlier in it is visible. */
async function prepare(ctx: ModuleContext, provider: string, wantCredential: boolean): Promise<Prepared> {
  let conn = await findConnection(ctx.tx, ctx.tenantId, provider);
  if (!conn) {
    // Create the row in its own transaction so it is committed: the call log update below runs in
    // another transaction and could not see a row that only the caller's open transaction holds.
    await withTenant(ctx.tenantId, async (tx) => {
      await tx.execute(sql`select set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`);
      await ensureConnection(tx, ctx.tenantId, provider, ctx.actor.id);
    });
    conn = await findConnection(ctx.tx, ctx.tenantId, provider);
  }
  if (!conn) throw new Error('connection row missing');
  if (conn.status === 'disabled') {
    throw new ScoutError({
      slug: 'connection_disabled',
      status: 409,
      title: `${providerName(provider)} is turned off.`,
      detail: 'Turn the connection back on in Settings, Integrations.',
    });
  }
  if (!wantCredential || !conn.credentialId) return { conn };
  const [cred] = await ctx.tx
    .select()
    .from(credential)
    .where(and(eq(credential.tenantId, ctx.tenantId), eq(credential.id, conn.credentialId)));
  return cred ? { conn, cred } : { conn };
}

const trim = (s: string) => (s.length > MAX_ERROR ? s.slice(0, MAX_ERROR) : s);
const statusCodeOf = (e: unknown): number | null => {
  const o = e as { status?: unknown; statusCode?: unknown } | null;
  const v = o?.status ?? o?.statusCode;
  return typeof v === 'number' ? v : null;
};

/** Removes the credential value, and each whitespace-separated part of it (e.g. after "Bearer"), from text. */
export function makeScrub(value: string | undefined): (text: string) => string {
  const parts = value ? [value, ...value.split(/\s+/)].filter((p) => p.length >= 4) : [];
  parts.sort((x, y) => y.length - x.length);
  return (text) => parts.reduce((t, part) => t.split(part).join('[removed]'), text);
}

export type CallHelpers = { scrub: (text: string) => string };
type Mode = 'normal' | 'test';

/**
 * Runs `fn` with the right adapter, times it, and records it. The record and the status change are
 * written in their own transaction, so a failed call is logged even if the caller rolls back.
 * `mode: 'test'` (used by testConnection only) tries the live adapter whenever a credential exists,
 * so a connection can be tested before it is switched to live.
 * The credential is decrypted only when the live adapter will be used, and its value is removed from
 * every error message before it is logged, stored or rethrown.
 */
export async function runCall<T>(
  ctx: ModuleContext,
  provider: string,
  operation: string,
  fn: (adapter: Adapter, helpers: CallHelpers) => Promise<T>,
  opts: CallOpts = {},
  mode: Mode = 'normal',
): Promise<T> {
  if (!isKnownProvider(provider)) {
    throw new ScoutError({ slug: 'unknown-provider', status: 404, title: 'Unknown integration' });
  }
  const factories = adapterFactories(provider);
  if (!factories) {
    throw new ScoutError({
      slug: 'adapter-missing',
      status: 501,
      title: `${providerName(provider)} is not available yet.`,
    });
  }
  const mockOnly = config.forceMock || ctx.environment === 'test';
  const { conn, cred } = await prepare(ctx, provider, !mockOnly && !!factories.live);

  if (!mockOnly && mode === 'normal' && conn.mode === 'live' && (!cred || !factories.live)) {
    throw new ScoutError({
      slug: 'connection_not_ready',
      status: 409,
      title: `${providerName(provider)} is set to live but is not ready.`,
      detail: 'Save a credential and test the connection.',
    });
  }
  const useLive = !mockOnly && !!factories.live && !!cred && (mode === 'test' || conn.mode === 'live');

  const started = performance.now();
  let outcome: 'ok' | 'error' | 'rate_limited' = 'ok';
  let errorMessage: string | null = null;
  let statusCode: number | null = null;
  let thrown: unknown;
  let result!: T;
  let scrub = makeScrub(undefined);
  try {
    let adapter: Adapter;
    if (useLive && cred && factories.live) {
      let value: string;
      try {
        value = openValue(cred, credentialAad(cred.tenantId, cred.connectionId, cred.id));
      } catch {
        throw new ScoutError({
          slug: 'credential_unreadable',
          status: 409,
          title: "The saved key can't be read. Enter it again.",
        });
      }
      scrub = makeScrub(value);
      adapter = factories.live({
        kind: cred.kind,
        value,
        settings: (conn.settings ?? {}) as Record<string, unknown>,
      });
    } else adapter = factories.mock();
    result = await fn(adapter, { scrub });
  } catch (e) {
    outcome = e instanceof RateLimitedError || statusCodeOf(e) === 429 ? 'rate_limited' : 'error';
    errorMessage = trim(scrub(e instanceof Error ? e.message : String(e)));
    statusCode = outcome === 'rate_limited' ? 429 : statusCodeOf(e);
    if (e instanceof Error) {
      if (e.message !== scrub(e.message)) {
        if (e.stack) e.stack = scrub(e.stack);
        e.message = scrub(e.message);
      }
      thrown = e;
    } else thrown = new Error(errorMessage);
  }
  const durationMs = Math.round(performance.now() - started);

  try {
    await withTenant(ctx.tenantId, async (tx) => {
      await tx.execute(sql`select set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`);
      await tx.insert(callLog).values({
        id: newId('call'),
        tenantId: ctx.tenantId,
        connectionId: conn.id,
        provider,
        operation,
        module: opts.module ?? null,
        principalId: ctx.actor.id,
        apiKeyId: opts.apiKeyId ?? null,
        correlationId: ctx.correlationId,
        requestSummary: opts.requestSummary === undefined ? null : redactSummary(opts.requestSummary),
        statusCode,
        outcome,
        durationMs,
        units: outcome === 'ok' ? (opts.units ?? null) : null,
        unit: outcome === 'ok' ? (opts.unit ?? null) : null,
        costCents: outcome === 'ok' ? (opts.costCents ?? null) : null,
        errorMessage,
      });
      if (outcome === 'rate_limited') return;
      // Skip the status change when the caller's open transaction holds the row: it would wait for us.
      const locked = await tx.execute(
        sql`select 1 from integrations.connection where tenant_id = ${ctx.tenantId} and id = ${conn.id} for update skip locked`,
      );
      if (locked.length === 0) return;
      const where = and(eq(connection.tenantId, ctx.tenantId), eq(connection.id, conn.id));
      if (outcome === 'ok') {
        await tx
          .update(connection)
          .set({
            consecutiveFailures: 0,
            lastError: null,
            status: sql`case when ${connection.status} = 'disabled' then 'disabled' when ${connection.credentialId} is not null then 'connected' else 'not_set_up' end`,
            updatedAt: sql`now()`,
          })
          .where(where);
      } else {
        await tx
          .update(connection)
          .set({
            consecutiveFailures: sql`${connection.consecutiveFailures} + 1`,
            lastError: errorMessage,
            status: sql`case when ${connection.status} = 'disabled' then 'disabled' when ${connection.consecutiveFailures} + 1 >= ${FAILING_AFTER} then 'failing' else ${connection.status} end`,
            updatedAt: sql`now()`,
          })
          .where(where);
      }
    });
  } catch (bookkeeping) {
    // The outside call already happened; do not turn it into a failure for the caller.
    log.error({ err: bookkeeping, tenantId: ctx.tenantId, provider, operation }, 'integrations: could not write call log');
  }

  if (outcome !== 'ok') throw thrown;
  return result;
}

export const gateway = {
  /**
   * The only way code outside this module reaches an outside service. Refuses disabled connections
   * (`connection_disabled`), picks the mock or live adapter, times the call and logs it. Test API keys
   * (`ctx.environment === 'test'`) and SCOUT_FORCE_MOCK always get the mock.
   */
  call<T>(
    ctx: ModuleContext,
    provider: string,
    operation: string,
    fn: (adapter: Adapter) => Promise<T>,
    opts?: CallOpts,
  ): Promise<T> {
    return runCall(ctx, provider, operation, fn, opts);
  },
};
