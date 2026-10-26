import { and, asc, eq, sql } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { withTenant, type Tx } from '@/platform/db/tenant';
import { ScoutError } from '@/platform/errors';
import { newId } from '@/platform/ids';
import { log } from '@/platform/log';
import { config } from '@/platform/config';
import { callLog, connection, credential } from './db/schema';
import { adapterFactories, isKnownProvider, providerName, type Adapter, type LiveCredentials } from './providers';
import { openValue } from './services/vault';

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
  /** Test API keys always get the mock adapter. */
  principal?: { environment?: string };
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

type Prepared = { conn: ConnectionRow; creds?: LiveCredentials };

async function prepare(ctx: ModuleContext, provider: string, wantLive: boolean): Promise<Prepared> {
  return withTenant(ctx.tenantId, async (tx) => {
    await tx.execute(sql`select set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`);
    const conn = await ensureConnection(tx, ctx.tenantId, provider, ctx.actor.id);
    if (conn.status === 'disabled') {
      throw new ScoutError({
        slug: 'connection_disabled',
        status: 409,
        title: `${providerName(provider)} is turned off.`,
        detail: 'Turn the connection back on in Settings, Integrations.',
      });
    }
    if (!wantLive || !conn.credentialId) return { conn };
    const [cred] = await tx
      .select()
      .from(credential)
      .where(and(eq(credential.tenantId, ctx.tenantId), eq(credential.id, conn.credentialId)));
    if (!cred) return { conn };
    return {
      conn,
      creds: { kind: cred.kind, value: openValue(cred), settings: (conn.settings ?? {}) as Record<string, unknown> },
    };
  });
}

const trim = (s: string) => (s.length > MAX_ERROR ? s.slice(0, MAX_ERROR) : s);
const statusCodeOf = (e: unknown): number | null => {
  const o = e as { status?: unknown; statusCode?: unknown } | null;
  const v = o?.status ?? o?.statusCode;
  return typeof v === 'number' ? v : null;
};

type Mode = 'normal' | 'test';

/**
 * Runs `fn` with the right adapter, times it, and records it. The record and the status change are
 * written in their own transaction, so a failed call is logged even if the caller rolls back.
 * `mode: 'test'` (used by testConnection only) tries the live adapter whenever a credential exists,
 * so a connection can be tested before it is switched to live.
 */
export async function runCall<T>(
  ctx: ModuleContext,
  provider: string,
  operation: string,
  fn: (adapter: Adapter) => Promise<T>,
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
  const mockOnly = config.forceMock || opts.principal?.environment === 'test';
  const { conn, creds } = await prepare(ctx, provider, !mockOnly && !!factories.live);

  let adapter: Adapter;
  if (mockOnly) adapter = factories.mock();
  else if (mode === 'test') adapter = creds && factories.live ? factories.live(creds) : factories.mock();
  else if (conn.mode === 'live') {
    if (!creds || !factories.live) {
      throw new ScoutError({
        slug: 'connection_not_ready',
        status: 409,
        title: `${providerName(provider)} is set to live but is not ready.`,
        detail: 'Save a credential and test the connection.',
      });
    }
    adapter = factories.live(creds);
  } else adapter = factories.mock();

  const started = performance.now();
  let outcome: 'ok' | 'error' | 'rate_limited' = 'ok';
  let errorMessage: string | null = null;
  let statusCode: number | null = null;
  let thrown: unknown;
  let result!: T;
  try {
    result = await fn(adapter);
  } catch (e) {
    thrown = e;
    outcome = e instanceof RateLimitedError || statusCodeOf(e) === 429 ? 'rate_limited' : 'error';
    errorMessage = trim(e instanceof Error ? e.message : String(e));
    statusCode = outcome === 'rate_limited' ? 429 : statusCodeOf(e);
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
      const where = and(eq(connection.tenantId, ctx.tenantId), eq(connection.id, conn.id));
      if (outcome === 'ok') {
        await tx
          .update(connection)
          .set({
            consecutiveFailures: 0,
            lastError: null,
            status: sql`case when ${connection.status} = 'disabled' then 'disabled' else 'connected' end`,
            updatedAt: sql`now()`,
          })
          .where(where);
      } else if (outcome === 'error') {
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
   * (`connection_disabled`), picks the mock or live adapter, times the call and logs it.
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
