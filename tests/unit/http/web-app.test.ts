import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '@/http/server';

const INDEX = '<!doctype html><html><head><title>Scout</title></head><body><div id="root"></div></body></html>';
const JS = 'console.log("app")';

describe('web-ui app and fallback', () => {
  let dir: string;
  let dist: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'scout-web-'));
    dist = path.join(dir, 'dist');
    writeFileSync(path.join(dir, 'secret.txt'), 'outside');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // routes: [] keeps the API out of it (its own tests cover it); the API prefixes still get the problem+json 404.
  const app = () => createApp({ routes: [], webUiDist: dist });
  const get = (p: string, method = 'GET') => app().request(p, { method });

  it('says the app is not built when index.html is missing', async () => {
    const res = await get('/');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('not built');
  });

  describe('once built', () => {
    beforeAll(() => {
      mkdirSync(path.join(dist, 'assets'), { recursive: true });
      writeFileSync(path.join(dist, 'index.html'), INDEX);
      writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), JS);
      writeFileSync(path.join(dist, 'favicon.svg'), '<svg/>');
    });

    it.each(['/', '/signin', '/t/acme/queue', '/admin/tenants', '/t/acme/accounts/acc_1', '/v1/me', '/v1/nope/deeper', '/apiary', '/healthzz'])(
      'serves index.html for %s',
      async (p) => {
        const res = await get(p);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(res.headers.get('cache-control')).toBe('no-cache');
        expect(await res.text()).toContain('<div id="root"></div>');
      },
    );

    it('answers HEAD with headers and no body', async () => {
      const res = await get('/t/acme/queue', 'HEAD');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toBe('');
    });

    it('serves hashed assets with a long cache', async () => {
      const res = await get('/assets/index-abc123.js');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('javascript');
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(await res.text()).toBe(JS);
    });

    it('serves other files from the build without a long cache', async () => {
      const res = await get('/favicon.svg');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/svg+xml');
      expect(res.headers.get('cache-control')).toBe('no-cache');
    });

    it('answers HEAD for a file with no body', async () => {
      const res = await get('/assets/index-abc123.js', 'HEAD');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
    });

    it.each(['/api/nope', '/api/v1/nope/deeper', '/healthz/x', '/readyz/x'])('gives unknown API path %s the problem+json 404', async (p) => {
      for (const method of ['GET', 'POST', 'DELETE']) {
        const res = await get(p, method);
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toBe('application/problem+json');
        expect(res.headers.get('x-correlation-id')).toMatch(/^cor_/);
        const body = await res.json();
        expect(body).toMatchObject({ type: 'https://scout.taazaa.ai/problems/not-found', status: 404 });
        expect(body.correlation_id).toBe(res.headers.get('x-correlation-id'));
      }
    });

    it('refuses writes to app paths with 405, not HTML', async () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await get('/t/acme/queue', method);
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('GET, HEAD');
        expect(res.headers.get('content-type')).not.toContain('text/html');
      }
    });

    it.each(['/assets/index-gone.js', '/assets/sub', '/favicon.ico', '/robots.txt'])('gives missing static file %s a 404, not the app', async (p) => {
      const res = await get(p);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).not.toContain('text/html');
    });

    it.each(['/assets/%2e%2e/%2e%2e/secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/assets/%5c..%5c..%5csecret.txt'])(
      'does not serve files outside the build: %s',
      async (p) => {
        const res = await get(p);
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain('outside');
      },
    );

    it('reads WEB_UI_DIST when no directory is given', async () => {
      const before = process.env.WEB_UI_DIST;
      process.env.WEB_UI_DIST = dist;
      try {
        const res = await createApp({ routes: [] }).request('/t/acme/queue');
        expect(await res.text()).toContain('<div id="root"></div>');
      } finally {
        if (before === undefined) delete process.env.WEB_UI_DIST;
        else process.env.WEB_UI_DIST = before;
      }
    });
  });
});
