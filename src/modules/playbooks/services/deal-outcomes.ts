import type { z } from 'zod';
import { resolveAccountId } from '@/modules/accounts';
import type { dealChanged } from '@/modules/crm/contracts/events';
import type { ModuleContext } from '@/platform/context';
import { recordOutcome } from './outcomes';

export type DealOutcomeInput = {
  accountId: string;
  system: string;
  dealExternalId: string;
  status: 'open' | 'won' | 'lost';
  amountCents: number | null;
  openedAt: Date | null;
  closedAt: Date | null;
  observedAt: Date;
};

/**
 * Ruling 3. A deal that is open or won records `opportunity` (once per plan, at its open date); a won deal also records
 * `won` and a lost deal `lost` (at its close date, with the amount). It reads only the deal as it is now, so redelivery
 * and the backfill's cached deals record nothing twice: the ref `{system}:{dealExternalId}` is unique per kind.
 */
export async function recordDealOutcomes(ctx: ModuleContext, d: DealOutcomeInput): Promise<void> {
  const ref = `${d.system}:${d.dealExternalId}`;
  if (d.status !== 'lost') await recordOutcome(ctx, { accountId: d.accountId, kind: 'opportunity', ref, source: 'crm', occurredAt: d.openedAt ?? d.observedAt });
  if (d.status === 'open') return;
  await recordOutcome(ctx, { accountId: d.accountId, kind: d.status, ref, source: 'crm', occurredAt: d.closedAt ?? d.observedAt, amountCents: d.amountCents });
}

/** `crm.deal.changed`: records the deal's outcomes on its account's plan, following a merged account to its survivor. */
export async function onDealChanged(e: { data: z.output<typeof dealChanged.data> }, ctx: ModuleContext): Promise<void> {
  const d = e.data;
  const accountId = (await resolveAccountId(ctx, d.accountId))?.id ?? d.accountId;
  await recordDealOutcomes(ctx, {
    accountId,
    system: d.system,
    dealExternalId: d.dealExternalId,
    status: d.status,
    amountCents: d.amountCents,
    openedAt: d.openedAt ? new Date(d.openedAt) : null,
    closedAt: d.closedAt ? new Date(d.closedAt) : null,
    observedAt: new Date(d.observedAt),
  });
}
