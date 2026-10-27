import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mergeAccounts, upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { account, accountAlias, person } from '@/modules/accounts/db/schema';
import { getWarmIntro, resolveHandler, submitArrival, submitBatch } from '@/modules/intake';
import { arrival, batch, warmIntro } from '@/modules/intake/db/schema';
import { resolveTestHooks } from '@/modules/intake/services/resolve';
import type { ModuleContext } from '@/platform/context';
import { adminDb } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { EnvelopeSchema } from '@/platform/events/envelope';
import { newId } from '@/platform/ids';
import { deliverOnce } from '@/platform/runtime/worker';
import { runOutbox } from '../helpers/run-outbox';
import { asSource, freshTenant, personAndAgent, type Tenant } from './helpers';

let t: Tenant;
let personId: string;
let agentId: string;
let agent2Id: string;

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId); // tenant defaults: vendor sources, exclusion rules, relationship points
  ({ personId, agentId } = await personAndAgent(t));
  agent2Id = await t.run(async (ctx) => {
    const { registerSource } = await import('@/modules/intake');
    return (await registerSource(ctx, { kind: 'agent', name: 'Second agent', parentId: personId })).id;
  });
});

afterEach(() => {
  resolveTestHooks.afterStep = undefined;
});

let n = 0;
const uniqueDomain = () => `r${Date.now().toString(36)}${++n}.com`;
const asAgent = <T>(fn: (ctx: ModuleContext) => Promise<T>) => asSource(t, agentId, fn);
const send = (body: unknown, sourceId = agentId, channel: 'api' | 'file' = 'api') =>
  asSource(t, sourceId, (ctx) => submitArrival(ctx, body, { channel }));
const rowOf = async (id: string) => (await t.run((ctx) => ctx.tx.select().from(arrival).where(eq(arrival.id, id))))[0]!;

