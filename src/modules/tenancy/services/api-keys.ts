import { createHash, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { adminDb } from '@/platform/db/client';
import { withTenant } from '@/platform/db/tenant';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { log } from '@/platform/log';
import { apiKeyCreated, apiKeyRevoked } from '../contracts/events';
import type { Principal } from '../contracts/principal';
import { sourceValidator } from '../contracts/source-validator';
import { DataLimitSchema, defaultDataLimit, type DataLimit } from '../domain/data-limit';
import { isPermission, type Permission } from '../domain/permissions';
import { apiKey, tenant } from '../db/schema';

export const NEEDS_SOURCE_LATER = 'Keys that send accounts need a source. Sources arrive in the next release.';

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
  ctx: ModuleContext,
  input: CreateApiKeyInput,
): Promise<{ id: string; secret: string }> {
  const name = input.name.trim();
  if (!name) throw validation('validation', 'Give the key a name.');
  if (!Array.isArray(input.scopes) || !input.scopes.every(isPermission)) {
    throw validation('invalid-permission', 'That permission does not exist.');
  }
  if (input.environment !== 'live' && input.environment !== 'test') {
    throw validation('validation', 'Environment must be live or test.');
  }
  const scopes = [...new Set(input.scopes)];
  let dataLimit: DataLimit | null = null;
  if (input.dataLimit) {
    const parsed = DataLimitSchema.safeParse(input.dataLimit);
    if (!parsed.success) throw validation('validation', 'Check the data limit.');
    dataLimit = parsed.data;
  }

  if (scopes.includes('arrivals:write')) {
    const v = sourceValidator();
    if (!v) throw validation('source-required', NEEDS_SOURCE_LATER);
    if (!input.sourceId) throw validation('source-required', 'Keys that send accounts need a source.');
    if (!(await v.exists(ctx, input.sourceId))) throw validation('source-not-found', 'That source was not found.');
  }

  const random = randomBase62(32);
  const head = `scout_${input.environment}_`;
  const secret = head + random;
  const prefix = head + random.slice(0, PREFIX_RANDOM);
  const secretHash = await hash(secret); // argon2id by default
  const id = newId('key');

  await ctx.tx.insert(apiKey).values({
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
  });
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
  await audit(ctx, {
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
}

/** Revokes a key. Requests with it fail within 60 seconds on every instance (the cache lifetime). */
export async function revokeApiKey(ctx: ModuleContext, id: string, reason: string): Promise<void> {
  const rows = await ctx.tx
    .update(apiKey)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKey.id, id), eq(apiKey.tenantId, ctx.tenantId), isNull(apiKey.revokedAt)))
    .returning({ id: apiKey.id });
  if (rows.length === 0) {
    throw new ScoutError({
      slug: 'not-found',
      status: 404,
      title: 'That key was not found.',
    });
  }
  await publish(ctx, apiKeyRevoked, { keyId: id, reason, revokedBy: ctx.actor.id }, { type: 'api_key', id });
  await audit(ctx, {
    action: 'tenancy.api_key.revoked',
    subject: { type: 'api_key', id },
    after: { reason },
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
  const [t] = await adminDb.select({ id: tenant.id }).from(tenant).where(eq(tenant.slug, input.tenantSlug));
  if (!t)
    throw new ScoutError({
      slug: 'not-found',
      status: 404,
      title: 'That workspace was not found.',
    });
  const scopes = input.scopes.map((s) => s.trim()).filter(Boolean);
  if (!scopes.every(isPermission)) throw validation('invalid-permission', 'That permission does not exist.');
  const correlationId = newId('cor');
  const { secret } = await withTenant(t.id, (tx) =>
    createApiKey(
      {
        tenantId: t.id,
        actor: { kind: 'system', id: 'cli' },
        correlationId,
        tx,
      },
      { name: input.name, environment: input.test ? 'test' : 'live', scopes },
    ),
  );
  return secret;
}

// ---- Authentication ----

type Verified = { principal: Principal; expiresAt: number | null };

let ttlMs = 60_000;
const verified = new Map<string, { at: number; value: Verified }>();
const touched = new Map<string, number>();

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
    await withTenant(tenantId, (tx) =>
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
 * correct secret on a key that is no longer usable. The lookup runs on `adminDb` because the tenant
 * is not known until the key is found; the use stamp is written through the key's own tenant.
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

  const [row] = await adminDb
    .select({ key: apiKey, tenantStatus: tenant.status })
    .from(apiKey)
    .innerJoin(tenant, eq(tenant.id, apiKey.tenantId))
    .where(eq(apiKey.prefix, prefix));
  if (!row) return null;
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
    permissions: k.scopes.filter(isPermission),
    dataLimit: limit,
    platformAdmin: false,
    supportAccess: false,
  };
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
