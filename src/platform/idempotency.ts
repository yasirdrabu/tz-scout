import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Tx } from './db/tenant';

export type Claim =
  | { kind: 'claimed' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'mismatch' };

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/**
 * Takes the key for (tenant, principal, key) in `tx`, or says what the earlier request left.
 * A row older than 24 hours is taken over. A live row is left alone: when its request is still
 * running, the insert waits for that transaction, so the caller sees the stored response once
 * the first request commits. Keys are tenant-isolated by row level security.
 */
export async function claimKey(
  tx: Tx,
  k: { tenantId: string; principalId: string; key: string; requestHash: string },
): Promise<Claim> {
  const taken = await tx.execute(
    sql`insert into platform.idempotency_key (tenant_id, principal_id, key, request_hash, response_status, response_body)
        values (${k.tenantId}, ${k.principalId}, ${k.key}, ${k.requestHash}, 0, '{}'::jsonb)
        on conflict (tenant_id, principal_id, key) do update
          set request_hash = excluded.request_hash, response_status = 0, response_body = '{}'::jsonb, created_at = now()
          where platform.idempotency_key.created_at < now() - interval '24 hours'
        returning 1`,
  );
  if (taken.length > 0) return { kind: 'claimed' };
  const rows = await tx.execute(
    sql`select request_hash, response_status, response_body from platform.idempotency_key
        where tenant_id = ${k.tenantId} and principal_id = ${k.principalId} and key = ${k.key}`,
  );
  const row = rows[0] as { request_hash: string; response_status: number; response_body: unknown };
  if (row.request_hash !== k.requestHash) return { kind: 'mismatch' };
  return { kind: 'replay', status: row.response_status, body: row.response_body };
}

/** Stores the final response on the claimed row, in the same transaction as the work. */
export async function storeResponse(
  tx: Tx,
  k: { tenantId: string; principalId: string; key: string },
  status: number,
  body: unknown,
): Promise<void> {
  await tx.execute(
    sql`update platform.idempotency_key set response_status = ${status}, response_body = ${JSON.stringify(body)}::jsonb
        where tenant_id = ${k.tenantId} and principal_id = ${k.principalId} and key = ${k.key}`,
  );
}
