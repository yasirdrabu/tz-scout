import { eq } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { controlAdminDb } from '@/platform/db/client';
import { inboundRoute } from '../db/schema';
import { onControl } from './control';

/** Records that inbound webhooks for `connectionId` belong to the context's tenant. Safe to repeat. */
export async function registerInboundRoute(ws: ModuleContext, connectionId: string): Promise<void> {
  await onControl(ws, (ctx) =>
    ctx.tx.insert(inboundRoute).values({ connectionId, tenantId: ctx.tenantId }).onConflictDoNothing(),
  );
}

/** The tenant of an inbound webhook's connection, or null. Read before any tenant is known, so as `scout_admin`. */
export async function inboundRouteTenant(connectionId: string): Promise<string | null> {
  const [row] = await controlAdminDb
    .select({ tenantId: inboundRoute.tenantId })
    .from(inboundRoute)
    .where(eq(inboundRoute.connectionId, connectionId));
  return row?.tenantId ?? null;
}
