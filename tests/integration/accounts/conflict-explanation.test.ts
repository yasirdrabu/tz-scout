import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/ai-tasks', async (orig) => {
  const real = await orig<typeof import('@/modules/ai-tasks')>();
  return { ...real, runTask: vi.fn(real.runTask) };
});

import { runTask } from '@/modules/ai-tasks';
import { upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { conflict } from '@/modules/accounts/db/schema';
import { explainConflict } from '@/modules/accounts/services/explain';
import { adminDb } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant } from '../offers/helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
});

const domain = () => `${newId('acc').slice(-10).toLowerCase()}.example.com`;
let clock = Date.parse('2026-10-01T00:00:00Z');
const tick = () => new Date((clock += 60_000));

function arrival(over: Partial<ArrivalForAccounts> = {}): ArrivalForAccounts {
  return {
    arrivalId: newId('evt').replace('evt_', 'arr_'),
    receivedAt: tick(),
    sourceChain: { vendorSourceId: 'src_a' },
    account: {},
    people: [],
    signals: [],
    facts: [],
    research: {},
    soleProprietor: false,
    externalIds: [],
    ...over,
  };
}
const send = (accountId: string | undefined, over: Partial<ArrivalForAccounts>) => t.run((ctx) => upsertFromArrival(ctx, arrival(over), accountId));
const from = (source: string) => ({ sourceChain: { vendorSourceId: source } });
const row = async (id: string) => (await t.run((ctx) => ctx.tx.select().from(conflict).where(eq(conflict.id, id))))[0]!;
const explainJobs = async (conflictId: string) =>
  (await adminDb.execute(
    sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = 'jobs.accounts.conflict.explain'
        and payload->'data'->>'conflictId' = ${conflictId}`,
  )) as unknown as unknown[];

async function opened() {
  const a = await send(undefined, { ...from('src_a'), account: { name: 'Explain Co', domain: domain() }, research: { contract_value_cents: 2_090_000_000 } });
  const b = await send(a.accountId, { ...from('src_b'), research: { contract_value_cents: 1_840_000_000 } });
  return { accountId: a.accountId, conflictId: b.conflictIds[0]! };
}

const live = (output: { explanation: string; fact_ids: string[] }) =>
  vi.mocked(runTask).mockResolvedValueOnce({ output, runId: 'air_x', mode: 'live' } as never);

describe('conflict explanation (Ruling 9)', () => {
  it('queues a job when a conflict opens and again when it gains a fact, not inline', async () => {
    const { accountId, conflictId } = await opened();
    expect(await explainJobs(conflictId)).toHaveLength(1);
    expect((await row(conflictId)).explanation).toBeNull();
    await send(accountId, { ...from('src_c'), research: { contract_value_cents: 1_500_000_000 } });
    expect(await explainJobs(conflictId)).toHaveLength(2);
  });

  it('in mock mode the job runs and the explanation stays empty', async () => {
    const { conflictId } = await opened();
    await t.run((ctx) => explainConflict(ctx, conflictId));
    const c = await row(conflictId);
    expect(c.explanation).toBeNull();
    expect(c.explanationFactIds).toBeNull();
  });

  it('a live answer is stored, and fact ids outside the conflict are dropped', async () => {
    const { conflictId } = await opened();
    const [first] = (await row(conflictId)).factIds;
    live({ explanation: 'One may be a single division and the other the whole group.', fact_ids: [first!, 'fct_not_in_conflict'] });
    await t.run((ctx) => explainConflict(ctx, conflictId));
    const c = await row(conflictId);
    expect(c.explanation).toBe('One may be a single division and the other the whole group.');
    expect(c.explanationFactIds).toEqual([first]);
  });

  it('gives Claude each fact with its label, source name and date, and a prompt that never picks a winner', async () => {
    const { conflictId } = await opened();
    vi.mocked(runTask).mockClear();
    live({ explanation: 'x', fact_ids: [] });
    await t.run((ctx) => explainConflict(ctx, conflictId));
    const [, task, input] = vi.mocked(runTask).mock.calls[0]!;
    expect(task.name).toBe('conflict_explanation');
    expect(task.model).toBe('claude-sonnet-5-5');
    expect(task.system).toMatch(/never say which value is right/i);
    expect(input).toMatchObject({ key: 'contract_value_cents', label: expect.any(String) });
    expect((input as { facts: { id: string; observedAt: string }[] }).facts).toHaveLength(2);
  });

  it('skips a conflict that is gone or resolved', async () => {
    vi.mocked(runTask).mockClear();
    await t.run((ctx) => explainConflict(ctx, 'cfl_missing'));
    const { conflictId } = await opened();
    await adminDb.update(conflict).set({ status: 'resolved' }).where(eq(conflict.id, conflictId));
    await t.run((ctx) => explainConflict(ctx, conflictId));
    expect(runTask).not.toHaveBeenCalled();
    expect((await row(conflictId)).explanation).toBeNull();
  });

  it('does not store a sentence when the conflict gained a fact while Claude answered', async () => {
    const { accountId, conflictId } = await opened();
    vi.mocked(runTask).mockImplementationOnce((async () => {
      await send(accountId, { ...from('src_c'), research: { contract_value_cents: 1_500_000_000 } });
      return { output: { explanation: 'stale', fact_ids: [] }, runId: 'air_x', mode: 'live' };
    }) as never);
    await t.run((ctx) => explainConflict(ctx, conflictId));
    expect((await row(conflictId)).explanation).toBeNull();
  });
});
