// R2a Task 3, Ruling 8: a lost conflict is feedback for each losing source's arrival only.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { editAccount, listConflicts, resolveConflict } from '@/modules/accounts';
import { getArrivalWithStatus, registerSource, submitArrival } from '@/modules/intake';
import { sourceFeedback } from '@/modules/intake/db/schema';
import type { ModuleContext } from '@/platform/context';
import { closeDbs } from '@/platform/db/client';
import { runOutbox } from '../helpers/run-outbox';
import { asSource, freshTenant, personAndAgent, type Tenant } from './helpers';

let t: Tenant;
let ash: { personId: string; agentId: string };
let vendorId: string;

afterAll(closeDbs);
beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
  ash = await personAndAgent(t, 'Ash');
  vendorId = await t.run(async (ctx) => (await registerSource(ctx, { kind: 'vendor', name: 'Conflict Vendor' })).id);
});

let n = 0;
const domain = () => `cf${Date.now().toString(36)}${++n}-example.com`;
const asPerson = <T>(fn: (ctx: ModuleContext) => Promise<T>) => t.run((ctx) => fn({ ...ctx, access: { userId: 'usr_leader', dataLimit: { kind: 'all' } } }));

/** Ash's agent says 1,000 employees, then the vendor says 2,000. */
async function disagreement() {
  const d = domain();
  const a = await asSource(t, ash.agentId, (ctx) => submitArrival(ctx, { account: { name: `Conflict ${d}`, domain: d, employees: 1000 } }, { channel: 'api' }));
  const v = await asSource(t, vendorId, (ctx) => submitArrival(ctx, { account: { name: `Conflict ${d}`, domain: d, employees: 2000 } }, { channel: 'api' }));
  await runOutbox(t.tenantId);
  const accountId = (await asSource(t, ash.agentId, (ctx) => getArrivalWithStatus(ctx, a.arrivalId, { ownerName: false })))!.accountId!;
  const [c] = await asPerson((ctx) => listConflicts(ctx, accountId));
  return {
    accountId,
    arrivals: { ash: a.arrivalId, vendor: v.arrivalId },
    conflictId: c!.id,
    ashFact: c!.facts.find((f) => f.value === 1000)!.id,
    vendorFact: c!.facts.find((f) => f.value === 2000)!.id,
  };
}

const rowsFor = (accountId: string) =>
  t.run((ctx) => ctx.tx.select().from(sourceFeedback).where(and(eq(sourceFeedback.accountId, accountId), eq(sourceFeedback.kind, 'conflict_lost'))));

describe('conflict_lost feedback', () => {
  it("keeping the vendor's value tells Ash's sources, on their arrival, who won; the vendor hears nothing", async () => {
    const d = await disagreement();
    await asPerson((ctx) => resolveConflict(ctx, d.conflictId, d.vendorFact));
    await runOutbox(t.tenantId);
    const rows = await rowsFor(d.accountId);
    expect(rows.map((r) => r.sourceId).sort()).toEqual([ash.personId, ash.agentId].sort());
    for (const r of rows) expect(r).toMatchObject({ arrivalId: d.arrivals.ash, note: 'Conflict Vendor', byUserId: 'usr_leader' });
    expect(rows.some((r) => r.sourceId === vendorId)).toBe(false);

    await runOutbox(t.tenantId);
    expect(await rowsFor(d.accountId)).toHaveLength(2);
  });

  it('an edit that closes the conflict penalises no source', async () => {
    const d = await disagreement();
    await asPerson((ctx) => editAccount(ctx, d.accountId, { employees: 1500 }));
    await runOutbox(t.tenantId);
    expect(await rowsFor(d.accountId)).toHaveLength(0);
  });
});
