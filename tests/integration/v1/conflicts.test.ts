// R2a Task 3: reading and settling conflicts (ACC-E3-S3/S4).
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as getConflicts } from '@/http/routes/v1/accounts/[id]/conflicts/route';
import { POST as conflictAction } from '@/http/routes/v1/conflicts/[id]/route';
import { editAccount, editPerson } from '@/modules/accounts';
import { account, accountSummary, conflict, fact, person } from '@/modules/accounts/db/schema';
import { setPrincipalCacheTtl } from '@/modules/tenancy';
import { adminDb, closeDbs } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { call, keyFor, personAndAgent } from './intake-helpers';
import { workspace, type Workspace } from './review-helpers';

let w: Workspace;
let leader: string;
let hiddenSeller: string;
let bo: { personId: string; agentId: string };

beforeAll(async () => {
  w = await workspace('Conflict Co');
  leader = await w.person('leader', { name: 'Dana Ruiz' });
  hiddenSeller = await w.person('seller', { dataLimit: { kind: 'own_accounts' }, extra: ['review:act'] });
  bo = await personAndAgent(w.tenant, 'Bo');
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

type FactOut = { id: string; value: unknown; observed_at: string; source_names: Record<string, string | null>; trust: number; status: string };
type ConflictOut = {
  id: string;
  key: string;
  label: string;
  person_id: string | null;
  status: string;
  resolution: string | null;
  kept_fact_id: string | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
  note: string | null;
  explanation: string | null;
  facts: FactOut[];
};

const list = async (accountId: string, userId = leader) => {
  const res = await w.as(userId, getConflicts, `accounts/${accountId}/conflicts`);
  expect(res.status).toBe(200);
  return (await res.json()).data as ConflictOut[];
};
const resolve = (id: string, body: unknown, userId = leader) => w.as(userId, conflictAction, `conflicts/${id}:resolve`, 'POST', body);

/** Ash's agent says 1,000 employees, then Bo's agent says 2,000: one open conflict. */
async function pair() {
  const domain = `${newId('acc').slice(-10).toLowerCase()}-example.com`;
  const accountId = await w.sent({ name: 'Pair Co', domain, employees: 1000 });
  expect(await w.sent({ name: 'Pair Co', domain, employees: 2000 }, bo.agentId)).toBe(accountId);
  const [c] = await list(accountId);
  const a = c!.facts.find((f) => f.value === 1000)!;
  const b = c!.facts.find((f) => f.value === 2000)!;
  return { accountId, conflictId: c!.id, a: a.id, b: b.id };
}

const factRow = async (id: string) => (await w.run((ctx) => ctx.tx.select().from(fact).where(eq(fact.id, id))))[0]!;
const employeesOf = async (id: string) => (await w.run((ctx) => ctx.tx.select({ n: account.employees }).from(account).where(eq(account.id, id))))[0]!.n;
const countOf = async (id: string) =>
  (await w.run((ctx) => ctx.tx.select({ n: accountSummary.openConflictCount }).from(accountSummary).where(eq(accountSummary.accountId, id))))[0]!.n;
const resolvedEvents = async (conflictId: string) =>
  (
    (await adminDb.execute(
      sql`select payload from platform.outbox where tenant_id = ${w.tenantId} and payload->>'type' = 'accounts.conflict.resolved'
          and payload->'data'->>'conflictId' = ${conflictId} order by seq`,
    )) as unknown as { payload: { data: Record<string, unknown> } }[]
  ).map((r) => r.payload.data);
const audits = (conflictId: string) =>
  w.run((ctx) => ctx.tx.select().from(auditLog).where(and(eq(auditLog.action, 'accounts.conflict.resolve'), eq(auditLog.subjectId, conflictId))));

/**
 * Pat's email, pat@a.gov (current) vs pat@b.gov (candidate) from two vendors, in an open conflict. With `taken`,
 * another person at the account already has pat@b.gov.
 */
async function emailConflict(opts: { taken?: boolean } = {}) {
  const domain = `${newId('acc').slice(-10).toLowerCase()}-example.com`;
  const accountId = await w.sent({ name: 'Mail Co', domain, employees: 10 });
  const personId = newId('per');
  const [a, b] = [newId('fct'), newId('fct')];
  const conflictId = newId('cfl');
  await w.run(async (ctx) => {
    await ctx.tx.insert(person).values({ id: personId, tenantId: ctx.tenantId, accountId, firstName: 'Pat', lastName: 'Lee', email: 'pat@a.gov' });
    if (opts.taken) await ctx.tx.insert(person).values({ id: newId('per'), tenantId: ctx.tenantId, accountId, firstName: 'Pat', lastName: 'Other', email: 'pat@b.gov' });
    await ctx.tx.insert(fact).values(
      [a, b].map((id, i) => ({
        id,
        tenantId: ctx.tenantId,
        accountId,
        personId,
        key: 'email',
        value: i ? 'pat@b.gov' : 'pat@a.gov',
        valueType: 'string',
        kind: 'contact',
        vendorSourceId: i ? 'src_b' : 'src_a',
        observedAt: new Date(),
        status: i ? 'candidate' : 'current',
      })),
    );
    await ctx.tx.insert(conflict).values({ id: conflictId, tenantId: ctx.tenantId, accountId, personId, key: 'email', factIds: [a, b] });
  });
  return { accountId, personId, conflictId, a, b };
}
const outboxOf = async (type: string, accountId: string) =>
  (
    (await adminDb.execute(
      sql`select payload from platform.outbox where tenant_id = ${w.tenantId} and payload->>'type' = ${type}
          and payload->'data'->>'accountId' = ${accountId} order by seq`,
    )) as unknown as { payload: { data: Record<string, unknown> } }[]
  ).map((r) => r.payload.data);

describe('person conflicts', () => {
  it('keeping a person value re-picks the person and tells person consumers', async () => {
    const { accountId, personId, conflictId, b } = await emailConflict();
    const res = await resolve(conflictId, { kept_fact_id: b });
    expect(res.status).toBe(200);
    const [p] = await w.run((ctx) => ctx.tx.select({ email: person.email }).from(person).where(eq(person.id, personId)));
    expect(p!.email).toBe('pat@b.gov');
    expect(await outboxOf('accounts.person.updated', accountId)).toEqual([expect.objectContaining({ accountId, personId, changedKeys: ['email'], roleKeys: [] })]);
  });

  it('keeping an email another person at the account already has is a 409', async () => {
    const { accountId, conflictId, b } = await emailConflict({ taken: true });
    const res = await resolve(conflictId, { kept_fact_id: b });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('That email is already on another person at this account.');
    expect((await list(accountId))[0]!.status).toBe('open');
  });

  it('a caller without people:read cannot settle a contact conflict: 404', async () => {
    const viewer = await w.person('viewer' as never, { extra: ['review:act'] });
    const { conflictId, b } = await emailConflict();
    expect((await resolve(conflictId, { kept_fact_id: b }, viewer)).status).toBe(404);
  });

  it("editing the person's email closes the conflict as edited", async () => {
    const { conflictId, personId, a, b } = await emailConflict();
    await w.run((ctx) => editPerson({ ...ctx, access: { userId: leader, dataLimit: { kind: 'all' } } }, personId, { email: 'pat@c.gov' }));
    const [row] = await w.run((ctx) => ctx.tx.select().from(conflict).where(eq(conflict.id, conflictId)));
    expect(row).toMatchObject({ status: 'resolved', resolution: 'edited' });
    expect(await factRow(row!.keptFactId!)).toMatchObject({ value: 'pat@c.gov', status: 'current' });
    expect((await factRow(a)).status).toBe('archived');
    expect((await factRow(b)).status).toBe('archived');
  });
});

describe('GET /accounts/{id}/conflicts', () => {
  it('shows the open conflict with each value, its sources by name and trust', async () => {
    const { accountId, conflictId } = await pair();
    const [c, ...rest] = await list(accountId);
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({ id: conflictId, key: 'employees', label: 'Employees', person_id: null, status: 'open', resolution: null, kept_fact_id: null, resolved_by_name: null });
    expect(c!.facts).toHaveLength(2);
    const a = c!.facts.find((f) => f.value === 1000)!;
    expect(a.source_names).toEqual({ person: 'Conflict Co Ash', agent: 'Conflict Co Ash agent', vendor: null });
    expect(a.trust).toBeCloseTo(0.6);
    expect(c!.facts.find((f) => f.value === 2000)!.source_names).toEqual({ person: 'Bo', agent: 'Bo agent', vendor: null });
  });

  it('a hidden or missing account is a 404', async () => {
    const { accountId } = await pair();
    expect((await w.as(hiddenSeller, getConflicts, `accounts/${accountId}/conflicts`)).status).toBe(404);
    expect((await w.as(leader, getConflicts, `accounts/acc_missing/conflicts`)).status).toBe(404);
  });

  it("a person's email conflict needs people:read", async () => {
    const { accountId } = await emailConflict();
    expect((await list(accountId)).map((c) => c.key)).toEqual(['email']);
    const key = await keyFor(w.tenant, ['accounts:read'], { dataLimit: { kind: 'all' } });
    const res = await call(getConflicts, key, `accounts/${accountId}/conflicts`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });
});

describe('POST /conflicts/{id}:resolve', () => {
  it('keeping B pins it, archives A, sets the column, clears the count, audits and says A lost', async () => {
    const { accountId, conflictId, a, b } = await pair();
    expect(await countOf(accountId)).toBe(1);
    const res = await resolve(conflictId, { kept_fact_id: b, note: 'Their filing says 2,000.' });
    expect(res.status).toBe(200);
    const view = (await res.json()) as ConflictOut;
    expect(view).toMatchObject({ id: conflictId, status: 'resolved', resolution: 'kept', kept_fact_id: b, resolved_by_name: 'Dana Ruiz', note: 'Their filing says 2,000.' });
    expect(view.facts.find((f) => f.id === a)!.status).toBe('archived');

    const kept = await factRow(b);
    expect(kept.status).toBe('current');
    expect(kept.pinnedAt).not.toBeNull();
    expect(kept.pinnedBy).toBe(leader);
    expect((await factRow(a)).status).toBe('archived');
    expect(await employeesOf(accountId)).toBe(2000);
    expect(await countOf(accountId)).toBe(0);

    const rows = await audits(conflictId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after).toMatchObject({ keptFactId: b, archivedFactIds: [a], note: 'Their filing says 2,000.' });

    const [event, ...more] = await resolvedEvents(conflictId);
    expect(more).toHaveLength(0);
    expect(event).toMatchObject({ conflictId, accountId, key: 'employees', keptFactId: b, archivedFactIds: [a], resolution: 'kept', resolvedBy: leader });
    expect(event!.losingSourceIds).toEqual([w.source.personId, w.source.agentId].sort());
    expect(event!.winningSourceIds).toEqual([bo.personId, bo.agentId].sort());

    // A resolved conflict is still listed.
    expect((await list(accountId)).map((c) => c.status)).toEqual(['resolved']);
  });

  it('resolving again with A switches the kept value (Ruling 6)', async () => {
    const { accountId, conflictId, a, b } = await pair();
    expect((await resolve(conflictId, { kept_fact_id: b })).status).toBe(200);
    const res = await resolve(conflictId, { kept_fact_id: a });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'resolved', kept_fact_id: a });

    const kept = await factRow(a);
    expect(kept.status).toBe('current');
    expect(kept.pinnedAt).not.toBeNull();
    expect((await factRow(b)).status).toBe('archived');
    expect(await employeesOf(accountId)).toBe(1000);
    expect(await countOf(accountId)).toBe(0);
    expect(await audits(conflictId)).toHaveLength(2);
    const events = await resolvedEvents(conflictId);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ keptFactId: a, archivedFactIds: [b] });
    expect(events[1]!.losingSourceIds).toEqual([bo.personId, bo.agentId].sort());
    expect(events[1]!.winningSourceIds).toEqual([w.source.personId, w.source.agentId].sort());
  });

  it('a kept_fact_id not in the conflict is a 400; a hidden or missing conflict is a 404; nothing changes', async () => {
    const { accountId, conflictId, a } = await pair();
    const other = await pair();
    const foreign = await resolve(conflictId, { kept_fact_id: other.a });
    expect(foreign.status).toBe(400);
    expect((await resolve(conflictId, { kept_fact_id: a, note: 'x'.repeat(1001) })).status).toBe(400);
    expect((await resolve(conflictId, { kept_fact_id: a }, hiddenSeller)).status).toBe(404);
    expect((await resolve('cfl_missing', { kept_fact_id: a })).status).toBe(404);
    expect((await list(accountId))[0]!.status).toBe('open');
    expect(await countOf(accountId)).toBe(1);
    expect((await factRow(a)).pinnedAt).toBeNull();
    expect(await audits(conflictId)).toHaveLength(0);
  });

  it('a value the same source has since replaced cannot be kept: 409', async () => {
    const { accountId, conflictId, a } = await pair();
    await w.run((ctx) => ctx.tx.update(fact).set({ status: 'superseded' }).where(eq(fact.id, a)));
    const res = await resolve(conflictId, { kept_fact_id: a });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('That value has been replaced by a newer one from the same source.');
    expect(await countOf(accountId)).toBe(1);
  });
});