async function events(type: string, key: string, value: string) {
  const rows = (await adminDb.execute(
    sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = ${type}
        and payload->'data'->>${key} = ${value} order by seq`,
  )) as unknown as { payload: { data: Record<string, unknown> } }[];
  return rows.map((r) => r.payload.data);
}

const accountsWithDomain = (domain: string) =>
  t.run((ctx) => ctx.tx.select().from(account).where(and(eq(account.domain, domain), isNull(account.archivedAt))));

/** Runs the pending resolve jobs for these arrivals at the same time, each in its own transaction, as two workers would. */
async function resolveConcurrently(arrivalIds: string[]): Promise<void> {
  const rows = await adminDb
    .select()
    .from(outbox)
    .where(
      and(
        eq(outbox.tenantId, t.tenantId),
        isNull(outbox.sentAt),
        sql`${outbox.payload}->>'type' = 'jobs.intake.resolve'`,
        inArray(sql`${outbox.payload}->'data'->>'arrivalId'`, arrivalIds),
      ),
    );
  expect(rows).toHaveLength(arrivalIds.length);
  await Promise.all(rows.map((r) => deliverOnce(resolveHandler, EnvelopeSchema.parse(r.payload))));
  await adminDb.update(outbox).set({ sentAt: new Date() }).where(inArray(outbox.seq, rows.map((r) => r.seq)));
}

/** Makes every resolve wait after normalising, so concurrent jobs reach the lock together. */
const widenRace = () => {
  resolveTestHooks.afterStep = async (step) => {
    if (step === 'normalise') await new Promise((r) => setTimeout(r, 300));
  };
};

const seedArrival = (over: Partial<ArrivalForAccounts>): ArrivalForAccounts => ({
  arrivalId: newId('arr'),
  receivedAt: new Date(),
  sourceChain: { personSourceId: personId, agentSourceId: agentId },
  account: {},
  people: [],
  signals: [],
  facts: [],
  research: {},
  soleProprietor: false,
  externalIds: [],
  ...over,
});
const seed = (over: Partial<ArrivalForAccounts>, accountId?: string) =>
  t.run((ctx) => upsertFromArrival(ctx, seedArrival(over), accountId));

describe('duplicate checks (SRC-E3-S2)', () => {
  it('resolves miamidade.gov and https://www.miamidade.gov/x to one account, the second attached (AC1)', async () => {
    const first = await send({ account: { name: 'Miami-Dade County DTPW', domain: 'miamidade.gov' } });
    await runOutbox(t.tenantId);
    const second = await send({ account: { name: 'Miami-Dade Transit', website: 'https://www.miamidade.gov/x' } });
    await runOutbox(t.tenantId);

    const [a, b] = [await rowOf(first.arrivalId), await rowOf(second.arrivalId)];
    expect(a).toMatchObject({ status: 'resolved', resolution: 'created' });
    expect(b).toMatchObject({ status: 'resolved', resolution: 'attached', accountId: a.accountId });
    expect(await accountsWithDomain('miamidade.gov')).toHaveLength(1);
    const [resolved] = await events('intake.arrival.resolved', 'arrivalId', second.arrivalId);
    expect(resolved).toMatchObject({ accountId: a.accountId, resolution: 'attached' });
  });

  it('attaches an arrival for an alias of a merged account to the survivor (AC2)', async () => {
    const survivor = await seed({ account: { name: 'Survivor Co', domain: uniqueDomain() } });
    const mergedDomain = uniqueDomain();
    const merged = await seed({ account: { name: 'Merged Co', domain: mergedDomain } });
    const leader = { userId: 'usr_leader', sourceId: personId, dataLimit: { kind: 'all' as const } };
    await t.run((ctx) => mergeAccounts({ ...ctx, access: leader }, survivor.accountId, merged.accountId));

    const out = await send({ account: { name: 'Merged Co', domain: mergedDomain } });
    await runOutbox(t.tenantId);
    expect(await rowOf(out.arrivalId)).toMatchObject({ status: 'resolved', resolution: 'attached', accountId: survivor.accountId });
  });
});

describe('idempotent retries (SRC-E3-S1-AC3)', () => {
  it('gives one account, one set of people, facts and signals, and one resolved event after a failure past step 5', async () => {
    const domain = uniqueDomain();
    const out = await send({
      account: { name: 'Retry Co', domain, industry: 'Logistics' },
      people: [{ name: 'Rita Retry', email: `rita@${domain}` }],
      signals: [{ type: 'trigger', title: 'Opened a new depot', occurred_at: '2026-10-01' }],
    });
    resolveTestHooks.afterStep = (step) => {
      if (step === 'upsert') throw new Error('killed after step 5');
    };
    await expect(runOutbox(t.tenantId)).rejects.toThrow('killed after step 5');
    resolveTestHooks.afterStep = undefined;
    await runOutbox(t.tenantId);

    const row = await rowOf(out.arrivalId);
    expect(row.status).toBe('resolved');
    expect(row.steps).toEqual(expect.arrayContaining(['validate', 'normalise', 'match', 'upsert']));
    expect(await accountsWithDomain(domain)).toHaveLength(1);
    const people = await t.run((ctx) => ctx.tx.select().from(person).where(eq(person.accountId, row.accountId!)));
    expect(people).toHaveLength(1);
    const counts = (await t.run((ctx) =>
      ctx.tx.execute(sql`select (select count(*)::int from accounts.fact where arrival_id = ${out.arrivalId}) as facts,
                                (select count(*)::int from accounts.signal where arrival_id = ${out.arrivalId}) as signals`),
    )) as unknown as { facts: number; signals: number }[];
    expect(counts[0]!.signals).toBe(1);
    expect(counts[0]!.facts).toBeGreaterThan(0);
    const facts = (await t.run((ctx) =>
      ctx.tx.execute(sql`select key, count(*)::int as n from accounts.fact where arrival_id = ${out.arrivalId} group by key, person_id having count(*) > 1`),
    )) as unknown as unknown[];
    expect(facts).toEqual([]);
    expect(await events('intake.arrival.resolved', 'arrivalId', out.arrivalId)).toHaveLength(1);

    // A redelivery of the finished job does nothing.
    await t.run(async (ctx) => {
      const { resolveArrival } = await import('@/modules/intake/services/resolve');
      await resolveArrival(ctx, out.arrivalId);
    });
    expect(await events('intake.arrival.resolved', 'arrivalId', out.arrivalId)).toHaveLength(1);
  });
});

describe('first arrivals from a source (SRC-E3-S4-AC2)', () => {
  it('is true, then false for the same agent, and true for a second agent under the same person', async () => {
    const domain = uniqueDomain();
    const body = { account: { name: 'First Co', domain } };
    const ids: string[] = [];
    for (const source of [agentId, agentId, agent2Id]) {
      ids.push((await send(body, source)).arrivalId);
      await runOutbox(t.tenantId);
    }
    const firsts = await Promise.all(ids.map(async (id) => (await events('intake.arrival.resolved', 'arrivalId', id))[0]!.isFirstFromSource));
    expect(firsts).toEqual([true, false, true]);
  });

  it('carries the closest source review status and the effective trust', async () => {
    const out = await send({ account: { name: 'Status Co', domain: uniqueDomain() } });
    await runOutbox(t.tenantId);
    const [e] = await events('intake.arrival.resolved', 'arrivalId', out.arrivalId);
    expect(e).toMatchObject({
      initialReviewStatusKey: 'unvetted',
      effectiveTrust: 0.6,
      sourceChain: { agentSourceId: agentId, personSourceId: personId },
    });
  });
});

describe('exclusion', () => {
  it('rejects a software vendor arrival as excluded, with the account kept and the rule label as detail', async () => {
    const out = await send({
      account: { name: 'Vendorly', domain: uniqueDomain(), industry: 'Software', description: 'An AI-powered software platform.' },
    });
    await runOutbox(t.tenantId);
    const row = await rowOf(out.arrivalId);
    expect(row).toMatchObject({ status: 'rejected', rejectReason: 'excluded', rejectDetail: 'Software vendor' });
    expect(row.accountId).toMatch(/^acc_/);
    const [e] = await events('intake.arrival.rejected', 'arrivalId', out.arrivalId);
    expect(e).toMatchObject({ reason: 'excluded', detail: 'Software vendor', accountId: row.accountId });
    expect(await events('intake.arrival.resolved', 'arrivalId', out.arrivalId)).toEqual([]);
  });
});

describe('warm intros (SRC-E5)', () => {
  it('gives an agent-declared intro employee_network at 4 points, and getWarmIntro picks the 8-point confirmed one', async () => {
    const domain = uniqueDomain();
    const intro = { introducer_name: 'Ash', relationship: 'knows the CTC director from FPTA' };
    const byAgent = await send({ account: { name: 'Intro Co', domain }, warm_intro: intro });
    await runOutbox(t.tenantId);
    const row = await rowOf(byAgent.arrivalId);
    const [stored] = await t.run((ctx) => ctx.tx.select().from(warmIntro).where(eq(warmIntro.arrivalId, byAgent.arrivalId)));
    expect(stored).toMatchObject({ relationshipKey: 'employee_network', points: 8, effectivePoints: 4, confirmed: false });
    expect(row.warmIntroId).toBe(stored!.id);
    const [e] = await events('intake.arrival.resolved', 'arrivalId', byAgent.arrivalId);
    expect(e!.warmIntro).toEqual({ warmIntroId: stored!.id, relationshipKey: 'employee_network', points: 4, confirmed: false });

    const byPerson = await send({ account: { name: 'Intro Co', domain }, warm_intro: intro }, personId);
    await runOutbox(t.tenantId);
    expect((await rowOf(byPerson.arrivalId)).accountId).toBe(row.accountId);
    const best = await t.run((ctx) => getWarmIntro(ctx, row.accountId!));
    expect(best).toMatchObject({ relationshipKey: 'employee_network', points: 8, confirmed: true, introducerName: 'Ash' });
  });

  it('maps an unknown relationship to other', async () => {
    const out = await send({ account: { name: 'Other Intro', domain: uniqueDomain() }, warm_intro: { introducer_name: 'Bo', relationship: 'my cousin' } });
    await runOutbox(t.tenantId);
    const [stored] = await t.run((ctx) => ctx.tx.select().from(warmIntro).where(eq(warmIntro.arrivalId, out.arrivalId)));
    expect(stored).toMatchObject({ relationshipKey: 'other', points: 3, effectivePoints: 1 });
  });
});

describe('batch completion (Review Focus 5, completion side)', () => {
  const batchRow = async (id: string) => (await t.run((ctx) => ctx.tx.select().from(batch).where(eq(batch.id, id))))[0]!;

  it('resolves the valid items and publishes intake.batch.completed once with its counts', async () => {
    const known = uniqueDomain();
    await seed({ account: { name: 'Known Co', domain: known } });
    const items = [
      { account: { name: 'New Co', domain: uniqueDomain() }, external_ref: 'rf5-1' },
      { account: { domain: 'not a domain' }, external_ref: 'rf5-2' },
      { account: { name: 'New Co again', domain: uniqueDomain() }, external_ref: 'rf5-1' },
      { account: { name: 'Known Co', domain: known }, external_ref: 'rf5-3' },
    ];
    const out = await asAgent((ctx) =>
      submitBatch(ctx, { name: 'Run', metadata: { reported_cost: { credits: 3, cost_cents: 120, currency: 'USD' } }, items }, { channel: 'api' }),
    );
    expect(await events('intake.batch.completed', 'batchId', out.batchId)).toEqual([]);
    await runOutbox(t.tenantId);

    const statuses = await Promise.all(out.items.map(async (i) => (await rowOf(i.arrivalId)).status));
    expect(statuses).toEqual(['resolved', 'rejected', 'rejected', 'resolved']);
    const completed = await events('intake.batch.completed', 'batchId', out.batchId);
    expect(completed).toEqual([
      {
        batchId: out.batchId,
        counts: { resolved: 2, rejected: 2, newAccounts: 1, alreadyKnown: 1 },
        reportedCost: { credits: 3, costCents: 120, currency: 'USD' },
      },
    ]);
    expect(await batchRow(out.batchId)).toMatchObject({ status: 'completed', completedAt: expect.any(Date) });
  });

  it('completes a batch whose items were all rejected at submit', async () => {
    const out = await asAgent((ctx) => submitBatch(ctx, { name: 'All bad', items: [{ account: { domain: 'nope nope' } }] }, { channel: 'api' }));
    expect(await batchRow(out.batchId)).toMatchObject({ status: 'completed' });
    expect(await events('intake.batch.completed', 'batchId', out.batchId)).toEqual([
      { batchId: out.batchId, counts: { resolved: 0, rejected: 1, newAccounts: 0, alreadyKnown: 0 } },
    ]);
  });

  it('completes a batch with no stored items (all repeats of earlier requests)', async () => {
    const body = { account: { name: 'Repeat Co', domain: uniqueDomain(), external_ref: 'rep-1' } };
    await send(body);
    const out = await asAgent((ctx) => submitBatch(ctx, { name: 'Repeats', items: [body] }, { channel: 'api' }));
    expect(await batchRow(out.batchId)).toMatchObject({ status: 'completed', itemCount: 0 });
    expect(await events('intake.batch.completed', 'batchId', out.batchId)).toHaveLength(1);
    await runOutbox(t.tenantId);
    expect(await events('intake.batch.completed', 'batchId', out.batchId)).toHaveLength(1);
  });
});

describe('concurrency (Review Focus 1)', () => {
  it("gives one account for two agents' batches with the same domain resolved concurrently", async () => {
    await runOutbox(t.tenantId);
    const domain = uniqueDomain();
    const one = await asSource(t, agentId, (ctx) => submitBatch(ctx, { name: 'A', items: [{ account: { name: 'Acme', domain } }] }, { channel: 'api' }));
    const two = await asSource(t, agent2Id, (ctx) => submitBatch(ctx, { name: 'B', items: [{ account: { name: 'Acme', domain } }] }, { channel: 'api' }));
    widenRace();
    await resolveConcurrently([one.items[0]!.arrivalId, two.items[0]!.arrivalId]);
    expect(await accountsWithDomain(domain)).toHaveLength(1);
    const rows = await Promise.all([rowOf(one.items[0]!.arrivalId), rowOf(two.items[0]!.arrivalId)]);
    expect(rows.map((r) => r.resolution).sort()).toEqual(['attached', 'created']);
    expect(rows[0]!.lockKey).toBe(domain);
  });

  it('gives one account for two lenient no-domain arrivals named Keystone Ridge Properties, US, resolved concurrently', async () => {
    await runOutbox(t.tenantId);
    const arrivals = await Promise.all(
      ['keystone-a', 'keystone-b'].map((slug) =>
        send({ account: { name: 'Keystone Ridge Properties', country: 'US', linkedin_url: `https://linkedin.com/company/${slug}` } }, agentId, 'file'),
      ),
    );
    widenRace();
    await resolveConcurrently(arrivals.map((a) => a.arrivalId));
    const rows = await Promise.all(arrivals.map((a) => rowOf(a.arrivalId)));
    expect(rows.map((r) => r.status)).toEqual(['resolved', 'resolved']);
    expect(rows[0]!.accountId).toBe(rows[1]!.accountId);
    expect(rows[0]!.lockKey).toBe('name:keystone ridge properties|US');
  });

  it('gives one account and no duplicate people for an alias-domain arrival racing a primary-domain arrival', async () => {
    await runOutbox(t.tenantId);
    const primary = uniqueDomain();
    const alias = uniqueDomain();
    const acc = await seed({ account: { name: 'Alias Co', domain: primary } });
    await t.run((ctx) => ctx.tx.insert(accountAlias).values({ tenantId: t.tenantId, accountId: acc.accountId, kind: 'domain', value: alias }));
    const people = [{ name: 'Pat Alias', email: `pat@${primary}` }];
    const arrivals = [
      await send({ account: { name: 'Alias Co', domain: alias }, people }),
      await send({ account: { name: 'Alias Co', domain: primary }, people }),
    ];
    widenRace();
    await resolveConcurrently(arrivals.map((a) => a.arrivalId));
    const rows = await Promise.all(arrivals.map((a) => rowOf(a.arrivalId)));
    expect(rows.map((r) => r.accountId)).toEqual([acc.accountId, acc.accountId]);
    const both = [...(await accountsWithDomain(primary)), ...(await accountsWithDomain(alias))];
    expect(both.map((x) => x.id)).toEqual([acc.accountId]);
    const found = await t.run((ctx) => ctx.tx.select().from(person).where(and(eq(person.accountId, acc.accountId), isNull(person.archivedAt))));
    expect(found).toHaveLength(1);
  });

  it('gives one person for an inline add_person racing a resolve job for the same account', async () => {
    await runOutbox(t.tenantId);
    const domain = uniqueDomain();
    const acc = await seed({ account: { name: 'Inline Co', domain } });
    const people = [{ name: 'Ines Inline', email: `ines@${domain}` }];
    const job = await send({ account: { name: 'Inline Co', domain }, people });
    widenRace();
    const inline = asAgent(async (ctx) => {
      await new Promise((r) => setTimeout(r, 150));
      return submitArrival(ctx, { target_account_id: acc.accountId, people }, { channel: 'api', inline: true });
    });
    const [, added] = await Promise.all([resolveConcurrently([job.arrivalId]), inline]);
    const found = await t.run((ctx) => ctx.tx.select().from(person).where(and(eq(person.accountId, acc.accountId), isNull(person.archivedAt))));
    expect(found).toHaveLength(1);
    expect(added.status).toBe('resolved');
    expect(added.inlineResult).toMatchObject({ arrivalId: added.arrivalId, accountId: acc.accountId, personIds: [found[0]!.id] });
  });
});

