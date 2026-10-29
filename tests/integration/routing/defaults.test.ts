import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { registerReviewStatusValidator, registerSource, updateSource } from '@/modules/intake';
import { autoAcceptJob, routingReviewStatusValidator, routingTenantDefaults, seedRoutingDefaults } from '@/modules/routing';
import { declineReasonDef, reviewStatusDef, routingSetting } from '@/modules/routing/db/schema';
import { adminDb, closeDbs } from '@/platform/db/client';
import { schedule } from '@/platform/db/schema';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant } from '../offers/helpers';

let a: Awaited<ReturnType<typeof freshTenant>>;
let b: Awaited<ReturnType<typeof freshTenant>>;

const statuses = (t: typeof a) => t.run((ctx) => ctx.tx.select().from(reviewStatusDef).orderBy(reviewStatusDef.order));
const reasons = (t: typeof a) => t.run((ctx) => ctx.tx.select().from(declineReasonDef));
const settings = (t: typeof a) => t.run((ctx) => ctx.tx.select().from(routingSetting));
const hourly = (tenantId: string) =>
  adminDb.select().from(schedule).where(sql`${schedule.tenantId} = ${tenantId} and ${schedule.jobName} = 'routing.assignments.auto_accept'`);

beforeAll(async () => {
  a = await freshTenant();
  b = await freshTenant();
});
afterEach(() => registerReviewStatusValidator(routingReviewStatusValidator));
afterAll(closeDbs);

describe('routing.tenant_defaults', () => {
  it('is registered under its name', () => {
    expect(routingTenantDefaults.name).toBe('routing.tenant_defaults');
    expect(autoAcceptJob.name).toBe('routing.assignments.auto_accept');
  });

  it('seeds statuses, both reason lists, the setting and the hourly schedule once, however often it runs', async () => {
    await runOutbox(a.tenantId);
    expect((await statuses(a)).map((s) => [s.key, s.label, s.countsAsReviewed, s.isDeclined])).toEqual([
      ['unvetted', 'Unvetted', false, false],
      ['needs_review', 'Needs review', false, false],
      ['reviewed', 'Reviewed', true, false],
      ['declined', 'Declined', true, true],
    ]);
    const rs = await reasons(a);
    const labels = (applies: string[]) => rs.filter((r) => applies.includes(r.appliesTo)).map((r) => r.label).sort();
    expect(labels(['review', 'both'])).toEqual(
      ['Already a customer', 'Bad data', 'Duplicate', 'Not a fit', 'Open deal elsewhere', 'Other', 'Wrong timing'].sort(),
    );
    expect(labels(['assignment', 'both'])).toEqual(
      ['Already talking to them', 'Not a fit', 'Not my territory', 'Other', 'Too much on my plate'].sort(),
    );
    expect(await settings(a)).toMatchObject([{ tenantId: a.tenantId, autoAcceptWorkingDays: 2 }]);
    const s = await hourly(a.tenantId);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ cron: '0 * * * *' });

    await a.run((ctx) => seedRoutingDefaults(ctx));
    expect(await statuses(a)).toHaveLength(4);
    expect(await reasons(a)).toHaveLength(10);
    expect(await settings(a)).toHaveLength(1);
    expect(await hourly(a.tenantId)).toHaveLength(1);
  });

  it('keeps a changed setting when run again', async () => {
    await a.run((ctx) => ctx.tx.update(routingSetting).set({ autoAcceptWorkingDays: null }).where(eq(routingSetting.tenantId, a.tenantId)));
    await a.run((ctx) => seedRoutingDefaults(ctx));
    expect(await settings(a)).toMatchObject([{ autoAcceptWorkingDays: null }]);
  });

  it('refuses a setting outside 1 to 10', async () => {
    await expect(
      a.run((ctx) => ctx.tx.transaction((sp) => sp.update(routingSetting).set({ autoAcceptWorkingDays: 11 }).where(eq(routingSetting.tenantId, a.tenantId)))),
    ).rejects.toThrow();
  });

  it('keeps tenants apart', async () => {
    await runOutbox(b.tenantId);
    const before = await statuses(b);
    expect(before).toHaveLength(4);
    const seen = await b.run((ctx) => ctx.tx.select().from(reviewStatusDef).where(eq(reviewStatusDef.tenantId, a.tenantId)));
    expect(seen).toEqual([]);
    expect(before.every((s) => s.tenantId === b.tenantId)).toBe(true);
  });
});

describe('intake review status check', () => {
  const nope = 'Pick a review status from your list.';

  it('refuses an unknown starting status once routing is registered', async () => {
    await runOutbox(a.tenantId);
    await expect(a.run((ctx) => registerSource(ctx, { kind: 'vendor', name: 'V1', initialReviewStatusKey: 'nope' }))).rejects.toMatchObject({ message: nope });
    const ok = await a.run((ctx) => registerSource(ctx, { kind: 'vendor', name: 'V2', initialReviewStatusKey: 'needs_review' }));
    await expect(a.run((ctx) => updateSource(ctx, ok.id, { initialReviewStatusKey: 'nope' }))).rejects.toMatchObject({ message: nope });
    const changed = await a.run((ctx) => updateSource(ctx, ok.id, { initialReviewStatusKey: 'unvetted' }));
    expect(changed.initialReviewStatusKey).toBe('unvetted');
  });

  it('refuses an archived status', async () => {
    await runOutbox(a.tenantId);
    await a.run((ctx) => ctx.tx.update(reviewStatusDef).set({ archivedAt: new Date() }).where(eq(reviewStatusDef.key, 'needs_review')));
    await expect(a.run((ctx) => registerSource(ctx, { kind: 'vendor', name: 'V3', initialReviewStatusKey: 'needs_review' }))).rejects.toMatchObject({
      message: nope,
    });
    await a.run((ctx) => ctx.tx.update(reviewStatusDef).set({ archivedAt: null }).where(eq(reviewStatusDef.key, 'needs_review')));
  });

  it('accepts any key with none registered', async () => {
    registerReviewStatusValidator(null);
    const s = await a.run((ctx) => registerSource(ctx, { kind: 'vendor', name: 'V4', initialReviewStatusKey: 'nope' }));
    expect(s.initialReviewStatusKey).toBe('nope');
  });
});
