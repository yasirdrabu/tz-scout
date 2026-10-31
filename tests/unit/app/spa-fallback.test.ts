import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DELETE, GET, HEAD, POST } from '@/app/[[...app]]/route';

const INDEX = '<!doctype html><html><head><title>Scout</title></head><body><div id="root"></div></body></html>';
const req = (p: string, method = 'GET') => new Request(`http://localhost:4240${p}`, { method });

describe('web-ui fallback route (interim, until Hono)', () => {
  const cwd = process.cwd();
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'scout-spa-'));
    process.chdir(dir);
  });
  afterAll(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('says the app is not built when web-ui/dist/index.html is missing', async () => {
    const res = await GET(req('/'));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('not built');
  });

  describe('once built', () => {
    beforeAll(() => {
      mkdirSync(path.join(dir, 'web-ui', 'dist'), { recursive: true });
      writeFileSync(path.join(dir, 'web-ui', 'dist', 'index.html'), INDEX);
    });

    it.each(['/', '/signin', '/t/acme/queue', '/admin/tenants', '/t/acme/accounts/acc_1'])('serves index.html for %s', async (p) => {
      const res = await GET(req(p));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toContain('<div id="root"></div>');
    });

    it('answers HEAD with headers and no body', async () => {
      const res = await HEAD(req('/t/acme/queue', 'HEAD'));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
    });

    it.each(['/v1/nope/deeper', '/v1', '/api/nope', '/healthz/x', '/readyz/x'])('gives unknown API path %s the problem+json 404', async (p) => {
      for (const handler of [GET, POST, DELETE]) {
        const res = await handler(req(p, handler === GET ? 'GET' : handler === POST ? 'POST' : 'DELETE'));
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toBe('application/problem+json');
        expect(res.headers.get('x-correlation-id')).toMatch(/^cor_/);
        const body = await res.json();
        expect(body).toMatchObject({ type: 'https://scout.taazaa.ai/problems/not-found', status: 404 });
        expect(body.correlation_id).toBe(res.headers.get('x-correlation-id'));
      }
    });

    it('does not treat look-alike prefixes as the API', async () => {
      expect((await GET(req('/v1x'))).status).toBe(200);
      expect((await GET(req('/apiary'))).status).toBe(200);
    });

    it('refuses writes to app paths with 405, not HTML', async () => {
      for (const [handler, method] of [[POST, 'POST'], [DELETE, 'DELETE']] as const) {
        const res = await handler(req('/t/acme/queue', method));
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('GET, HEAD');
        expect(res.headers.get('content-type')).not.toContain('text/html');
      }
    });

    it.each(['/assets/index-gone.js', '/favicon.ico', '/robots.txt'])('gives missing static file %s a 404, not the app', async (p) => {
      const res = await GET(req(p));
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).not.toContain('text/html');
    });
  });
});
