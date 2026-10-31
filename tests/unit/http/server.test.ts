import { describe, expect, it } from 'vitest';
import { createApp, startServer } from '@/http/server';

describe('startServer', () => {
  it('serves the app, fills X-Forwarded-For from the socket like Next did, and keeps a sent one', async () => {
    const app = createApp({
      routes: [{ path: '/v1/echo', module: { GET: async (req: Request) => Response.json({ xff: req.headers.get('x-forwarded-for') }) } }],
      webUiDist: '/nonexistent',
    });
    const server = await startServer({ port: 0, host: '127.0.0.1', app });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect(await (await fetch(`${base}/v1/echo`)).json()).toEqual({ xff: '127.0.0.1' });
      expect(await (await fetch(`${base}/v1/echo`, { headers: { 'x-forwarded-for': '203.0.113.9' } })).json()).toEqual({
        xff: '203.0.113.9',
      });
    } finally {
      await server.close();
    }
  });

  it('finishes in-flight requests on close, then stops accepting', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const inFlight = new Promise<void>((r) => (started = r));
    const app = createApp({
      routes: [
        {
          path: '/v1/slow',
          module: {
            GET: async () => {
              started();
              await gate;
              return Response.json({ done: true });
            },
          },
        },
      ],
      webUiDist: '/nonexistent',
    });
    const server = await startServer({ port: 0, host: '127.0.0.1', app });
    const base = `http://127.0.0.1:${server.port}`;
    const pending = fetch(`${base}/v1/slow`).then((r) => r.json());
    await inFlight;
    const closed = server.close();
    release();
    expect(await pending).toEqual({ done: true });
    await closed;
    await expect(fetch(`${base}/v1/slow`)).rejects.toThrow();
  });
});
