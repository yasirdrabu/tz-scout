import '@/entry/compose';
import { actorFor, resolvePrincipal, requirePermission, type Permission, type Principal } from '@/modules/tenancy';
import { sourceAccessProvider } from '@/modules/accounts';
import { accessWithSources } from '@/platform/access';
import type { ModuleContext } from '@/platform/context';
import { config } from '@/platform/config';
import { withTenant } from '@/platform/db/tenant';
import { ScoutError, toProblem } from '@/platform/errors';
import { claimKey, sha256, storeResponse } from '@/platform/idempotency';
import { newId } from '@/platform/ids';
import { boundedRequest, JSON_MAX_BYTES } from './intake';
import { logFor } from '@/platform/log';

const CORRELATION = 'x-correlation-id';
const IDEMPOTENCY_KEY = 'idempotency-key';
const MAX_KEY_LENGTH = 255;

const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Copy of `value` with every object key in snake_case, at any depth. Dates become ISO strings. */
export function snakeCase(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(snakeCase);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [snake(k), snakeCase(v)]));
  }
  return value;
}

/** A handler result with its own status, for example 201 or 202. */
export type StatusResult = { status: number; body: object; headers?: Record<string, string> };

export const created = (body: object): StatusResult => ({ status: 201, body });
export const accepted = (body: object): StatusResult => ({ status: 202, body });

export type V1Handler = (
  req: Request,
  principal: Principal,
  ctx: ModuleContext,
) => Promise<Response | StatusResult | object>;

function isStatusResult(r: object): r is StatusResult {
  const { status, body } = r as Partial<StatusResult>;
  return (
    typeof status === 'number' &&
    typeof body === 'object' &&
    body !== null &&
    Object.keys(r).every((k) => k === 'status' || k === 'body' || k === 'headers')
  );
}

/** sha256 of the JSON body; for multipart, of each file's sha256 and the sorted fields. */
async function requestHash(req: Request): Promise<string> {
  const copy = req.clone();
  if ((req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
    const parts: string[] = [];
    for (const [name, value] of await copy.formData()) {
      parts.push(
        typeof value === 'string'
          ? `${name}=${value}`
          : `${name}=file:${sha256(new Uint8Array(await value.arrayBuffer()))}`,
      );
    }
    return sha256(parts.sort().join('\n'));
  }
  const text = await copy.text();
  try {
    return sha256(JSON.stringify(JSON.parse(text)));
  } catch {
    return sha256(text);
  }
}

function correlationFrom(req: Request): string {
  const sent = req.headers.get(CORRELATION)?.trim();
  return sent && /^[A-Za-z0-9._:-]{1,128}$/.test(sent) ? sent : newId('cor');
}

function problem(e: unknown, correlationId: string): Response {
  const { status, body, headers } = toProblem(e);
  return new Response(JSON.stringify(snakeCase({ ...body, correlationId })), {
    status,
    headers: {
      ...headers,
      'content-type': 'application/problem+json',
      [CORRELATION]: correlationId,
      ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
    },
  });
}

/** Cookie-authenticated writes must come from our own pages and name the tenant (CSRF defence). */
export function assertSameSite(req: Request): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  const origin = req.headers.get('origin');
  if (!req.headers.get('x-scout-tenant') || !origin || origin !== new URL(config.publicUrl).origin) {
    throw new ScoutError({ slug: 'csrf', status: 403, title: 'Request blocked' });
  }
}

export type V1Options = {
  permission?: Permission;
  /** A POST with an `Idempotency-Key` header runs once per principal and key; repeats get the stored response. On for every POST unless set to false. */
  idempotent?: boolean;
  /** Refuse API keys and OAuth grants with 403. A string replaces the default copy. */
  peopleOnly?: boolean | string;
  /** Refuse anyone who is not a platform admin. `can()` passes admins on every permission, so it cannot say this. */
  platformAdminOnly?: boolean;
  /** Largest request body, 5 MB unless set. Checked while reading, before hashing or parsing: over it is a 413. */
  maxBytes?: number;
};

