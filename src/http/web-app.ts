import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { getMimeType } from 'hono/utils/mime';

// The built web-ui app (spec W2, C1): files from its build directory, and index.html for every
// other app path so the app's router can take it. Hashed files under /assets never change under the
// same name, so they cache for a year; everything else is revalidated.

const LONG_CACHE = 'public, max-age=31536000, immutable';

const underPrefix = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(prefix + '/');

const plain = (status: number, text: string, headers: Record<string, string> = {}) =>
  new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } });

/** The file under `dist` that `pathname` names, or null (missing, a directory, or outside `dist`). */
async function fileFor(dist: string, pathname: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const file = path.resolve(dist, '.' + decoded);
  if (!file.startsWith(dist + path.sep)) return null;
  try {
    return (await stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** Serves the app from `dist` (an absolute path). Only GET and HEAD; anything else is 405. */
export function webApp(dist: string): (req: Request) => Promise<Response> {
  return async (req) => {
    const { pathname } = new URL(req.url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'Method not allowed.', { allow: 'GET, HEAD' });
    const body = (b: Uint8Array<ArrayBuffer> | string) => (req.method === 'HEAD' ? null : b);
    const file = await fileFor(dist, pathname);
    if (file) {
      return new Response(body(new Uint8Array(await readFile(file))), {
        status: 200,
        headers: {
          'content-type': getMimeType(file) ?? 'application/octet-stream',
          'cache-control': underPrefix(pathname, '/assets') ? LONG_CACHE : 'no-cache',
        },
      });
    }
    // A missing static file (an old hashed asset, a typo) is a 404, not the app.
    if (underPrefix(pathname, '/assets') || /\.[A-Za-z0-9]+$/.test(pathname)) return plain(404, 'Not found.');
    let html: string;
    try {
      html = await readFile(path.join(dist, 'index.html'), 'utf8');
    } catch {
      return plain(404, 'The web app is not built. Run "npm run build", or use the Vite dev server in web-ui/.');
    }
    return new Response(body(html), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    });
  };
}
