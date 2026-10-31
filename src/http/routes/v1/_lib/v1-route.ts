import '@/entry/compose';
import {
  actorFor,
  clientIp,
  resolvePrincipal,
  requirePermission,
  sessionUser,
  type Permission,
  type Principal,
  type SessionUser,
} from '@/modules/tenancy';
import { sourceAccessProvider } from '@/modules/accounts';
import { accessWithSources } from '@/platform/access';
import { PLATFORM_TENANT } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { config } from '@/platform/config';
import { adminDb } from '@/platform/db/client';
import { withTenant, type Tx } from '@/platform/db/tenant';
import type { Actor } from '@/platform/events/envelope';
import { ScoutError, toProblem } from '@/platform/errors';
import { claimKey, sha256, storeResponse } from '@/platform/idempotency';
import { newId } from '@/platform/ids';
import { boundedRequest, JSON_MAX_BYTES } from './intake';
import { logFor } from '@/platform/log';
import { idAndAction, notFound } from './path';

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
/** 204 with no body, for a DELETE. */
export const noContent = (): StatusResult => ({ status: 204, body: {} });

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

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
const csrf = () => new ScoutError({ slug: 'csrf', status: 403, title: 'Request blocked' });

/** Cookie-authenticated writes must come from our own pages (CSRF defence). For routes with no tenant. */
export function assertSameOrigin(req: Request): void {
  if (SAFE_METHODS.includes(req.method)) return;
  const origin = req.headers.get('origin');
  if (!origin || origin !== new URL(config.publicUrl).origin) throw csrf();
}

/** Cookie-authenticated writes must come from our own pages and name the tenant (CSRF defence). */
export function assertSameSite(req: Request): void {
  assertSameOrigin(req);
  if (!SAFE_METHODS.includes(req.method) && !req.headers.get('x-scout-tenant')) throw csrf();
}

export type V1Options = {
  permission?: Permission;
  /** A POST with an `Idempotency-Key` header runs once per principal and key; repeats get the stored response. On for every POST unless set to false. */
  idempotent?: boolean;
  /** Refuse API keys and OAuth grants with 403. A string replaces the default copy. */
  peopleOnly?: boolean | string;
  /** Refuse anyone who is not a platform admin. `can()` passes admins on every permission, so it cannot say this. A string replaces the default copy. */
  platformAdminOnly?: boolean | string;
  /** Largest request body, 5 MB unless set. Checked while reading, before hashing or parsing: over it is a 413. */
  maxBytes?: number;
};

const json = (status: number, body: unknown, correlationId: string, extra: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { ...(status === 204 ? {} : { 'content-type': 'application/json' }), [CORRELATION]: correlationId, ...extra },
  });

const unauthenticated = () =>
  new ScoutError({ slug: 'unauthenticated', status: 401, title: 'Sign in or send a valid API key.' });

const forbidden = (copy: boolean | string, fallback: string) =>
  new ScoutError({ slug: 'forbidden', status: 403, title: 'Forbidden', detail: typeof copy === 'string' ? copy : fallback });

/** Runs `fn` with the correlation id; thrown errors become problem+json. Always sets `x-correlation-id`. */
function guarded(fn: (req: Request, correlationId: string) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    const correlationId = correlationFrom(req);
    try {
      const result = await fn(req, correlationId);
      const res = new Response(result.body, result);
      res.headers.set(CORRELATION, correlationId);
      return res;
    } catch (e) {
      if (!(e instanceof ScoutError)) logFor({ correlationId }).error({ err: e }, 'unhandled /v1 error');
      return problem(e, correlationId);
    }
  };
}

type Handled = Promise<Response | StatusResult | object>;

/**
 * The part every signed-in wrapper shares: bounds the body, takes the `Idempotency-Key` for
 * (`claim.tenantId`, `claim.principalId`), runs `run` in the transaction `inTx` opens and writes the
 * result as snake_case JSON, storing it under the key in the same transaction.
 */
