import { and, asc, eq, sql } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { withTenant, type Tx } from '@/platform/db/tenant';
import { ScoutError } from '@/platform/errors';
import { newId } from '@/platform/ids';
import { log } from '@/platform/log';
import { config } from '@/platform/config';
import { publish } from '@/platform/events/outbox';
import { registerInboundRoute } from '@/modules/tenancy';
import { usageRecorded } from './contracts/events';
import { callLog, connection, credential } from './db/schema';
import { adapterFactories, isKnownProvider, needsCredential, providerName, type Adapter } from './providers';
import { CATEGORY_OF_PROVIDER } from './contracts/costs';
import { budgetPaused, capUnit, isPaused, LOCK_TIMEOUT, recordUsage, reserve, settle, type Reservation } from './services/caps';
import type { CapUnit } from './domain/caps';
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

/**
 * Pass the amount up front (`units` with `unit: 'credits'`, or `reserveCents`/`costCents`) so a call
 * can be refused before it spends; an amount only known from `measure` still counts, but cannot stop the call.
 */
export type CallOpts = {
  units?: number;
  unit?: string;
  costCents?: number;
  /** Most the call could cost, held against a cents limit before the call (else `costCents`). */
  reserveCents?: number;
  apiKeyId?: string;
  /** The account the call is for, when the caller knows it: carried on `integrations.usage.recorded`. */
  accountId?: string;
  /** The source the call is for, when the caller knows it: carried on `integrations.usage.recorded`. */
  sourceId?: string;
  /**
   * Called with the result after a successful call; its units and cost are logged (use when they are only known afterwards).
   * `live` says whether the live adapter answered: only a live call is priced (R3a Ruling 2). It runs after the
   * outside call, when a timed-out caller's transaction may be gone, so read any rates before the call.
   */
  measure?: (result: never, call: { live: boolean }) => Measured;
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

type Measured = { units?: number; costCents?: number };

/** A usable amount: finite and 0 or more, else undefined. */
const amountOf = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined);

/**
 * Ruling 5: what a call counts against a limit in `unit`, as an estimate before the call or, with
 * `measured`, after it. A calls limit counts every call; a credits limit only calls whose unit is credits.
 */
function capAmount(unit: CapUnit, opts: CallOpts, measured?: Measured): number {
  if (unit === 'calls') return 1;
  if (unit === 'credits') return opts.unit === 'credits' ? (amountOf(measured?.units) ?? amountOf(opts.units) ?? 0) : 0;
  return measured
    ? (amountOf(measured.costCents) ?? amountOf(opts.costCents) ?? 0)
    : (amountOf(opts.reserveCents) ?? amountOf(opts.costCents) ?? 0);
}

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

/**
 * One connection per provider here (the earliest). Creates the default row when none exists, and
 * registers a new one with tenancy so its inbound webhooks find this tenant (D35).
 */
