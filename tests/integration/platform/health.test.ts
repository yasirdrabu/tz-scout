import { describe, expect, it } from 'vitest';
import { closeHealthConnections, readyResponse } from '@/platform/health';
import { GET as healthz } from '@/http/routes/healthz/route';

describe('health endpoints', () => {
  it('/healthz is always ok', async () => {
    const res = healthz();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('/readyz is 503 naming nats when NATS is unreachable', async () => {
    const res = await readyResponse({ natsUrl: 'nats://127.0.0.1:1' });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; failing: string[] };
    expect(body.ok).toBe(false);
    expect(body.failing).toEqual(['nats']);
  });

  it('/readyz is 200 when the database and NATS answer', async () => {
    const res = await readyResponse();
    expect(await res.json()).toEqual({ ok: true });
    expect(res.status).toBe(200);
  });

  it('closes its NATS connection on shutdown and opens a new one when asked again', async () => {
    await readyResponse();
    await closeHealthConnections();
    const res = await readyResponse();
    expect(res.status).toBe(200);
    await closeHealthConnections();
  });
});
