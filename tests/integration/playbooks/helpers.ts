import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { setPractices, upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { aiRun } from '@/modules/ai-tasks/db/schema';
import { arrivalResolved } from '@/modules/intake/contracts/events';
import { brief, briefSection, briefSectionHistory } from '@/modules/playbooks/db/schema';
import { playbooksConsumers, playbooksJobHandlers } from '@/modules/playbooks';
import { scoreAccount, type Tier } from '@/modules/scoring';
import { setTierOverride } from '@/modules/scoring';
import { adminDb } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { EnvelopeSchema, type Envelope } from '@/platform/events/envelope';
import { newId } from '@/platform/ids';
import { deliverOnce } from '@/platform/runtime/worker';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { asPerson, domain, routingTenant, type Tenant } from '../routing/helpers';

export { asPerson, domain, routingTenant, type Tenant };

export const arrival = (over: Partial<ArrivalForAccounts> = {}): ArrivalForAccounts => ({
  arrivalId: newId('evt').replace('evt_', 'arr_'),
  receivedAt: new Date(),
  sourceChain: {},
  account: {},
  people: [],
  signals: [],
  facts: [],
  research: {},
  soleProprietor: false,
  externalIds: [],
  ...over,
});

/**
 * An account that arrived, scored once, and holds `tier` by hand before any event is delivered, so its first
 * draft sees that tier. Then everything is delivered.
 */
export async function scoredAccount(t: Tenant, tier: Tier, over: Partial<ArrivalForAccounts> = {}, opts: { practiceIds?: string[] } = {}): Promise<string> {
  const a = arrival({ ...over, account: { name: 'Brief Co', domain: domain(), industry: 'Logistics', ...over.account } });
  const { accountId } = await t.run((ctx) => upsertFromArrival(ctx, a));
  if (opts.practiceIds) await t.run((ctx) => setPractices(ctx, accountId, opts.practiceIds!, 'hint', { publish: false }));
  await t.run((ctx) => scoreAccount(ctx, accountId, 'manual_rescore'));
  await asPerson(t, (ctx) => setTierOverride(ctx, accountId, { tier }));
  await publishTestEvent(t.tenantId, arrivalResolved, {
    arrivalId: a.arrivalId,
    accountId,
    resolution: 'created',
    sourceChain: {},
    isFirstFromSource: true,
    initialReviewStatusKey: 'unvetted',
    effectiveTrust: 0.6,
  });
  await runOutbox(t.tenantId);
  return accountId;
}

/** Delivers only the playbooks consumers and jobs (marking every row sent), so other modules' reactions stay out of the test. */
export async function runPlaybooks(tenantId: string, maxRounds = 10): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    const rows = await adminDb.select().from(outbox).where(and(eq(outbox.tenantId, tenantId), isNull(outbox.sentAt))).orderBy(asc(outbox.seq));
    if (rows.length === 0) return;
    for (const row of rows) {
      const envelope = EnvelopeSchema.parse(row.payload) as Envelope;
      for (const c of playbooksConsumers) if (c.event.type === envelope.type) await deliverOnce(c, envelope);
      for (const j of playbooksJobHandlers) if (`jobs.${j.name}` === envelope.type) await deliverOnce(j, envelope);
      await adminDb.update(outbox).set({ sentAt: new Date() }).where(eq(outbox.seq, row.seq));
    }
  }
  throw new Error('runPlaybooks: rows still unsent');
}

export const briefRow = async (accountId: string) => (await adminDb.select().from(brief).where(eq(brief.accountId, accountId)))[0];
export const sectionRows = (accountId: string) => adminDb.select().from(briefSection).where(eq(briefSection.accountId, accountId)).orderBy(asc(briefSection.key));
export const historyRows = (accountId: string) =>
  adminDb.select().from(briefSectionHistory).where(eq(briefSectionHistory.accountId, accountId)).orderBy(asc(briefSectionHistory.key), asc(briefSectionHistory.version));
export const briefRuns = (tenantId: string) =>
  adminDb.select().from(aiRun).where(and(eq(aiRun.tenantId, tenantId), eq(aiRun.task, 'account_brief'))).orderBy(asc(aiRun.createdAt), asc(aiRun.id));

/** Draft jobs ever queued for the account. */
export async function draftJobs(tenantId: string, accountId: string): Promise<number> {
  const rows = (await adminDb.execute(
    sql`select count(*)::int as n from platform.outbox where tenant_id = ${tenantId} and payload->>'type' = 'jobs.playbooks.brief.draft' and payload->'data'->>'accountId' = ${accountId}`,
  )) as unknown as { n: number }[];
  return rows[0]!.n;
}

export const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