describe('inline resolution', () => {
  it('resolves a targeted arrival in the call and reports whether the person was already known', async () => {
    const domain = uniqueDomain();
    const acc = await seed({ account: { name: 'Add Person Co', domain } });
    const body = { target_account_id: acc.accountId, people: [{ name: 'Al Add', email: `al@${domain}` }] };
    const first = await asAgent((ctx) => submitArrival(ctx, body, { channel: 'api', inline: true }));
    expect(first.inlineResult).toMatchObject({ accountId: acc.accountId, alreadyKnown: false, signalIds: [] });
    const again = await asAgent((ctx) => submitArrival(ctx, { ...body }, { channel: 'api', inline: true }));
    expect(again.inlineResult).toMatchObject({ alreadyKnown: true, personIds: (first.inlineResult as { personIds: string[] }).personIds });
    expect(await rowOf(first.arrivalId)).toMatchObject({ status: 'resolved', resolution: 'attached', accountId: acc.accountId });
    expect(await events('intake.arrival.resolved', 'arrivalId', first.arrivalId)).toHaveLength(1);
    const jobs = await adminDb.execute(
      sql`select 1 from platform.outbox where payload->>'type' = 'jobs.intake.resolve' and payload->'data'->>'arrivalId' = ${first.arrivalId}`,
    );
    expect(jobs).toHaveLength(0);
  });
});