const json = (status: number, body: unknown, correlationId: string, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', [CORRELATION]: correlationId, ...extra },
  });

/**
 * Wraps a /v1 handler: resolves the principal (401 without one), checks the permission, runs the
 * handler in the principal's tenant with `ctx.access` set, turns thrown errors into problem+json
 * and writes plain objects as snake_case JSON (200, or the status of `created`/`accepted`).
 * Always sets `x-correlation-id`.
 */
export function v1Route(opts: V1Options, handler: V1Handler): (req: Request) => Promise<Response> {
  return async (original) => {
    let req = original;
    const correlationId = correlationFrom(req);
    try {
      const principal = await resolvePrincipal(req);
      if (!principal) {
        throw new ScoutError({
          slug: 'unauthenticated',
          status: 401,
          title: 'Sign in or send a valid API key.',
        });
      }
      if (req.headers.get('authorization') === null) assertSameSite(req);
      if (opts.permission) requirePermission(principal, opts.permission);
      if (opts.platformAdminOnly && !principal.platformAdmin) {
        throw new ScoutError({
          slug: 'forbidden',
          status: 403,
          title: 'Forbidden',
          detail: 'Only a platform admin can do this.',
        });
      }
      if (opts.peopleOnly && principal.kind !== 'user') {
        throw new ScoutError({
          slug: 'forbidden',
          status: 403,
          title: 'Forbidden',
          detail: typeof opts.peopleOnly === 'string' ? opts.peopleOnly : 'Only a person can do this.',
        });
      }
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        req = await boundedRequest(req, opts.maxBytes ?? JSON_MAX_BYTES);
      }
      let key: string | undefined;
      if ((opts.idempotent ?? true) && req.method === 'POST') {
        key = req.headers.get(IDEMPOTENCY_KEY)?.trim() || undefined;
        if (key && key.length > MAX_KEY_LENGTH) {
          throw new ScoutError({ slug: 'validation', status: 400, title: 'The Idempotency-Key header is too long.' });
        }
      }
      const hash = key ? await requestHash(req) : '';
      const actor = actorFor(principal);
      const result = await withTenant(principal.tenantId, async (tx) => {
        const claim = { tenantId: principal.tenantId, principalId: principal.id, key: key ?? '' };
        if (key) {
          const c = await claimKey(tx, { ...claim, requestHash: hash });
          if (c.kind === 'mismatch') {
            throw new ScoutError({
              slug: 'idempotency-mismatch',
              status: 409,
              title: 'That Idempotency-Key was used with a different request.',
            });
          }
          if (c.kind === 'replay') {
            return json(c.status, c.body, correlationId, { 'idempotent-replayed': 'true' });
          }
        }
        const ctx: ModuleContext = {
          tenantId: principal.tenantId,
          actor,
          correlationId,
          tx,
          ...(principal.environment ? { environment: principal.environment } : {}),
        };
        const r = await handler(req, principal, {
          ...ctx,
          access: await accessWithSources(ctx, principal, sourceAccessProvider()),
        });
        if (r instanceof Response) {
          if (key) throw new Error('An idempotent route must return an object, not a Response');
          return r;
        }
        const status = isStatusResult(r) ? r.status : 200;
        const body = snakeCase(isStatusResult(r) ? r.body : r);
        if (key) await storeResponse(tx, claim, status, body);
        return json(status, body, correlationId, isStatusResult(r) ? r.headers : undefined);
      });
      const res = new Response(result.body, result);
      res.headers.set(CORRELATION, correlationId);
      return res;
    } catch (e) {
      if (!(e instanceof ScoutError)) logFor({ correlationId }).error({ err: e }, 'unhandled /v1 error');
      return problem(e, correlationId);
    }
  };
}
