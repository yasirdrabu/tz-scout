import { eq } from 'drizzle-orm';
import { adminDb } from '@/platform/db/client';
import { connection } from '../db/schema';

/**
 * The tenant and provider of a connection id. An unauthenticated webhook has no tenant until its connection is found,
 * so this is the one lookup that reads across tenants (the file is in ADMIN_DB_ALLOWED). Null for an unknown id.
 */
export async function connectionTenant(connectionId: string): Promise<{ tenantId: string; provider: string } | null> {
  const [row] = await adminDb
    .select({ tenantId: connection.tenantId, provider: connection.provider })
    .from(connection)
    .where(eq(connection.id, connectionId))
    .limit(1);
  return row ?? null;
}
