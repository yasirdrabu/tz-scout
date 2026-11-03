import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/integrations/services/caps', async (orig) => {
  const real = await orig<typeof import('@/modules/integrations/services/caps')>();
  return {
    ...real,
    settle: vi.fn(async () => {
      throw new Error('settle broke');
    }),
  };
});

import { gateway } from '@/modules/integrations';
import { callLog, usageCap } from '@/modules/integrations/db/schema';
import { adminDb } from '@/platform/db/client';
import { freshTenant } from './helpers';

describe('gateway settle failure', () => {
  it('keeps the call log row and returns the result when settling the limit fails', async () => {
    const t = await freshTenant();
    await adminDb.insert(usageCap).values({ tenantId: t.tenantId, providerKey: 'demo', unit: 'calls', period: 'day', limit: 10 });
    const out = await t.run((ctx) => gateway.call(ctx, 'demo', 'demo.thing.read', async () => 'hello'));
    expect(out).toBe('hello');
    const rows = await adminDb.select().from(callLog).where(eq(callLog.tenantId, t.tenantId));
    expect(rows.map((r) => r.outcome)).toEqual(['ok']);
  });
});