export async function ensureConnection(
  tx: Tx,
  tenantId: string,
  provider: string,
  createdBy?: string,
): Promise<ConnectionRow> {
  const [made] = await tx
    .insert(connection)
    .values({ id: newId('con'), tenantId, provider, name: providerName(provider), createdBy: createdBy ?? null })
    .onConflictDoNothing()
    .returning({ id: connection.id });
  if (made) {
    await registerInboundRoute({ tenantId, actor: { kind: 'system', id: 'integrations' }, correlationId: newId('cor'), tx }, made.id);
  }
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
  // A provider that needs no key (the company website) is ready without a credential.
  const keyless = !needsCredential(provider);
  const ready = !!cred || keyless;

  if (!mockOnly && mode === 'normal' && conn.mode === 'live' && (!ready || !factories.live)) {
    throw new ScoutError({
      slug: 'connection_not_ready',
      status: 409,
      title: `${providerName(provider)} is set to live but is not ready.`,
      detail: 'Save a credential and test the connection.',
    });
  }
  const useLive = !mockOnly && !!factories.live && ready && (mode === 'test' || conn.mode === 'live');
  const logBase = {
    tenantId: ctx.tenantId,
    connectionId: conn.id,
    provider,
    operation,
    module: opts.module ?? null,
    principalId: ctx.actor.id,
    apiKeyId: opts.apiKeyId ?? null,
    correlationId: ctx.correlationId,
    requestSummary: opts.requestSummary === undefined ? null : redactSummary(opts.requestSummary),
  };

  // Ruling 8: a refusal is logged, and no outside call is made.
  const logRefusal = async (errorMessage: string) => {
    try {
      await withTenant(ctx.tenantId, async (tx) => {
        await tx.execute(sql`select set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`);
        await tx.insert(callLog).values({
          ...logBase,
          id: newId('call'),
          statusCode: null,
          outcome: 'blocked_by_cap',
          durationMs: 0,
          errorMessage,
        });
      });
    } catch (bookkeeping) {
      log.error({ err: bookkeeping, tenantId: ctx.tenantId, provider, operation }, 'integrations: could not write call log');
    }
  };

  // R3a Ruling 9: a paid provider whose category is over its budget this tenant month waits, live or sample.
  // A connection test is not work that waits, so an owner can still check a key while paused.
  if (mode === 'normal' && (await isPaused(ctx, provider))) {
    const e = budgetPaused(CATEGORY_OF_PROVIDER[provider]!);
    await logRefusal(e.detail!);
    throw e;
  }

  // Ruling 6: hold the call's share of the provider's limit before it is made. A call with no
  // up-front amount in the limit's unit is neither held nor refused; what it spends is counted after.
  const unit = await capUnit(ctx, provider);
  let reservation: Reservation = { reservationId: null, level: 'ok' };
  const estimate = unit ? capAmount(unit, opts) : 0;
  if (estimate > 0) {
    try {
      reservation = await reserve(ctx, provider, estimate);
    } catch (e) {
      if (e instanceof ScoutError && e.slug === 'blocked_by_cap') await logRefusal(e.message);
      throw e;
    }
  }

  const started = performance.now();
  let outcome: 'ok' | 'error' | 'rate_limited' = 'ok';
  let errorMessage: string | null = null;
  let statusCode: number | null = null;
  let thrown: unknown;
  let result!: T;
  let scrub = makeScrub(undefined);
  let measured: Measured = {};
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
    } else if (useLive && factories.live) {
      adapter = factories.live({ kind: 'none', value: '', settings: (conn.settings ?? {}) as Record<string, unknown> });
    } else adapter = factories.mock(ctx);
    result = await fn(adapter, { scrub });
    try {
      const m = (opts.measure as ((r: T, call: { live: boolean }) => Measured) | undefined)?.(result, { live: useLive }) ?? {};
      // A value that is not a usable amount falls back to the one given up front.
      measured = { units: amountOf(m.units), costCents: amountOf(m.costCents) };
    } catch {
      measured = {};
    }
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
      const callId = newId('call');
      const units = outcome === 'ok' ? (measured.units ?? opts.units ?? null) : null;
      const costCents = outcome === 'ok' ? (measured.costCents ?? opts.costCents ?? null) : null;
      const [row] = await tx
        .insert(callLog)
        .values({
          ...logBase,
          id: callId,
          statusCode,
          outcome,
          durationMs,
          units,
          unit: outcome === 'ok' ? (opts.unit ?? null) : null,
          costCents,
          errorMessage,
        })
        .returning({ at: callLog.at });
      // R3a Ruling 3: a live call that cost money is usage, committed with its call log row and dated by it. The event
      // is checked before it is published, so a bad one is logged and dropped instead of rolling back the row.
      if (useLive && costCents !== null && costCents > 0) {
        const usage = usageRecorded.data.safeParse({
          callId,
          provider,
          operation,
          module: logBase.module,
          units,
          unit: opts.unit ?? null,
          costCents,
          accountId: opts.accountId ?? null,
          ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
          correlationId: ctx.correlationId,
          occurredAt: row!.at.toISOString(),
        });
        if (usage.success) await publish({ ...ctx, tx }, usageRecorded, usage.data);
        else log.error({ err: usage.error, tenantId: ctx.tenantId, provider, operation }, 'integrations: usage event not valid, not published');
      }
      if (unit) {
        // Review Focus 3: a failed call releases its reservation and adds only what it spent: one
        // call against a calls limit (it reached the service), nothing against credits or cents.
        const actual = outcome === 'ok' ? capAmount(unit, opts, measured) : unit === 'calls' ? 1 : 0;
        // In a savepoint, so a failure here cannot lose the call log row; the reservation then stays
        // held until the period ends (Ruling 6).
        try {
          await tx.transaction(async (sp) => {
            if (reservation.reservationId) await settle(ctx, reservation, actual, sp);
            else await recordUsage(ctx, provider, actual, sp);
          });
        } catch (err) {
          log.error({ err, tenantId: ctx.tenantId, provider, operation }, 'integrations: could not settle usage');
        }
      }
      if (outcome === 'rate_limited') return;
      // Only calls that reached the real service say anything about the connection's health:
      // a sample-data success must not mark a never-tested credential as connected.
      // A provider with no key (the company website) has no credential to go bad: a failed call is the target's
      // fault (one company's site down), so it never moves the connection's health.
      if (!useLive || keyless) return;
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
