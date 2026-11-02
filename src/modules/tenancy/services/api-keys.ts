import { createHash, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { controlAdminDb } from '@/platform/db/client';
import { withControlTenant } from '@/platform/db/doors';
import { withTenant } from '@/platform/db/tenant';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { log } from '@/platform/log';
import { apiKeyCreated, apiKeyRevoked } from '../contracts/events';
import type { Principal } from '../contracts/principal';
import { sourceValidator } from '../contracts/source-validator';
import { DataLimitSchema, defaultDataLimit, isWithin, type DataLimit } from '../domain/data-limit';
import { PERMISSIONS, isPermission, type Permission } from '../domain/permissions';
import { KEY_ACCESS, keyMask, type KeyAccess } from '../domain/key-access';
import { apiKey, tenant, user } from '../db/schema';
import { onControl } from './control';

export const NEEDS_SOURCE_LATER = 'Pick the source this key sends for.';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const TOKEN = /^scout_(live|test)_([0-9A-Za-z]{32})$/;
const PREFIX_RANDOM = 8;
const LAST_USED_EVERY_MS = 60_000;

const keyRevoked = () =>
  new ScoutError({
    slug: 'key-revoked',
    status: 401,
    title: 'This key was revoked.',
  });
const keyExpired = () =>
  new ScoutError({
    slug: 'key-expired',
    status: 401,
    title: 'This key has expired.',
  });
const validation = (slug: string, title: string) => new ScoutError({ slug, status: 400, title });

function randomBase62(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += BASE62[randomInt(BASE62.length)];
  return s;
}

/** What the creator may hand out: a key can never exceed it. */
export type Grantor = { permissions: readonly Permission[]; dataLimit: DataLimit };

/** For creation by the platform itself (the CLI). */
export const SYSTEM_GRANTOR: Grantor = { permissions: PERMISSIONS, dataLimit: { kind: 'all' } };

export type CreateApiKeyInput = {
  name: string;
  environment: 'live' | 'test';
  scopes: Permission[];
  dataLimit?: DataLimit;
  sourceId?: string;
  expiresAt?: Date;
};

/**
 * Creates a key. The full secret is returned once and never stored: only the prefix and an
 * argon2id hash are kept. Defaults: 600 calls a minute, 500 arrivals a day, no credit spend.
 */
export async function createApiKey(
  ws: ModuleContext,
  input: CreateApiKeyInput,
  grantor: Grantor,
): Promise<{ id: string; secret: string }> {
  return onControl(ws, async (ctx) => {
    const name = input.name.trim();
    if (!name) throw validation('validation', 'Give the key a name.');
    if (!Array.isArray(input.scopes) || !input.scopes.every(isPermission)) {
      throw validation('invalid-permission', 'That permission does not exist.');
    }
    if (input.environment !== 'live' && input.environment !== 'test') {
      throw validation('validation', 'Environment must be live or test.');
    }
    const scopes = [...new Set(input.scopes)];
    for (const s of scopes) {
      if (!grantor.permissions.includes(s)) {
        throw new ScoutError({
          slug: 'scope-not-available',
          status: 403,
          title: 'Not available to you',
          detail: `You can't give a key the \`${s}\` scope because you don't have it.`,
        });
      }
    }
    let dataLimit: DataLimit | null = null;
    if (input.dataLimit) {
      const parsed = DataLimitSchema.safeParse(input.dataLimit);
      if (!parsed.success) throw validation('validation', 'Check the data limit.');
      dataLimit = parsed.data;
      if (!isWithin(dataLimit, grantor.dataLimit)) {
        throw new ScoutError({
          slug: 'scope-not-available',
          status: 403,
          title: 'Not available to you',
          detail: "You can't give a key access to more accounts than you can see yourself.",
        });
      }
    }

    if (scopes.includes('arrivals:write')) {
      const v = sourceValidator();
      if (!v) throw validation('source-required', NEEDS_SOURCE_LATER);
      if (!input.sourceId) throw validation('source-required', 'Keys that send accounts need a source.');
      if (!(await v.exists(ws, input.sourceId))) throw validation('source-not-found', 'That source was not found.');
    } else if (input.sourceId) {
      const v = sourceValidator();
      if (v && !(await v.exists(ws, input.sourceId))) throw validation('source-not-found', 'That source was not found.');
    }

    const head = `scout_${input.environment}_`;
    const id = newId('key');
    let secret = '';
    let prefix = '';
    for (let attempt = 0; ; attempt++) {
      const random = randomBase62(32);
      secret = head + random;
      prefix = head + random.slice(0, PREFIX_RANDOM);
      const secretHash = await hash(secret); // argon2id by default
      try {
        // A savepoint, so a prefix clash does not abort the caller's transaction.
        await ctx.tx.transaction((sp) =>
          sp.insert(apiKey).values({
            id,
            tenantId: ctx.tenantId,
            name,
            prefix,
            secretHash,
            environment: input.environment,
            scopes,
            dataLimit,
            sourceId: input.sourceId ?? null,
            rateLimitPerMinute: 600,
            dailyArrivalCap: 500,
            monthlyEnrichmentCreditCap: 0,
            createdBy: ctx.actor.id,
            expiresAt: input.expiresAt ?? null,
          }),
        );
        break;
      } catch (e) {
        const err = e as { code?: string; cause?: { code?: string } };
        if ((err.code ?? err.cause?.code) === '23505' && attempt === 0) continue;
        throw e;
      }
    }
    // The key commits on the control plane; if the request's workspace transaction then fails (the
    // source it sends for is not kept, say), it is revoked, so no working key is left behind.
    ws.onRollback?.(() => revokeOrphan(ws, id));
    await publish(
      ctx,
      apiKeyCreated,
      {
        keyId: id,
        name,
        prefix,
        environment: input.environment,
        scopes,
        sourceId: input.sourceId ?? null,
        createdBy: ctx.actor.id,
      },
      { type: 'api_key', id },
    );
    await audit(ws, {
      action: 'tenancy.api_key.created',
      subject: { type: 'api_key', id },
      after: {
        name,
        prefix,
        environment: input.environment,
        scopes,
        sourceId: input.sourceId ?? null,
      },
    });
    return { id, secret };
  });
}

/** Revokes a key whose request failed after it was made, in a new workspace transaction; nothing when it was never kept. */
async function revokeOrphan(ws: ModuleContext, id: string): Promise<void> {
  try {
    await withTenant(ws.tenantId, (tx) => revokeApiKey({ ...ws, tx, onRollback: undefined }, id, 'The request that made it failed'));
  } catch (e) {
    if (!(e instanceof ScoutError && e.slug === 'not-found')) throw e;
  }
}

/**
 * Puts back a key revoked by a request that then failed (its revoke committed on the control plane, the
 * rest did not), unless something revoked it again since. The `tenancy.api_key.revoked` event already
 * sent stays sent.
 */
async function restoreRevoked(ws: ModuleContext, id: string, revokedAt: Date): Promise<void> {
  await withControlTenant(ws.tenantId, (tx) =>
    tx
      .update(apiKey)
      .set({ revokedAt: null })
      .where(and(eq(apiKey.id, id), eq(apiKey.tenantId, ws.tenantId), eq(apiKey.revokedAt, revokedAt))),
  );
}

/**
 * Revokes a key. Requests with it fail within 60 seconds on every instance (the cache lifetime). When
 * the request's workspace transaction then fails, the key is put back (`onRollback`).
 */
export async function revokeApiKey(ws: ModuleContext, id: string, reason: string): Promise<void> {
  return onControl(ws, async (ctx) => {
    const revokedAt = new Date();
    const rows = await ctx.tx
      .update(apiKey)
      .set({ revokedAt })
      .where(and(eq(apiKey.id, id), eq(apiKey.tenantId, ctx.tenantId), isNull(apiKey.revokedAt)))
      .returning({ id: apiKey.id, prefix: apiKey.prefix });
    if (rows.length === 0) {
      throw new ScoutError({
        slug: 'not-found',
        status: 404,
        title: 'That key was not found.',
      });
    }
    ws.onRollback?.(() => restoreRevoked(ws, id, revokedAt));
    evictPrefix(rows[0]!.prefix);
    await publish(ctx, apiKeyRevoked, { keyId: id, reason, revokedBy: ctx.actor.id }, { type: 'api_key', id });
    await audit(ws, {
      action: 'tenancy.api_key.revoked',
      subject: { type: 'api_key', id },
      after: { reason },
    });
  });
}

/** One key as the API keys screen lists it (§21c). The secret is never returned after creation. */
export type ApiKeyView = {
  id: string;
  name: string;
  prefix: string;
  mask: string;
  environment: 'live' | 'test';
  scopes: Permission[];
  sourceId: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

/** The tenant's keys, newest first; only one source's with `sourceId`, only one key with `id`. */
export async function listApiKeys(ws: ModuleContext, f: { sourceId?: string; id?: string } = {}): Promise<ApiKeyView[]> {
  return onControl(ws, async (ctx) => {
    const rows = await ctx.tx
      .select({ k: apiKey, createdByName: user.name })
      .from(apiKey)
      .leftJoin(user, eq(user.id, apiKey.createdBy))
      .where(
        and(
          eq(apiKey.tenantId, ctx.tenantId),
          f.sourceId ? eq(apiKey.sourceId, f.sourceId) : undefined,
          f.id ? eq(apiKey.id, f.id) : undefined,
        ),
      )
      .orderBy(desc(apiKey.createdAt), desc(apiKey.id));
    return rows.map(({ k, createdByName }) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      mask: keyMask(k.prefix),
      environment: k.environment === 'test' ? 'test' : 'live',
      scopes: k.scopes.filter(isPermission),
      sourceId: k.sourceId,
      createdBy: k.createdBy,
      createdByName,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      lastUsedIp: k.lastUsedIp,
      expiresAt: k.expiresAt,
      revokedAt: k.revokedAt,
    }));
  });
}

