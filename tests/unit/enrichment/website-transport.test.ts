// `guardedFetch` against real local servers on 127.0.0.1 (review round 2). Loopback is let through only by the
// test-only `allowAddress` option; production never sets it. Nothing here leaves the machine.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { guardedFetch } from '@/modules/enrichment/adapters/website/live-transport';

const loopback = guardedFetch({ allowAddress: (a) => a === '127.0.0.1' });
const servers: http.Server[] = [];

function serve(handler: http.RequestListener): Promise<string> {
  const srv = http.createServer(handler);
  servers.push(srv);
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/`)));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((ok) => { s.closeAllConnections(); s.close(ok); })));
});

describe('guardedFetch', () => {
  it('without the test option, loopback is still refused', async () => {
    const url = await serve((_req, res) => res.end('hi'));
    await expect(guardedFetch()(url, {})).rejects.toMatchObject({ status: 400 });
  });

  it.each([204, 205, 304])('a %i answer has an empty body and does not crash', async (status) => {
    const url = await serve((_req, res) => {
      res.writeHead(status);
      res.end();
    });
    const res = await loopback(url, {});
    expect(res.status).toBe(status);
    expect(res.body).toBeNull();
  });

  it('reads a gzip body decoded', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync('<title>Hello</title>'));
    });
    const res = await loopback(url, { headers: { 'user-agent': 'test' } });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toBe('<title>Hello</title>');
  });

  it('an abort mid-way through a slow gzip body fails the read at once and closes the socket', async () => {
    let closed!: () => void;
    const socketClosed = new Promise<void>((ok) => (closed = ok));
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      const gz = zlib.createGzip();
      gz.pipe(res);
      const drip = setInterval(() => {
        gz.write('x'.repeat(100));
        gz.flush();
      }, 50);
      res.on('close', () => {
        clearInterval(drip);
        closed();
      });
    });
    const budget = new AbortController();
    const res = await loopback(url, { signal: budget.signal });
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const started = Date.now();
    setTimeout(() => budget.abort(new DOMException('took too long', 'TimeoutError')), 200);
    const drain = async () => {
      for (;;) if ((await reader.read()).done) return 'done';
    };
    await expect(drain()).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(2000);
    await socketClosed;
  });

  it('a body cancelled by the reader closes the socket', async () => {
    let closed!: () => void;
    const socketClosed = new Promise<void>((ok) => (closed = ok));
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      const gz = zlib.createGzip();
      gz.pipe(res);
      const drip = setInterval(() => {
        gz.write('y'.repeat(100));
        gz.flush();
      }, 50);
      res.on('close', () => {
        clearInterval(drip);
        closed();
      });
    });
    const res = await loopback(url, {});
    await res.body!.cancel();
    await socketClosed;
  });

  it('an error mid-body fails the read', async () => {
    const url = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.write(zlib.gzipSync('x'.repeat(1000)).subarray(0, 20));
      setTimeout(() => req.socket.destroy(), 50);
    });
    const res = await loopback(url, {});
    await expect(res.text()).rejects.toBeTruthy();
  });
});
