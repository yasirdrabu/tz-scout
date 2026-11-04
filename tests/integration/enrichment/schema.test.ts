import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { request } from '@/modules/enrichment/db/schema';
import { requestCancelled, requestFlagged } from '@/modules/enrichment/contracts/events';
import { expireRequestsJob, runRequestJob } from '@/modules/enrichment/contracts/jobs';
import { withWorkspaceAdmin } from '@/platform/db/doors';
import { newId } from '@/platform/ids';
import { freshTenant } from '../integrations/helpers';

describe('enrichment schema', () => {
  it('forces row level security on every enrichment table', async () => {
    // The module's tables live in the workspace database (D35), not the control plane `adminDb` reads.
    const rows = await withWorkspaceAdmin('t_enrichment_schema', (tx) =>
      tx.execute<{ name: string; rls: boolean; forced: boolean }>(sql`
        select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'enrichment' and c.relkind in ('r', 'p') and c.relname <> '__migrations' order by 1`),
    );
    expect(rows.map((r) => r.name)).toEqual(['request']);
    expect(rows.every((r) => r.rls && r.forced)).toBe(true);
  });

  it('a row written as tenant A is not read as tenant B', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    await a.run((ctx) =>
      ctx.tx.insert(request).values({
        id: newId('enr'),
        tenantId: ctx.tenantId,
        accountId: newId('acc'),
        kind: 'people_for_roles',
        params: { roles: ['champion'] },
        providerKey: 'apollo',
        requestedBy: 'usr_1',
        requestedByLabel: 'Dana Ruiz',
        reason: 'New champion needed',
        estimate: { credits: 3, cost_cents: 30 },
        status: 'flagged',
      }),
    );
    const [row] = await a.run((ctx) => ctx.tx.select().from(request));
    expect(row).toMatchObject({ status: 'flagged', watchers: [], waitingReason: null, result: null });
    expect(row!.id).toMatch(/^enr_/);
    expect(await b.run((ctx) => ctx.tx.select().from(request))).toHaveLength(0);
  });

  it('refuses an unknown status or kind, and a request with no account', async () => {
    const a = await freshTenant();
    const base = { tenantId: '', accountId: 'acc_1', kind: 'email_reveal', providerKey: 'apollo', requestedBy: 'usr_1', estimate: {}, status: 'flagged' };
    const insert = (o: Partial<typeof base>) =>
      a.run((ctx) => ctx.tx.insert(request).values({ ...base, ...o, id: newId('enr'), tenantId: ctx.tenantId }));
    await expect(insert({ status: 'paused' })).rejects.toThrow();
    await expect(insert({ kind: 'mind_reading' })).rejects.toThrow();
    await expect(insert({ accountId: null as unknown as string })).rejects.toThrow();
  });
});

describe('enrichment contracts', () => {
  it('the job and event schemas parse a valid sample', () => {
    expect(runRequestJob.name).toBe('enrichment.request.run');
    expect(runRequestJob.opts).toMatchObject({ maxDeliver: 5, timeoutMs: 120_000, backoffMs: [30_000, 120_000, 600_000, 3_600_000] });
    expect(runRequestJob.data.safeParse({ requestId: 'enr_1' }).success).toBe(true);
    expect(expireRequestsJob.name).toBe('enrichment.request.expire');
    expect(requestCancelled.data.safeParse({ requestId: 'enr_1', accountId: 'acc_1', reason: 'expired' }).success).toBe(true);
    expect(
      requestFlagged.data.safeParse({
        requestId: 'enr_1',
        accountId: 'acc_1',
        kind: 'email_reveal',
        requestedBy: 'usr_1',
        requestedByLabel: 'Dana Ruiz',
        reason: 'Need to reach them',
        estimate: { credits: 1, costCents: 10 },
      }).success,
    ).toBe(true);
    expect(requestFlagged.data.safeParse({ requestId: 'enr_1', kind: 'email_reveal' }).success).toBe(false);
  });
});
