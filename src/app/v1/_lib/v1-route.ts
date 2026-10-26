import { resolvePrincipal, requirePermission, type Permission, type Principal } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { config } from '@/platform/config';
import { withTenant } from '@/platform/db/tenant';
import { ScoutError, toProblem } from '@/platform/errors';
import { newId } from '@/platform/ids';
import { logFor } from '@/platform/log';

const CORRELATION = 'x-correlation-id';

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

export type V1Handler = (req: Request, principal: Principal, ctx: ModuleContext) => Promise<Response | object>;

function correlationFrom(req: Request): string {
  const sent = req.headers.get(CORRELATION)?.trim();
  return sent && /^[A-Za-z0-9._:-]{1,128}$/.test(sent) ? sent : newId('cor');
}

function problem(e: unknown, correlationId: string): Response {
  const { status, body } = toProblem(e);
  return new Response(JSON.stringify(snakeCase(body)), {
    status,
    headers: {
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

/**
 * Wraps a /v1 handler: resolves the principal (401 without one), checks the permission, runs the
 * handler in the principal's tenant, turns thrown errors into problem+json and writes plain objects
 * as snake_case JSON. Always sets `x-correlation-id`.
 */
export function v1Route(opts: { permission?: Permission }, handler: V1Handler): (req: Request) => Promise<Response> {
  return async (req) => {
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
      const actor =
        principal.kind === 'user'
          ? ({ kind: 'user', id: principal.id } as const)
          : ({
              kind: 'agent',
              id: principal.id,
              sourceId: principal.sourceId,
            } as const);
      const result = await withTenant(principal.tenantId, (tx) =>
        handler(req, principal, {
          tenantId: principal.tenantId,
          actor,
          correlationId,
          tx,
          ...(principal.environment ? { environment: principal.environment } : {}),
        }),
      );
      if (result instanceof Response) {
        const res = new Response(result.body, result);
        res.headers.set(CORRELATION, correlationId);
        return res;
      }
      return new Response(JSON.stringify(snakeCase(result)), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          [CORRELATION]: correlationId,
        },
      });
    } catch (e) {
      if (!(e instanceof ScoutError)) logFor({ correlationId }).error({ err: e }, 'unhandled /v1 error');
      return problem(e, correlationId);
    }
  };
}
