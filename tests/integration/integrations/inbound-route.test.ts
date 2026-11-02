import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { connectionTenant, ensureConnectionId } from '@/modules/integrations';
import { connection } from '@/modules/integrations/db/schema';
import { inboundRoute } from '@/modules/tenancy/db/schema';
import { adminDb } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { freshTenant } from './helpers';

it('a new connection is indexed on the control plane, so an inbound webhook finds its tenant (D35)', async () => {
  const t = await freshTenant();
  const id = await t.run((ctx) => ensureConnectionId(ctx, 'hubspot'));
  expect(await adminDb.select().from(inboundRoute).where(eq(inboundRoute.connectionId, id))).toEqual([
    expect.objectContaining({ connectionId: id, tenantId: t.tenantId }),
  ]);
  expect(await connectionTenant(id)).toEqual({ tenantId: t.tenantId, provider: 'hubspot', status: 'not_set_up' });
  // Asked again: the same connection, still one route.
  expect(await t.run((ctx) => ensureConnectionId(ctx, 'hubspot'))).toBe(id);
  const [n] = await adminDb.execute<{ n: number }>(sql`select count(*)::int as n from tenancy.inbound_route where connection_id = ${id}`);
  expect(n!.n).toBe(1);
});

it('a connection with no route, or a route with no connection, is unknown', async () => {
  const t = await freshTenant();
  const unrouted = newId('con');
  await adminDb.insert(connection).values({ id: unrouted, tenantId: t.tenantId, provider: 'hubspot', name: 'By hand' });
  expect(await connectionTenant(unrouted)).toBeNull();
  const dangling = newId('con');
  await adminDb.insert(inboundRoute).values({ connectionId: dangling, tenantId: t.tenantId });
  expect(await connectionTenant(dangling)).toBeNull();
});
