import { eq } from 'drizzle-orm';
import { upsertFromArrival } from '@/modules/accounts';
import { accountSummary } from '@/modules/accounts/db/schema';
import { arrivalResolved } from '@/modules/intake/contracts/events';
import { addMember } from '@/modules/tenancy';
import type { Access, DataLimit } from '@/platform/access';
import type { ModuleContext } from '@/platform/context';
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant, type Tenant } from '../intake/helpers';
import { inTenant, seedUser } from '../tenancy/helpers';

export type { Tenant };

/** A tenant with every module's defaults delivered. */
export async function routingTenant(): Promise<Tenant> {
  const t = await freshTenant();
  await runOutbox(t.tenantId);
  return t;
}

export const domain = () => `${newId('acc').slice(-10).toLowerCase()}-example.com`;

type Chain = { personSourceId?: string; agentSourceId?: string; vendorSourceId?: string };

/** An account that arrived and resolved (`intake.arrival.resolved` delivered), so it has a review row and a summary. */
export async function arrivedAccount(
  t: Tenant,
  opts: { name?: string; initialReviewStatusKey?: string; sourceChain?: Chain; batchId?: string } = {},
): Promise<string> {
  const arrivalId = newId('evt').replace('evt_', 'arr_');
  const sourceChain = opts.sourceChain ?? {};
  const { accountId } = await t.run((ctx) =>
    upsertFromArrival(ctx, {
      arrivalId,
      receivedAt: new Date(),
      sourceChain,
      account: { name: opts.name ?? 'Queue Co', domain: domain() },
      people: [],
      signals: [],
      facts: [],
      research: {},
      soleProprietor: false,
      externalIds: [],
    }),
  );
  await resolved(t, accountId, { arrivalId, resolution: 'created', ...opts });
  return accountId;
}

/** Publishes and delivers `intake.arrival.resolved` for an account. */
export async function resolved(
  t: Tenant,
  accountId: string,
  opts: { arrivalId?: string; resolution?: 'created' | 'attached'; initialReviewStatusKey?: string; sourceChain?: Chain; batchId?: string } = {},
): Promise<void> {
  await publishTestEvent(t.tenantId, arrivalResolved, {
    arrivalId: opts.arrivalId ?? newId('evt').replace('evt_', 'arr_'),
    ...(opts.batchId ? { batchId: opts.batchId } : {}),
    accountId,
    resolution: opts.resolution ?? 'attached',
    sourceChain: opts.sourceChain ?? {},
    isFirstFromSource: true,
    initialReviewStatusKey: opts.initialReviewStatusKey ?? 'unvetted',
    effectiveTrust: 0.6,
  });
  await runOutbox(t.tenantId);
}

/** Runs `fn` as a signed-in person with the given data limit (the tenant owner by default). */
export function asPerson<T>(t: Tenant, fn: (ctx: ModuleContext) => Promise<T>, opts: { userId?: string; dataLimit?: DataLimit } = {}): Promise<T> {
  const access: Access = { userId: opts.userId ?? t.actor.id, dataLimit: opts.dataLimit ?? { kind: 'all' } };
  return inTenant(t.tenantId, { kind: 'user', id: access.userId! }, (ctx) => fn({ ...ctx, access }));
}

/** A member of the tenant; `invited` when they have never signed in. */
export async function member(t: Tenant, role: 'leader' | 'seller' | 'operator' = 'seller', opts: { invited?: boolean } = {}): Promise<string> {
  const u = await seedUser({ signedIn: !opts.invited });
  await t.run((ctx) => addMember(ctx, { email: u.email, role }));
  return u.id;
}

export const summaryOf = async (t: Tenant, accountId: string) => {
  const [row] = await t.run((ctx) => ctx.tx.select().from(accountSummary).where(eq(accountSummary.accountId, accountId)));
  return row!;
};

/** Sets summary columns scoring would fill, for filter and sort tests. */
export const setSummary = (t: Tenant, accountId: string, values: Partial<typeof accountSummary.$inferInsert>) =>
  t.run((ctx) => ctx.tx.update(accountSummary).set(values).where(eq(accountSummary.accountId, accountId)));
