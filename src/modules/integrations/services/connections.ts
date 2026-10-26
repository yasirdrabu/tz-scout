import { and, asc, eq, gte, sql } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import { config } from '@/platform/config';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { connectionChanged, connectionTested } from '../contracts/events';
import { callLog, connection, credential } from '../db/schema';
import { ensureConnection, runCall } from '../gateway';
import { PROVIDERS, adapterFactories, isKnownProvider, type TestResult } from '../providers';
import { credentialAad, sealValue } from './vault';

export type ConnectionMode = 'mock' | 'live';
export type ConnectionStatus = 'not_set_up' | 'connected' | 'failing' | 'disabled';
export type CredentialKind = 'api_key' | 'private_app_token' | 'oauth_tokens' | 'client_secret';
export const CREDENTIAL_KINDS: readonly CredentialKind[] = ['api_key', 'private_app_token', 'oauth_tokens', 'client_secret'];

export type ConnectionView = {
  provider: string;
  name: string;
  mode: ConnectionMode;
  status: ConnectionStatus;
  hint?: string;
  lastTestedAt?: Date;
  lastTestResult?: TestResult;
  lastError?: string;
  callsToday: number;
};

export const TEST_FIRST = 'Test the connection before switching it to live.';
export const SAMPLE_ONLY = 'This environment uses sample data only.';
export const NOT_LIVE_YET = "This service can't run live yet.";
/** Values shorter than this keep no hint: the last 4 characters would be too much of the key. */
export const HINT_MIN_LENGTH = 12;
const TEST_VALID_MS = 10 * 60_000;
const TEST_TIMEOUT_MS = 10_000;

function requireProvider(provider: string): void {
  if (!isKnownProvider(provider)) {
    throw new ScoutError({ slug: 'unknown-provider', status: 404, title: 'Unknown integration' });
  }
}

/** Every provider, merged with what this tenant has set up. Providers with no row show as sample data, not set up. */
export async function listConnections(ctx: ModuleContext): Promise<ConnectionView[]> {
  const rows = await ctx.tx
    .select()
    .from(connection)
    .where(eq(connection.tenantId, ctx.tenantId))
    .orderBy(asc(connection.createdAt), asc(connection.id));
  const hints = await ctx.tx
    .select({ id: credential.id, hint: credential.hint })
    .from(credential)
    .where(eq(credential.tenantId, ctx.tenantId));
  const today = await ctx.tx
    .select({ provider: callLog.provider, n: sql<number>`count(*)::int` })
    .from(callLog)
    .where(and(eq(callLog.tenantId, ctx.tenantId), gte(callLog.at, sql`date_trunc('day', now())`)))
    .groupBy(callLog.provider);
  const hintById = new Map(hints.map((h) => [h.id, h.hint]));
  const callsBy = new Map(today.map((t) => [t.provider, t.n]));

  return PROVIDERS.map((p) => {
    const row = rows.find((r) => r.provider === p.key);
    const view: ConnectionView = {
      provider: p.key,
      name: p.name,
      mode: (row?.mode as ConnectionMode | undefined) ?? 'mock',
      status: (row?.status as ConnectionStatus | undefined) ?? 'not_set_up',
      callsToday: callsBy.get(p.key) ?? 0,
    };
    const hint = row?.credentialId ? hintById.get(row.credentialId) : undefined;
    if (hint) view.hint = hint;
    if (row?.lastTestedAt) view.lastTestedAt = row.lastTestedAt;
    if (row?.lastTestResult) view.lastTestResult = row.lastTestResult as TestResult;
    if (row?.lastError) view.lastError = row.lastError;
    return view;
  });
}

/**
 * Stores a credential, sealed with the master key. Only the last 4 characters are kept readable.
 * The previous credential stays for an hour (in-flight jobs), then `integrations.credentials.cleanup`
 * deletes it. A new credential has not been tested yet, so the last test result is cleared.
 */
