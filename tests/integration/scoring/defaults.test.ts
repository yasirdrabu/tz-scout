import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rescoreAccountsJob, scoringTenantDefaults, seedScoringDefaults } from '@/modules/scoring';
import { scoringProfile } from '@/modules/scoring/db/schema';
import { adminDb, closeDbs } from '@/platform/db/client';
import { schedule } from '@/platform/db/schema';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant } from '../offers/helpers';

let a: Awaited<ReturnType<typeof freshTenant>>;
let b: Awaited<ReturnType<typeof freshTenant>>;

const profiles = (t: typeof a) => t.run((ctx) => ctx.tx.select().from(scoringProfile));
const ageing = (tenantId: string) =>
  adminDb.select().from(schedule).where(sql`${schedule.tenantId} = ${tenantId} and ${schedule.jobName} = 'scoring.ageing'`);

beforeAll(async () => {
  a = await freshTenant();
  b = await freshTenant();
});
afterAll(closeDbs);

describe('scoring.tenant_defaults', () => {
  it('is registered under its name', () => {
    expect(scoringTenantDefaults.name).toBe('scoring.tenant_defaults');
  });

  it('creates the default profile and the 02:00 UTC ageing schedule once, however often it runs', async () => {
    await runOutbox(a.tenantId);
    const [p] = await profiles(a);
    expect(p).toMatchObject({
      tenantId: a.tenantId,
      fitWeight: 0.55,
      intentWeight: 0.45,
      halfLifeDays: 45,
      maxSignalAgeDays: 365,
      warmIntroCap: 20,
      trustModifierMax: 5,
      trustNeutral: 0.6,
      researchFloorDays: 180,
      version: 1,
    });
    expect(p!.fitParts).toEqual({ industry: 30, size: 25, revenue: 20, region: 10, buyer: 15 });
    expect(p!.tierThresholds).toEqual({
      notFitBelow: 40,
      actNow: { fit: 60, intent: 35, total: 60 },
      goodFit: { fit: 60 },
    });
    const s = await ageing(a.tenantId);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ cron: '0 2 * * *', timezone: 'UTC' });

    await a.run((ctx) => seedScoringDefaults(ctx));
    expect(await profiles(a)).toHaveLength(1);
    expect(await ageing(a.tenantId)).toHaveLength(1);
  });

  it('keeps tenants apart', async () => {
    expect(await profiles(b)).toHaveLength(0);
    await runOutbox(b.tenantId);
    expect(await profiles(b)).toHaveLength(1);
    const seen = await a.run((ctx) => ctx.tx.select().from(scoringProfile).where(eq(scoringProfile.tenantId, b.tenantId)));
    expect(seen).toEqual([]);
  });
});

describe('scoring.rescore.accounts job', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `acc_${i}`);
  it('takes 1 to 200 account ids', () => {
    expect(rescoreAccountsJob.data.safeParse({ accountIds: ids(200), cause: 'manual_rescore' }).success).toBe(true);
    expect(rescoreAccountsJob.data.safeParse({ accountIds: ids(1), cause: 'manual_rescore' }).success).toBe(true);
  });
  it('refuses 201 ids and none', () => {
    expect(rescoreAccountsJob.data.safeParse({ accountIds: ids(201), cause: 'manual_rescore' }).success).toBe(false);
    expect(rescoreAccountsJob.data.safeParse({ accountIds: [], cause: 'manual_rescore' }).success).toBe(false);
  });
});