/** 404 unless the source exists in the tenant (asked through the registered source validator). */
export async function assertSourceExists(ctx: ModuleContext, sourceId: string): Promise<void> {
  const v = sourceValidator();
  if (!v || !(await v.exists(ctx, sourceId))) {
    throw new ScoutError({ slug: 'not-found', status: 404, title: 'That source was not found.' });
  }
}

/**
 * Creates a key from an access choice on the API keys screen (`KEY_ACCESS`), for `sourceId`, within
 * what the grantor holds. Returns the key's view and its secret, which is shown once.
 */
export async function createKeyWithAccess(
  ws: ModuleContext,
  input: { name: string; access: KeyAccess; sourceId: string; environment?: 'live' | 'test' },
  grantor: Grantor,
): Promise<ApiKeyView & { secret: string }> {
  // One control transaction for both, so the key and its view are read together.
  return onControl(ws, async () => {
    const { id, secret } = await createApiKey(
      ws,
      { name: input.name, environment: input.environment ?? 'live', scopes: [...KEY_ACCESS[input.access]], sourceId: input.sourceId },
      grantor,
    );
    const [view] = await listApiKeys(ws, { id });
    return { ...view!, secret };
  });
}

/** Revokes every active key with this name in the context's tenant. Returns how many were revoked. */
export async function revokeActiveKeysNamed(ws: ModuleContext, name: string, reason: string): Promise<number> {
  return onControl(ws, async (ctx) => {
    const rows = await ctx.tx
      .select({ id: apiKey.id })
      .from(apiKey)
      .where(and(eq(apiKey.tenantId, ctx.tenantId), eq(apiKey.name, name), isNull(apiKey.revokedAt)));
    for (const r of rows) await revokeApiKey(ws, r.id, reason);
    return rows.length;
  });
}