describe('an edit closes the conflict (Ruling 7)', () => {
  it("editing the key keeps the edit's fact, archives the sources' facts and names no loser", async () => {
    const { accountId, conflictId, a, b } = await pair();
    await w.run((ctx) => editAccount({ ...ctx, access: { userId: leader, dataLimit: { kind: 'all' } } }, accountId, { employees: 1500 }));
    const [row] = await w.run((ctx) => ctx.tx.select().from(conflict).where(eq(conflict.id, conflictId)));
    expect(row).toMatchObject({ status: 'resolved', resolution: 'edited', resolvedBy: leader });
    const kept = await factRow(row!.keptFactId!);
    expect(kept).toMatchObject({ value: 1500, status: 'current' });
    expect(kept.pinnedAt).not.toBeNull();
    expect((await factRow(a)).status).toBe('archived');
    expect((await factRow(b)).status).toBe('archived');
    expect(await countOf(accountId)).toBe(0);
    const [event] = await resolvedEvents(conflictId);
    expect(event).toMatchObject({ resolution: 'edited', keptFactId: kept.id, losingSourceIds: [] });
    expect([...(event!.archivedFactIds as string[])].sort()).toEqual([a, b].sort());
    expect((await list(accountId))[0]).toMatchObject({ status: 'resolved', resolution: 'edited', kept_fact_id: kept.id });
  });
});