export async function saveCredential(
  ctx: ModuleContext,
  provider: string,
  input: { kind: CredentialKind; value: string; expiresAt?: Date },
): Promise<{ hint: string | null }> {
  requireProvider(provider);
  const value = input.value.trim();
  if (!value) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Paste the key or token to save it.' });
  }
  if (!CREDENTIAL_KINDS.includes(input.kind)) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Unknown credential type.' });
  }
  const conn = await ensureConnection(ctx.tx, ctx.tenantId, provider, ctx.actor.id);
  const id = newId('cred');
  // Bound to tenant, connection and credential ids; throws master-key-missing before anything is stored.
  const sealed = sealValue(value, credentialAad(ctx.tenantId, conn.id, id));
  const hint = value.length >= HINT_MIN_LENGTH ? value.slice(-4) : null;
  await ctx.tx.insert(credential).values({
    id,
    tenantId: ctx.tenantId,
    connectionId: conn.id,
    kind: input.kind,
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    authTag: sealed.authTag,
    wrappedDataKey: sealed.wrappedDataKey,
    keyVersion: sealed.keyVersion,
    hint,
    expiresAt: input.expiresAt ?? null,
    rotatedAt: conn.credentialId ? new Date() : null,
  });
  if (conn.credentialId) {
    await ctx.tx
      .update(credential)
      .set({ replacedAt: sql`now()` })
      .where(and(eq(credential.tenantId, ctx.tenantId), eq(credential.id, conn.credentialId)));
  }
  await ctx.tx
    .update(connection)
    .set({
      credentialId: id,
      lastTestedAt: null,
      lastTestResult: null,
      consecutiveFailures: 0,
      updatedAt: sql`now()`,
    })
    .where(and(eq(connection.tenantId, ctx.tenantId), eq(connection.id, conn.id)));
  await audit(ctx, {
    action: 'integrations.credential.saved',
    subject: { type: 'connection', id: conn.id },
    after: { provider, kind: input.kind, hint },
  });
  return { hint };
}

class TestFailed extends Error {
  constructor(readonly result: TestResult) {
    super(result.message);
  }
}

/**
 * Runs the adapter's `test()` through the gateway (live adapter when a credential exists, otherwise
 * sample data), stores the result and publishes `integrations.connection.tested`.
 * Call it before this transaction writes to the same connection: the gateway commits in its own transaction.
 */
export async function testConnection(ctx: ModuleContext, provider: string): Promise<TestResult> {
  requireProvider(provider);
  const started = performance.now();
  let result: TestResult;
  try {
    result = await runCall(
      ctx,
      provider,
      `${provider}.test`,
      async (adapter, { scrub }) => {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new TestFailed({ ok: false, message: 'The service did not answer within 10 seconds.' })),
            TEST_TIMEOUT_MS,
          );
        });
        try {
          const raw = await Promise.race([adapter.test(), timeout]);
          const r: TestResult = {
            ...raw,
            message: scrub(raw.message),
            ...(raw.missingPermissions ? { missingPermissions: raw.missingPermissions.map(scrub) } : {}),
          };
          if (!r.ok) throw new TestFailed(r);
          return r;
        } finally {
          clearTimeout(timer);
        }
      },
      { module: 'integrations' },
      'test',
    );
  } catch (e) {
    if (e instanceof TestFailed) result = e.result;
    else if (e instanceof ScoutError) throw e;
    else result = { ok: false, message: e instanceof Error ? e.message.slice(0, 500) : 'The test failed.' };
  }
  const durationMs = Math.round(performance.now() - started);

  const conn = await ensureConnection(ctx.tx, ctx.tenantId, provider, ctx.actor.id);
  const status: ConnectionStatus = !result.ok ? 'failing' : conn.credentialId ? 'connected' : 'not_set_up';
  await ctx.tx
    .update(connection)
    .set({
      lastTestedAt: sql`now()`,
      lastTestResult: result,
      lastError: result.ok ? null : result.message,
      status,
      updatedAt: sql`now()`,
    })
    .where(and(eq(connection.tenantId, ctx.tenantId), eq(connection.id, conn.id)));
  await publish(
    ctx,
    connectionTested,
    { connectionId: conn.id, provider, ok: result.ok, message: result.message, durationMs },
    { type: 'connection', id: conn.id },
  );
  return result;
}