/** Revokes every active key that sends for this source, when the source is archived or removed. Returns how many. */
export async function revokeKeysForSource(ws: ModuleContext, sourceId: string, reason = 'Source archived'): Promise<number> {
  return onControl(ws, async (ctx) => {
    const rows = await ctx.tx
      .select({ id: apiKey.id })
      .from(apiKey)
      .where(and(eq(apiKey.tenantId, ctx.tenantId), eq(apiKey.sourceId, sourceId), isNull(apiKey.revokedAt)));
    for (const r of rows) await revokeApiKey(ws, r.id, reason);
    return rows.length;
  });
}

/** A source's newest working key, as "How it sends" shows it. */
export type ActiveKey = { id: string; prefix: string; lastUsedAt: Date | null; createdAt: Date };

/** For each given source with a working key (not revoked, not expired), its newest one. */
export async function activeKeysBySource(ws: ModuleContext, sourceIds: string[], now = new Date()): Promise<Map<string, ActiveKey>> {
  return onControl(ws, async (ctx) => {
    if (sourceIds.length === 0) return new Map();
    const rows = await ctx.tx
      .select({ id: apiKey.id, sourceId: apiKey.sourceId, prefix: apiKey.prefix, lastUsedAt: apiKey.lastUsedAt, createdAt: apiKey.createdAt })
      .from(apiKey)
      .where(
        and(
          eq(apiKey.tenantId, ctx.tenantId),
          inArray(apiKey.sourceId, sourceIds),
          isNull(apiKey.revokedAt),
          or(isNull(apiKey.expiresAt), gt(apiKey.expiresAt, now)),
        ),
      )
      .orderBy(desc(apiKey.createdAt), desc(apiKey.id));
    const out = new Map<string, ActiveKey>();
    for (const { sourceId, ...k } of rows) if (sourceId && !out.has(sourceId)) out.set(sourceId, k);
    return out;
  });
}

const keyNotFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That key was not found.' });

/** One key of this source that still works; a key of another source, or one already revoked, is a 404. */
async function sourceKey(ctx: ModuleContext, sourceId: string, keyId: string) {
  const [row] = await ctx.tx
    .select()
    .from(apiKey)
    .where(and(eq(apiKey.tenantId, ctx.tenantId), eq(apiKey.id, keyId), eq(apiKey.sourceId, sourceId), isNull(apiKey.revokedAt)));
  if (!row) throw keyNotFound();
  return row;
}

/**
 * Rotates one key of a source (Decision 14, Ruling 7): a new key with the old one's name, scopes, data limit,
 * environment, expiry and limits, within what `grantor` (the caller) holds, then the old one revoked as `Rotated`, in
 * one control-plane transaction, so a failed create leaves the old key working. When the request's workspace
 * transaction fails after that commits, the request's undo steps revoke the new key and put the old one back.
 * Calls with the old key fail within 60 seconds (at once on this instance).
 */
export async function rotateSourceKey(
  ws: ModuleContext,
  sourceId: string,
  keyId: string,
  grantor: Grantor,
): Promise<{ id: string; prefix: string; secret: string; environment: 'live' | 'test'; createdAt: Date }> {
  return onControl(ws, async (ctx) => {
    const old = await sourceKey(ctx, sourceId, keyId);
    const scopes = old.scopes.filter(isPermission);
    const dataLimit = old.dataLimit === null ? undefined : DataLimitSchema.parse(old.dataLimit);
    const environment = old.environment === 'test' ? 'test' : 'live';
    // The caller is the grantor: a key that holds more than they do is refused (403), so a rotate never hands out more than the rotator has.
    const { id, secret } = await createApiKey(
      ws,
      { name: old.name, environment, scopes, dataLimit, sourceId, ...(old.expiresAt ? { expiresAt: old.expiresAt } : {}) },
      grantor,
    );
    const [row] = await ctx.tx
      .update(apiKey)
      .set({ rateLimitPerMinute: old.rateLimitPerMinute, dailyArrivalCap: old.dailyArrivalCap, monthlyEnrichmentCreditCap: old.monthlyEnrichmentCreditCap })
      .where(and(eq(apiKey.tenantId, ctx.tenantId), eq(apiKey.id, id)))
      .returning({ prefix: apiKey.prefix, createdAt: apiKey.createdAt });
    await revokeApiKey(ws, old.id, 'Rotated');
    await audit(ws, { action: 'tenancy.api_key.rotated', subject: { type: 'api_key', id: old.id }, after: { replacedBy: id, sourceId } });
    return { id, prefix: row!.prefix, secret, environment, createdAt: row!.createdAt };
  });
}

/** Revokes one key of a source; a key of another source is a 404. */
export async function revokeSourceKey(ws: ModuleContext, sourceId: string, keyId: string): Promise<void> {
  return onControl(ws, async (ctx) => {
    await sourceKey(ctx, sourceId, keyId);
    await revokeApiKey(ws, keyId, 'Revoked');
  });
}

/**
 * For the CLI (`scout keys:create --tenant <slug> --name <n> --scopes a,b [--test]`, wired in the
 * CLI task). Returns the secret; the caller prints it once.
 */
export async function createKeyFromCli(input: {
  tenantSlug: string;
  name: string;
  scopes: string[];
  test: boolean;
}): Promise<string> {
  const [t] = await controlAdminDb.select({ id: tenant.id }).from(tenant).where(eq(tenant.slug, input.tenantSlug));
  if (!t)
    throw new ScoutError({
      slug: 'not-found',
      status: 404,
      title: 'That workspace was not found.',
    });
  const scopes = input.scopes.map((s) => s.trim()).filter(Boolean);
  if (!scopes.every(isPermission)) throw validation('invalid-permission', 'That permission does not exist.');
  const correlationId = newId('cor');
  // The key itself is written on the control plane (createApiKey); the workspace transaction is for the
  // source check and the audit row.
  const { secret } = await withTenant(t.id, (tx) =>
    createApiKey(
      {
        tenantId: t.id,
        actor: { kind: 'system', id: 'cli' },
        correlationId,
        tx,
      },
      { name: input.name, environment: input.test ? 'test' : 'live', scopes },
      SYSTEM_GRANTOR,
    ),
  );
  return secret;
}

// ---- Authentication ----

type Verified = { principal: Principal; expiresAt: number | null };