describe('no Claude key', () => {
  it('resolves an arrival with an unknown industry, leaving industry_key null', async () => {
    const domain = uniqueDomain();
    const out = await send({ account: { name: 'Widget Works', domain, industry: 'Widgets' } });
    await runOutbox(t.tenantId);
    const row = await rowOf(out.arrivalId);
    expect(row.status).toBe('resolved');
    const [acc] = await accountsWithDomain(domain);
    expect(acc).toMatchObject({ industry: 'Widgets', industryKey: null });
  });
});

describe('waiting checks', () => {
  it('waits needs_website for a file row with no website, and the batch stays open', async () => {
    const out = await send({ account: { name: 'No Site Co' } }, agentId, 'file');
    await runOutbox(t.tenantId);
    const row = await rowOf(out.arrivalId);
    expect(row).toMatchObject({ status: 'resolving', waitingOn: 'needs_website', waitingSince: expect.any(Date) });
    expect(await events('intake.arrival.waiting', 'arrivalId', out.arrivalId)).toEqual([{ arrivalId: out.arrivalId, waitingOn: 'needs_website' }]);
  });

  it('continues when a stored resolution_input supplies the website', async () => {
    const out = await send({ account: { name: 'Later Site Co' } }, agentId, 'file');
    await runOutbox(t.tenantId);
    const domain = uniqueDomain();
    await t.run(async (ctx) => {
      await ctx.tx.update(arrival).set({ resolutionInput: { website: `https://${domain}` } }).where(eq(arrival.id, out.arrivalId));
      const { resolveArrival } = await import('@/modules/intake/services/resolve');
      await resolveArrival(ctx, out.arrivalId);
    });
    const row = await rowOf(out.arrivalId);
    expect(row).toMatchObject({ status: 'resolved', waitingOn: null, resolution: 'created' });
    expect(await accountsWithDomain(domain)).toHaveLength(1);
  });

  it('waits needs_company for only a person with a personal email', async () => {
    const out = await send({ people: [{ name: 'Sam Solo', email: 'sam.solo@gmail.com' }] }, agentId, 'file');
    await runOutbox(t.tenantId);
    expect(await rowOf(out.arrivalId)).toMatchObject({ status: 'resolving', waitingOn: 'needs_company' });
  });
});

