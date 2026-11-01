import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { METHODS, routes, V1 } from '@/http/routes';
import { createApp } from '@/http/server';

const ROOT = path.resolve(__dirname, '../../../src/http/routes');

function routeFiles(dir = ROOT): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return f === 'route.ts' ? [p] : [];
  });
}

/** The URL a route file serves, as Next's file-system routing gave it: `[id]` is `:id`, `[...all]` is `*`. */
function expectedPath(file: string): string {
  const dirs = path.relative(ROOT, path.dirname(file)).split(path.sep);
  const segs = dirs.map((s) => (s.startsWith('[...') ? '*' : s.startsWith('[') ? `:${s.slice(1, -1)}` : s));
  return segs[0] === 'v1' ? [V1, ...segs.slice(1)].join('/') : `/${segs.join('/')}`;
}

describe('route table', () => {
  const files = routeFiles();

  it('finds the route files', () => {
    expect(files.length).toBeGreaterThan(90);
  });

  it('has one entry per route file, no more', () => {
    expect(routes).toHaveLength(files.length);
    expect(new Set(routes.map((r) => r.path)).size).toBe(routes.length);
  });

  it.each(files.map((f) => [path.relative(ROOT, f), f]))('mounts %s at its path', async (_name, file) => {
    const mod = await import(file);
    const entry = routes.find((r) => r.path === expectedPath(file));
    expect(entry, expectedPath(file)).toBeDefined();
    expect(entry!.module).toBe(mod);
  });

  it('every export of a route module is an HTTP method the server mounts', () => {
    for (const { path: p, module } of routes) {
      for (const name of Object.keys(module)) expect(METHODS, `${p} exports ${name}`).toContain(name);
    }
  });

  it('registers every exported method at the entry path', () => {
    const registered = new Set(createApp().routes.map((r) => `${r.method} ${r.path}`));
    for (const { path: p, module } of routes) {
      const methods = Object.keys(module);
      expect(methods.length, p).toBeGreaterThan(0);
      for (const m of methods) expect(registered, `${m} ${p}`).toContain(`${m} ${p}`);
    }
  });
});
