import { and, eq } from 'drizzle-orm';
import { inboundRouteTenant } from '@/modules/tenancy';
import { withTenant } from '@/platform/db/tenant';
import { connection } from '../db/schema';

/**
 * The tenant and provider of a connection id. An unauthenticated webhook has no tenant until its
 * connection is found: the tenant comes from tenancy's control-plane index (D35), then the connection
 * is read in that tenant's workspace. Null for an unknown id. The status lets the caller refuse a
 * disabled connection.
 */
export async function connectionTenant(connectionId: string): Promise<{ tenantId: string; provider: string; status: string } | null> {
  const tenantId = await inboundRouteTenant(connectionId);
  if (!tenantId) return null;
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select({ tenantId: connection.tenantId, provider: connection.provider, status: connection.status })
      .from(connection)
      .where(and(eq(connection.id, connectionId), eq(connection.tenantId, tenantId)))
      .limit(1),
  );
  return row ?? null;
}