let ttlMs = 60_000;
const verified = new Map<string, { at: number; value: Verified }>();
const touched = new Map<string, number>();
let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= hash('scout-dummy-secret-for-timing'));

/** Drops this instance's cached entries for a key prefix (other instances expire within 60 seconds). */
function evictPrefix(prefix: string): void {
  for (const k of verified.keys()) if (k.startsWith(`${prefix}\u0000`)) verified.delete(k);
}

/** Drops this instance's cached keys of a tenant, for example when it is suspended (other instances within 60 seconds). */
export function forgetTenantKeys(tenantId: string): void {
  for (const [k, v] of verified) if (v.value.principal.tenantId === tenantId) verified.delete(k);
}

/** Test hook: how long verified keys are cached (at most 60 seconds). Clears the cache. */
export function setKeyCacheTtl(ms: number): void {
  ttlMs = Math.min(Math.max(ms, 0), 60_000);
  verified.clear();
}

async function touch(keyId: string, tenantId: string, ip: string | null): Promise<void> {
  const now = Date.now();
  const last = touched.get(keyId);
  if (last !== undefined && now - last < LAST_USED_EVERY_MS) return;
  if (touched.size >= 10_000) touched.clear();
  touched.set(keyId, now);
  try {
    await withControlTenant(tenantId, (tx) =>
      tx
        .update(apiKey)
        .set({ lastUsedAt: new Date(), lastUsedIp: ip })
        .where(
          and(
            eq(apiKey.id, keyId),
            eq(apiKey.tenantId, tenantId),
            or(isNull(apiKey.lastUsedAt), sql`${apiKey.lastUsedAt} < now() - interval '1 minute'`),
          ),
        ),
    );
  } catch (e) {
    log.warn({ err: e, keyId }, 'could not record API key use');
  }
}

/**
 * The principal for an API key token, or null when the token is not a valid key (wrong shape,
 * unknown prefix, wrong secret, suspended tenant). Throws `key-revoked` or `key-expired` for a
 * correct secret on a key that is no longer usable. The lookup runs on `controlAdminDb` because the tenant
 * is not known until the key is found; the use stamp is written with the key's tenant set.
 */
export async function authenticateKey(token: string, ip: string | null): Promise<Principal | null> {
  const m = TOKEN.exec(token);
  if (!m) return null;
  const prefix = token.slice(0, `scout_${m[1]}_`.length + PREFIX_RANDOM);
  const cacheKey = `${prefix}\u0000${createHash('sha256').update(token).digest('hex')}`;

  const hit = verified.get(cacheKey);
  if (hit && Date.now() - hit.at < ttlMs) {
    if (hit.value.expiresAt !== null && hit.value.expiresAt <= Date.now()) throw keyExpired();
    await touch(hit.value.principal.id, hit.value.principal.tenantId, ip);
    return hit.value.principal;
  }
  verified.delete(cacheKey);

  const [row] = await controlAdminDb
    .select({ key: apiKey, tenantStatus: tenant.status })
    .from(apiKey)
    .innerJoin(tenant, eq(tenant.id, apiKey.tenantId))
    .where(eq(apiKey.prefix, prefix));
  if (!row) {
    // Same work as a real check, so an unknown prefix cannot be told apart by timing.
    await verify(await dummyHash(), token);
    return null;
  }
  if (!(await verify(row.key.secretHash, token))) return null;

  const k = row.key;
  if (k.revokedAt) throw keyRevoked();
  if (k.expiresAt && k.expiresAt.getTime() <= Date.now()) throw keyExpired();
  if (row.tenantStatus !== 'active') return null;

  const limit = k.dataLimit === null ? defaultDataLimit('api_key') : DataLimitSchema.safeParse(k.dataLimit).data;
  if (!limit) {
    log.error({ keyId: k.id }, 'API key has an invalid data limit');
    return null;
  }
  const principal: Principal = {
    tenantId: k.tenantId,
    kind: 'api_key',
    id: k.id,
    sourceId: k.sourceId ?? undefined,
    environment: k.environment === 'test' ? 'test' : 'live',
    permissions: Object.freeze(k.scopes.filter(isPermission)) as Permission[],
    dataLimit: limit,
    platformAdmin: false,
    supportAccess: false,
  };
  Object.freeze(principal);
  if (ttlMs > 0) {
    if (verified.size >= 10_000) verified.clear();
    verified.set(cacheKey, {
      at: Date.now(),
      value: { principal, expiresAt: k.expiresAt?.getTime() ?? null },
    });
  }
  await touch(k.id, k.tenantId, ip);
  return principal;
}
