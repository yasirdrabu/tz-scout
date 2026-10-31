import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { toProblem } from '@/platform/errors';
import { newId } from '@/platform/ids';
import { notFound } from '../v1/_lib/path';

// INTERIM, until the HTTP layer moves to Hono (spec W4, C12): Next serves the built web-ui app.
// The app's files under web-ui/dist/assets are copied into public/ by scripts/copy-standalone-assets.mjs
// and served by Next as static files; every other app path gets web-ui/dist/index.html so the app's
// router can take it (spec W2, C1). Static segments (v1, api, healthz, readyz) win over this catch-all;
// what reaches it under those prefixes is an unknown API path and gets the API's problem+json 404.

export const dynamic = 'force-dynamic';

/** Read relative to the working directory: the repo root in dev, .next/standalone in the standalone server. */
const INDEX = path.join('web-ui', 'dist', 'index.html');
const API_PREFIXES = ['/v1', '/api', '/healthz', '/readyz'];

let index: Promise<string> | null = null;
async function indexHtml(): Promise<string> {
  index ??= readFile(path.resolve(INDEX), 'utf8');
  try {
    return await index;
  } catch (e) {
    index = null; // not built yet: try again on the next request
    throw e;
  }
}

const underPrefix = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(prefix + '/');

function apiNotFound(): Response {
  const correlationId = newId('cor');
  const { status, body } = toProblem(notFound());
  return new Response(JSON.stringify({ ...body, correlation_id: correlationId }), {
    status,
    headers: { 'content-type': 'application/problem+json', 'x-correlation-id': correlationId },
  });
}

const plain = (status: number, text: string, headers: Record<string, string> = {}) =>
  new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } });

async function handle(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (API_PREFIXES.some((p) => underPrefix(pathname, p))) return apiNotFound();
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'Method not allowed.', { allow: 'GET, HEAD' });
  // A missing static file (an old hashed asset, a typo) is a 404, not the app.
  if (underPrefix(pathname, '/assets') || /\.[A-Za-z0-9]+$/.test(pathname)) return plain(404, 'Not found.');
  let html: string;
  try {
    html = await indexHtml();
  } catch {
    return plain(404, 'The web app is not built. Run "npm run build", or use the Vite dev server in web-ui/.');
  }
  return new Response(req.method === 'HEAD' ? null : html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
