import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/platform/config', async (orig) => {
  const real = await orig<typeof import('@/platform/config')>();
  const { cfg } = await import('../integrations/cfg');
  const over = cfg as Record<string, unknown>;
  return { ...real, config: new Proxy(real.config, { get: (t, p) => (over[p as string] !== undefined ? over[p as string] : (t as never)[p]) }) };
});

import '@/entry/compose';
import { POST } from '@/app/v1/inbound/hubspot/[connectionId]/route';
import { leadQualified } from '@/modules/crm';
import { webhookReceipt } from '@/modules/crm/db/schema';
import { ensureConnectionId, saveCredential } from '@/modules/integrations';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { cfg } from '../integrations/cfg';
import { newKey } from '../integrations/helpers';
import { routingTenant, type Tenant } from '../routing/helpers';

const SECRET = 'hubspot-client-secret-1234';
const ORIGIN = 'http://localhost:4240';
let t: Tenant;
let conn: string;
let bare: string; // a connection with no client secret

beforeAll(async () => {
  cfg.masterKey = newKey();
  t = await routingTenant();
  conn = await t.run((ctx) => ensureConnectionId(ctx, 'hubspot'));
  await t.run((ctx) => saveCredential(ctx, 'hubspot', { kind: 'client_secret', value: SECRET }));
  const other = await routingTenant();
  bare = await other.run((ctx) => ensureConnectionId(ctx, 'hubspot'));
});
afterAll(closeDbs);

const BODY = JSON.stringify([{ subscriptionType: 'contact.propertyChange', objectId: 4001, propertyName: 'lifecyclestage', propertyValue: 'marketingqualifiedlead' }]);

function send(id: string, opts: { body?: string; secret?: string; at?: number; signature?: string; query?: string; signedQuery?: string } = {}) {
  const body = opts.body ?? BODY;
  const timestamp = String(opts.at ?? Date.now());
  const path = `/v1/inbound/hubspot/${id}`;
  const signature =
    opts.signature ?? createHmac('sha256', opts.secret ?? SECRET).update(`POST${ORIGIN}${path}${opts.signedQuery ?? opts.query ?? ''}${body}${timestamp}`).digest('base64');
  return POST(
    // The request reaches the route on an internal host; the signature covers the public one.
    new Request(`http://internal:3000${path}${opts.query ?? ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hubspot-signature-v3': signature, 'x-hubspot-request-timestamp': timestamp },
      body,
    }),
  );
}

const queued = async () =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId))).filter((r) => (r.payload as { type: string }).type === leadQualified.type).length;

describe('POST /v1/inbound/hubspot/{connectionId} (SRC-E6-S1-AC2)', () => {
  it('a good request is 200, stores the receipt and enqueues the work', async () => {
    const before = await queued();
    const res = await send(conn);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(await queued()).toBe(before + 1);
    expect(await t.run((ctx) => ctx.tx.select().from(webhookReceipt).where(eq(webhookReceipt.connectionId, conn)))).toHaveLength(1);
  });

  it('signs the public origin, path and query, with HubSpot reserved characters decoded', async () => {
    expect((await send(conn, { query: '?a=1&b=x%3Ay', signedQuery: '?a=1&b=x:y' })).status).toBe(200);
    expect((await send(conn, { query: '?a=1&b=x%3Ay' })).status).toBe(401);
  });

  it('a bad signature, a wrong secret, an old timestamp or a missing signature is 401 and enqueues nothing', async () => {
    const before = await queued();
    for (const r of [
      await send(conn, { signature: 'AAAA' }),
      await send(conn, { secret: 'someone-elses-secret' }),
      await send(conn, { at: Date.now() - 6 * 60_000 }),
      await POST(new Request(`http://internal:3000/v1/inbound/hubspot/${conn}`, { method: 'POST', body: BODY })),
    ]) {
      expect(r.status).toBe(401);
      expect(r.headers.get('content-type')).toContain('application/problem+json');
    }
    expect(await queued()).toBe(before);
  });

  it('a connection with no client secret is 401', async () => {
    expect((await send(bare)).status).toBe(401);
  });

  it('an unknown connection id is 401, not 404', async () => {
    expect((await send('con_doesnotexist')).status).toBe(401);
  });

  it('a body over 1 MB is refused with 413', async () => {
    expect((await send(conn, { body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413);
  });
});