/** Live needs a credential and a passing test in the last 10 minutes. */
export async function setMode(ctx: ModuleContext, provider: string, mode: ConnectionMode): Promise<void> {
  requireProvider(provider);
  if (mode === 'live') {
    if (config.forceMock) throw new ScoutError({ slug: 'sample-data-only', status: 409, title: SAMPLE_ONLY });
    if (!adapterFactories(provider)?.live) {
      throw new ScoutError({ slug: 'live-unavailable', status: 409, title: NOT_LIVE_YET });
    }
  }
  const conn = await ensureConnection(ctx.tx, ctx.tenantId, provider, ctx.actor.id);
  if (mode === 'live') {
    const result = conn.lastTestResult as TestResult | null;
    const fresh = conn.lastTestedAt && Date.now() - conn.lastTestedAt.getTime() <= TEST_VALID_MS;
    if (!conn.credentialId || !result?.ok || !fresh) {
      throw new ScoutError({ slug: 'test-first', status: 409, title: TEST_FIRST });
    }
  }
  await ctx.tx
    .update(connection)
    .set({ mode, updatedAt: sql`now()` })
    .where(and(eq(connection.tenantId, ctx.tenantId), eq(connection.id, conn.id)));
  await audit(ctx, {
    action: 'integrations.connection.mode_changed',
    subject: { type: 'connection', id: conn.id },
    before: { mode: conn.mode },
    after: { provider, mode },
  });
  await publish(
    ctx,
    connectionChanged,
    { connectionId: conn.id, provider, mode, status: conn.status as ConnectionStatus, changedBy: ctx.actor.id },
    { type: 'connection', id: conn.id },
  );
}

/** Turns a connection off without deleting it; `gateway.call` then refuses it with `connection_disabled`. */
export async function setDisabled(ctx: ModuleContext, provider: string, disabled: boolean): Promise<void> {
  requireProvider(provider);
  const conn = await ensureConnection(ctx.tx, ctx.tenantId, provider, ctx.actor.id);
  const lastOk = (conn.lastTestResult as TestResult | null)?.ok === true;
  const status: ConnectionStatus = disabled ? 'disabled' : conn.credentialId && lastOk ? 'connected' : 'not_set_up';
  await ctx.tx
    .update(connection)
    .set({ status, consecutiveFailures: 0, updatedAt: sql`now()` })
    .where(and(eq(connection.tenantId, ctx.tenantId), eq(connection.id, conn.id)));
  await audit(ctx, {
    action: disabled ? 'integrations.connection.disabled' : 'integrations.connection.enabled',
    subject: { type: 'connection', id: conn.id },
    before: { status: conn.status },
    after: { provider, status },
  });
  await publish(
    ctx,
    connectionChanged,
    { connectionId: conn.id, provider, mode: conn.mode as ConnectionMode, status, changedBy: ctx.actor.id },
    { type: 'connection', id: conn.id },
  );
}

/** Mode, status and last error for one provider (sample data, not set up when there is no row yet). */
export async function connectionStatus(
  ctx: ModuleContext,
  provider: string,
): Promise<{ mode: ConnectionMode; status: ConnectionStatus; lastError?: string }> {
  requireProvider(provider);
  const [row] = await ctx.tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, ctx.tenantId), eq(connection.provider, provider)))
    .orderBy(asc(connection.createdAt), asc(connection.id))
    .limit(1);
  return {
    mode: (row?.mode as ConnectionMode | undefined) ?? 'mock',
    status: (row?.status as ConnectionStatus | undefined) ?? 'not_set_up',
    ...(row?.lastError ? { lastError: row.lastError } : {}),
  };
}
