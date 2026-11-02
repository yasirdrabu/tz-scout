import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { DEFAULT_PROFILE, getProfile, requestRescore, resetProfile, updateProfile } from '@/modules/scoring';
import { adminDb, closeDbs } from '@/platform/db/client';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant } from '../offers/helpers';

afterAll(closeDbs);

async function tenant() {
  const t = await freshTenant();
  await runOutbox(t.tenantId);
  return t;
}

const rows = async (t: { tenantId: string }, query: ReturnType<typeof sql>) => (await adminDb.execute(query)) as unknown as Record<string, unknown>[];

describe('scoring profile service', () => {
  it('saves a change: version + 1, scoring.rules.changed published, audit with before and after', async () => {
    const t = await tenant();
    const saved = await t.run((ctx) => updateProfile(ctx, { halfLifeDays: 30, weights: { fit: 45, intent: 20 } }));
    expect(saved).toMatchObject({ halfLifeDays: 30, weights: { fit: 45, intent: 20, revenue: 15, trust: 20 }, version: 2 });
    expect(await t.run((ctx) => getProfile(ctx))).toMatchObject({ halfLifeDays: 30, version: 2 });
    const events = await rows(t, sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = 'scoring.rules.changed'`);
    expect(events).toHaveLength(1);
    expect((events[0] as { payload: { data: unknown } }).payload.data).toMatchObject({ profileVersion: 2, changed: ['weights', 'halfLifeDays'] });
    const audits = await rows(t, sql`select before, after from platform.audit_log where tenant_id = ${t.tenantId} and action = 'scoring.profile.updated'`);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ before: { halfLifeDays: 45, weights: DEFAULT_PROFILE.weights }, after: { halfLifeDays: 30, weights: { fit: 45, intent: 20, revenue: 15, trust: 20 } } });
  });

  it('a patch that changes nothing writes nothing', async () => {
    const t = await tenant();
    const same = await t.run((ctx) => updateProfile(ctx, { halfLifeDays: DEFAULT_PROFILE.halfLifeDays }));
    expect(same.version).toBe(1);
    expect(await rows(t, sql`select 1 from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = 'scoring.rules.changed'`)).toHaveLength(0);
  });

  it('merges nested fit parts, weights and cutoffs', async () => {
    const t = await tenant();
    const saved = await t.run((ctx) => updateProfile(ctx, { fitParts: { industry: 40, size: 15 }, tierCutoffs: { actNow: 80 }, weights: { fit: 35, trust: 25 } }));
    expect(saved.fitParts).toEqual({ industry: 40, size: 15, revenue: 20, region: 10, buyer: 15 });
    expect(saved.tierCutoffs).toEqual({ ...DEFAULT_PROFILE.tierCutoffs, actNow: 80 });
    expect(saved.weights).toEqual({ fit: 35, intent: 25, revenue: 15, trust: 25 });
  });

  it('rejects bad input with the copy to show, and changes nothing', async () => {
    const t = await tenant();
    const messages = async (patch: Parameters<typeof updateProfile>[1]) => {
      const e = await t.run((ctx) => updateProfile(ctx, patch)).then(
        () => null,
        (err: { status: number; errors: { message: string }[] }) => err,
      );
      expect(e?.status).toBe(400);
      return e!.errors.map((x) => x.message);
    };
    expect(await messages({ fitParts: { industry: 50 } })).toEqual(['The fit parts must add up to 100.']);
    expect(await messages({ weights: { fit: 35 } })).toEqual(['Weights add up to 95. Make them add up to 100.']);
    expect(await messages({ weights: { fit: 65, trust: 15 } })).toEqual(['Each weight is 0 to 60, in steps of 5.']);
    expect(await messages({ weights: { fit: 42, trust: 18 } })).toEqual(['Each weight is 0 to 60, in steps of 5.']);
    expect(await messages({ tierCutoffs: { goodFit: 80 } })).toEqual(['Act now has to start higher than Good fit.']);
    expect(await messages({ tierCutoffs: { watch: 55 } })).toEqual(['Good fit has to start higher than Watch.']);
    expect(await messages({ tierCutoffs: { actNow: 101 } })).toEqual(["Act now can't start higher than 100."]);
    expect(await messages({ tierCutoffs: { watch: 0 } })).toEqual(['Watch has to start at 1 or more.']);
    expect(await messages({ halfLifeDays: 0 })).toEqual(['Half-life must be between 1 and 365 days.']);
    expect(await messages({ warmIntroCap: 21 })).toEqual(['The warm intro cap must be between 0 and 20.']);
    expect((await t.run((ctx) => getProfile(ctx))).version).toBe(1);
  });

  it('accepts weights of 0 and 60 and cutoffs of 100, 99 and 1', async () => {
    const t = await tenant();
    const saved = await t.run((ctx) =>
      updateProfile(ctx, { weights: { fit: 60, intent: 0, revenue: 0, trust: 40 }, tierCutoffs: { actNow: 100, goodFit: 99, watch: 1 } }),
    );
    expect(saved).toMatchObject({ weights: { fit: 60, intent: 0, revenue: 0, trust: 40 }, tierCutoffs: { actNow: 100, goodFit: 99, watch: 1 } });
  });

  it('resets to the defaults with a new version', async () => {
    const t = await tenant();
    await t.run((ctx) => updateProfile(ctx, { halfLifeDays: 30 }));
    const reset = await t.run((ctx) => resetProfile(ctx));
    expect(reset).toMatchObject({ ...DEFAULT_PROFILE, version: 3 });
  });

  it('a tenant with no profile row saves its first change as version 1', async () => {
    const t = await tenant();
    await t.run((ctx) => ctx.tx.execute(sql`delete from scoring.scoring_profile where tenant_id = ${ctx.tenantId}`));
    const saved = await t.run((ctx) => updateProfile(ctx, { halfLifeDays: 30 }));
    expect(saved).toMatchObject({ halfLifeDays: 30, version: 1 });
  });

  it('requestRescore returns the job id of the queued page job', async () => {
    const t = await tenant();
    const id = await t.run((ctx) => requestRescore(ctx, { sourceId: 'src_one' }));
    const jobs = await rows(t, sql`select payload from platform.outbox where id = ${id}`);
    expect((jobs[0] as { payload: { type: string; data: unknown } }).payload).toMatchObject({
      type: 'jobs.scoring.rescore.page',
      data: { filter: { sourceId: 'src_one' }, cause: 'manual_rescore' },
    });
  });
});