async function execute(
  original: Request,
  opts: { idempotent?: boolean; maxBytes?: number },
  claim: { tenantId: string; principalId: string },
  inTx: (fn: (tx: Tx) => Promise<Response>) => Promise<Response>,
  correlationId: string,
  run: (req: Request, tx: Tx) => Handled,
): Promise<Response> {
  let req = original;
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
  return inTx(async (tx) => {
    const k = { ...claim, key: key ?? '' };
    if (key) {
      const c = await claimKey(tx, { ...k, requestHash: hash });
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
    const r = await run(req, tx);
    if (r instanceof Response) {
      if (key) throw new Error('An idempotent route must return an object, not a Response');
      return r;
    }
    const status = isStatusResult(r) ? r.status : 200;
    const body = snakeCase(isStatusResult(r) ? r.body : r);
    if (key) await storeResponse(tx, k, status, body);
    return json(status, body, correlationId, isStatusResult(r) ? r.headers : undefined);
  });
}

/**
 * Wraps a /api/v1 handler: resolves the principal (401 without one), checks the permission, runs the
 * handler in the principal's tenant with `ctx.access` set, turns thrown errors into problem+json
 * and writes plain objects as snake_case JSON (200, or the status of `created`/`accepted`).
 * Always sets `x-correlation-id`.
 */
export function v1Route(opts: V1Options, handler: V1Handler): (req: Request) => Promise<Response> {
  return guarded(async (req, correlationId) => {
    const principal = await resolvePrincipal(req);
    if (!principal) throw unauthenticated();
    if (req.headers.get('authorization') === null) assertSameSite(req);
    if (opts.permission) requirePermission(principal, opts.permission);
    if (opts.platformAdminOnly && !principal.platformAdmin) {
      throw forbidden(opts.platformAdminOnly, 'Only a platform admin can do this.');
    }
    if (opts.peopleOnly && principal.kind !== 'user') throw forbidden(opts.peopleOnly, 'Only a person can do this.');
    const actor = actorFor(principal);
    const ip = clientIp(req);
    return execute(
      req,
      opts,
      { tenantId: principal.tenantId, principalId: principal.id },
      (fn) => withTenant(principal.tenantId, fn),
      correlationId,
      async (r, tx) => {
        const ctx: ModuleContext = {
          tenantId: principal.tenantId,
          actor,
          correlationId,
          tx,
          ...(principal.environment ? { environment: principal.environment } : {}),
          ...(ip ? { ip } : {}),
        };
        return handler(r, principal, { ...ctx, access: await accessWithSources(ctx, principal, sourceAccessProvider()) });
      },
    );
  });
}

/** What a session route handler gets besides the person: the actor, correlation id and open transaction. */
export type SessionContext = { actor: Actor; correlationId: string; tx: Tx };

export type SessionHandler = (req: Request, person: SessionUser, ctx: SessionContext) => Handled;

export type SessionOptions = Pick<V1Options, 'idempotent' | 'maxBytes'>;

function personRoute(opts: SessionOptions & { admin: boolean }, handler: SessionHandler) {
  return guarded(async (req, correlationId) => {
    if (req.headers.get('authorization') !== null) throw forbidden(true, 'Only a person can do this.');
    // Before sessionUser, so a cross-site write does not restart the session's idle clock.
    assertSameOrigin(req);
    const person = await sessionUser(req.headers);
    if (!person) throw unauthenticated();
    if (opts.admin && !person.platformAdmin) throw forbidden(true, 'Only a platform admin can do this.');
    const actor: Actor = { kind: 'user', id: person.userId };
    return execute(
      req,
      opts,
      { tenantId: PLATFORM_TENANT, principalId: person.userId },
      opts.admin ? (fn) => adminDb.transaction(fn) : (fn) => withTenant(PLATFORM_TENANT, fn),
      correlationId,
      (r, tx) => handler(r, person, { actor, correlationId, tx }),
    );
  });
}

/**
 * Wraps a /api/v1 handler that needs a signed-in person but no workspace: cookie session only (API keys
 * get 403), the same idle and age rules as tenant routes, CSRF by origin only (no `x-scout-tenant`).
 * The transaction is under tenant `t_platform`, where `Idempotency-Key`s are stored. Same
 * problem+json, snake_case and `x-correlation-id` handling as `v1Route`.
 */
export function sessionRoute(opts: SessionOptions, handler: SessionHandler): (req: Request) => Promise<Response> {
  return personRoute({ ...opts, admin: false }, handler);
}

/** `sessionRoute` for platform admins only (403 for anyone else); the transaction is on `adminDb`. */
export function adminRoute(opts: SessionOptions, handler: SessionHandler): (req: Request) => Promise<Response> {
  return personRoute({ ...opts, admin: true }, handler);
}

/** Wraps a public GET (no sign-in): problem+json errors, snake_case JSON and `x-correlation-id`. */
export function publicRoute(handler: (req: Request) => Promise<object>): (req: Request) => Promise<Response> {
  return guarded(async (req, correlationId) => json(200, snakeCase(await handler(req)), correlationId));
}

/**
 * One route file for the `id:action` paths under `after`: runs the route registered for the action in the path.
 * Each action is its own v1Route, so each has its own permission. An unknown action is a 404 (after sign-in).
 */
export function byAction(
  after: string,
  routes: Record<string, (req: Request) => Promise<Response>>,
  unknown: (req: Request) => Promise<Response> = v1Route({}, async () => {
    throw notFound();
  }),
): (req: Request) => Promise<Response> {
  return (req) => {
    let action: string | null = null;
    try {
      action = idAndAction(req, after).action;
    } catch {
      // A malformed path is handled by the 404 route.
    }
    return (action && Object.hasOwn(routes, action) ? routes[action]! : unknown)(req);
  };
}

/** `byAction` for `/api/v1/admin` paths: an unknown action is a 404 for a platform admin (403 for anyone else). */
export function adminByAction(after: string, routes: Record<string, (req: Request) => Promise<Response>>): (req: Request) => Promise<Response> {
  return byAction(
    after,
    routes,
    adminRoute({}, async () => {
      throw notFound();
    }),
  );
}
