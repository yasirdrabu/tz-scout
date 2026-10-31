import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { trimTrailingSlash } from 'hono/trailing-slash';
import { ScoutError, toProblem } from '@/platform/errors';
import { newId } from '@/platform/ids';
import { log } from '@/platform/log';
import { METHODS, routes as allRoutes, type RouteEntry } from './routes';
import { FILE_MAX_BYTES, FORM_SLACK } from './routes/v1/_lib/intake';
import { notFound } from './routes/v1/_lib/path';
import { webApp } from './web-app';

/** The largest body any handler accepts (a batch file upload). Handlers enforce their own, smaller limits. */
export const MAX_BODY_BYTES = FILE_MAX_BYTES + FORM_SLACK;
/** How long close() waits for in-flight requests before it drops their connections. */
const SHUTDOWN_GRACE_MS = 10_000;

/** Paths that belong to the API and the health checks; what no route serves there is the API's 404. */
const API_PREFIXES = ['/api', '/healthz', '/readyz'];

function problem(e: unknown): Response {
  const correlationId = newId('cor');
  const { status, body, headers } = toProblem(e);
  return new Response(JSON.stringify({ ...body, correlation_id: correlationId }), {
    status,
    headers: { ...headers, 'content-type': 'application/problem+json', 'x-correlation-id': correlationId },
  });
}

const tooLarge = () => new ScoutError({ slug: 'payload-too-large', status: 413, title: 'This request is over the size limit.' });

/** Static segments before parameters before wildcards, at the first place two paths differ (Next's precedence). */
function bySpecificity(a: RouteEntry, b: RouteEntry): number {
  const rank = (s: string) => (s === '*' ? 2 : s.startsWith(':') ? 1 : 0);
  const as = a.path.split('/');
  const bs = b.path.split('/');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const d = rank(as[i] ?? '') - rank(bs[i] ?? '');
    if (d !== 0) return d;
  }
  return 0;
}

/** Mounts each exported method; other methods on the path get 405, OPTIONS 204, both with Allow. */
function mount(app: Hono, entry: RouteEntry): void {
  const methods = METHODS.filter((m) => entry.module[m]);
  for (const m of methods) {
    const handler = entry.module[m]!;
    app.on(m, entry.path, (c) => handler(c.req.raw));
  }
  const allow = [...methods.flatMap((m): string[] => (m === 'GET' ? ['GET', 'HEAD'] : [m])), ...(methods.includes('OPTIONS') ? [] : ['OPTIONS'])].join(', ');
  app.all(entry.path, (c) => new Response(null, { status: c.req.method === 'OPTIONS' ? 204 : 405, headers: { allow } }));
}

export type AppOptions = {
  /** Defaults to the full route table. */
  routes?: RouteEntry[];
  /** The built web-ui app. Defaults to WEB_UI_DIST, else web-ui/dist, resolved from the working directory. */
  webUiDist?: string;
};

/**
 * One app on one origin: the API and sign-in under their prefixes, the health checks, and the
 * web-ui app with its index.html fallback for every other GET or HEAD.
 */
export function createApp(opts: AppOptions = {}): Hono {
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: () => problem(tooLarge()) }));
  // As Next did for a path with a trailing slash that matches nothing: redirect to the path without it (GET and HEAD).
  app.use('*', trimTrailingSlash());
  for (const entry of [...(opts.routes ?? allRoutes)].sort(bySpecificity)) mount(app, entry);
  for (const prefix of API_PREFIXES) {
    app.all(prefix, () => problem(notFound()));
    app.all(`${prefix}/*`, () => problem(notFound()));
  }
  const serveApp = webApp(path.resolve(opts.webUiDist ?? process.env.WEB_UI_DIST ?? path.join('web-ui', 'dist')));
  app.all('*', (c) => serveApp(c.req.raw));
  app.onError((e) => {
    log.error({ err: e }, 'unhandled HTTP error');
    return problem(e);
  });
  return app;
}

export type RunningServer = { port: number; close(): Promise<void> };

/**
 * Listens on `host:port`. `close()` stops accepting, lets in-flight requests finish (up to 10
 * seconds, then drops their connections) and resolves once the server is closed.
 */
export function startServer(opts: { port: number; host: string; app?: Hono }): Promise<RunningServer> {
  const listener = getRequestListener((opts.app ?? createApp()).fetch);
  const server = createServer((req, res) => {
    // As Next did: the socket's address when no proxy sent one (clientIp reads it with SCOUT_TRUSTED_PROXY_HOPS).
    // The adapter builds the request's headers from rawHeaders.
    const address = req.socket.remoteAddress;
    if (req.headers['x-forwarded-for'] === undefined && address) {
      req.headers['x-forwarded-for'] = address;
      req.rawHeaders.push('x-forwarded-for', address);
    }
    void listener(req, res);
  });
  const close = () =>
    new Promise<void>((resolve) => {
      const force = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
      server.close(() => {
        clearTimeout(force);
        resolve();
      });
      server.closeIdleConnections();
    });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve({ port: (server.address() as AddressInfo).port, close });
    });
  });
}
