import { newId } from '@/platform/ids';
import { withTenant } from '@/platform/db/tenant';
import type { EventDef } from '@/platform/events/registry';
import { publish } from '@/platform/events/outbox';

/** Writes one outbox row for `def`, so consumer tests can feed events no producer emits yet. Run `runOutbox` to deliver it. */
export async function publishTestEvent<D>(tenantId: string, def: EventDef<D>, data: D): Promise<void> {
  await withTenant(tenantId, (tx) =>
    publish({ tenantId, actor: { kind: 'system', id: 'test' }, correlationId: newId('cor'), tx }, def, data),
  );
}