describe('fix round 1', () => {
  const resume = (id: string, input: Record<string, unknown>) =>
    t.run(async (ctx) => {
      await ctx.tx.update(arrival).set({ resolutionInput: input }).where(eq(arrival.id, id));
      const { resolveArrival } = await import('@/modules/intake/services/resolve');
      await resolveArrival(ctx, id);
    });
  const batchOf = async (id: string) => (await t.run((ctx) => ctx.tx.select().from(batch).where(eq(batch.id, id))))[0]!;

  it('waits needs_company for a LinkedIn page with no name, keeping its batch open until a person supplies the company', async () => {
    const out = await asAgent((ctx) =>
      submitBatch(ctx, { name: 'Linkedin only', items: [{ account: { linkedin_url: 'https://linkedin.com/company/nameless' } }] }, { channel: 'webhook' }),
    );
    await runOutbox(t.tenantId);
    const id = out.items[0]!.arrivalId;
    expect(await rowOf(id)).toMatchObject({ status: 'resolving', waitingOn: 'needs_company' });
    expect(await batchOf(out.batchId)).toMatchObject({ status: 'processing' });

    await resume(id, { company: { name: 'Nameless Partners' } });
    expect(await rowOf(id)).toMatchObject({ status: 'resolved', waitingOn: null });
    expect(await batchOf(out.batchId)).toMatchObject({ status: 'completed' });
    expect(await events('intake.batch.completed', 'batchId', out.batchId)).toHaveLength(1);
  });

  it('waits needs_company for a sole proprietor whose person has no name', async () => {
    const out = await send({ sole_proprietor: true, people: [{ email: 'nobody.named@gmail.com' }] }, agentId, 'file');
    await runOutbox(t.tenantId);
    expect(await rowOf(out.arrivalId)).toMatchObject({ status: 'resolving', waitingOn: 'needs_company' });
  });

  it('keeps a replaced primary domain as an alias, so an arrival on the old primary still attaches', async () => {
    const a = uniqueDomain();
    const b = uniqueDomain();
    const acc = await seed({ account: { name: 'Two Domains', domain: a } });
    await t.run((ctx) => ctx.tx.insert(accountAlias).values({ tenantId: t.tenantId, accountId: acc.accountId, kind: 'domain', value: b }));
    const onB = await send({ account: { name: 'Two Domains', domain: b } });
    await runOutbox(t.tenantId);
    const onA = await send({ account: { name: 'Two Domains', domain: a } });
    await runOutbox(t.tenantId);
    expect((await rowOf(onB.arrivalId)).accountId).toBe(acc.accountId);
    expect((await rowOf(onA.arrivalId)).accountId).toBe(acc.accountId);
    const live = await t.run((ctx) =>
      ctx.tx.select().from(account).where(and(inArray(account.domain, [a, b]), isNull(account.archivedAt))),
    );
    expect(live.map((x) => x.id)).toEqual([acc.accountId]);
  });

  it('reports an inline arrival on an excluded account as rejected', async () => {
    const domain = uniqueDomain();
    const acc = await seed({ account: { name: 'Excluded Target', domain, industryKey: 'software' } });
    const out = await asAgent((ctx) =>
      submitArrival(ctx, { target_account_id: acc.accountId, people: [{ name: 'Ex Person', email: `ex@${domain}` }] }, { channel: 'api', inline: true }),
    );
    expect(out.status).toBe('rejected');
    expect(await rowOf(out.arrivalId)).toMatchObject({ status: 'rejected', rejectReason: 'excluded', rejectDetail: 'Software vendor' });
  });

  it('confirms a person-source key intro only with warm_intro:declare', async () => {
    const asKey = (can: boolean) =>
      t.run((ctx) =>
        submitArrival(
          { ...ctx, actor: { kind: 'agent', id: 'key_person' }, access: { sourceId: personId, dataLimit: { kind: 'own_source' } } },
          { account: { name: 'Key Intro', domain: uniqueDomain() }, warm_intro: { introducer_name: 'Ash', relationship: 'employee_network' } },
          { channel: 'api', canDeclareWarmIntro: can },
        ),
      );
    const withScope = await asKey(true);
    const without = await asKey(false);
    await runOutbox(t.tenantId);
    const intro = async (id: string) => (await t.run((ctx) => ctx.tx.select().from(warmIntro).where(eq(warmIntro.arrivalId, id))))[0];
    expect(await intro(withScope.arrivalId)).toMatchObject({ confirmed: true, points: 8, effectivePoints: 8 });
    expect(await intro(without.arrivalId)).toMatchObject({ confirmed: false, points: 8, effectivePoints: 4 });
  });
});
