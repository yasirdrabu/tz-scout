import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { allowOverage, checkCap, listCaps, reserve, setCapLimit, settle } from '@/modules/integrations';
import { tenant } from '@/modules/tenancy/db/schema';
import { usagePeriod } from '@/modules/integrations/db/schema';
import { adminDb } from '@/platform/db/client';
import { withTenant } from '@/platform/db/tenant';
import { auditLog, outbox } from '@/platform/db/schema';
import { freshTenant } from './helpers';

type T = Awaited<ReturnType<typeof freshTenant>>;
const NOV = new Date('2026-11-15T12:00:00Z');
const DEC = new Date('2026-12-15T12:00:00Z');

const thresholds = async (tenantId: string, level: 'warn' | 'blocked') =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, tenantId))).filter((r) => {
    const p = r.payload as { type: string; data: { level: string } };
    return p.type === 'integrations.usage.threshold_reached' && p.data.level === level;
  });

const capOf = async (t: T, key: string, now = NOV) => (await t.run((ctx) => listCaps(ctx, now))).find((c) => c.providerKey === key)!;

async function withLimit(limit: number) {
  const t = await freshTenant();
  await t.run((ctx) => setCapLimit(ctx, 'apollo', limit));
  return t;
}

describe('listCaps', () => {
  it('lazily ensures the Ruling 2 defaults', async () => {
    const t = await freshTenant();
    const caps = await t.run((ctx) => listCaps(ctx, NOV));
    expect(caps.map((c) => [c.providerKey, c.limit, c.unit, c.period]).sort()).toEqual([
      ['anthropic', 20000, 'cost_cents', 'month'],
      ['apollo', 2000, 'credits', 'month'],
      ['hubspot', 50000, 'calls', 'day'],
      ['vibe', 1000, 'credits', 'month'],
    ]);
    const apollo = caps.find((c) => c.providerKey === 'apollo')!;
    expect(apollo).toMatchObject({ used: 0, reserved: 0, level: 'ok', overage: false, resetsAt: new Date('2026-12-01T00:00:00Z') });
  });
});

describe('reserve and settle', () => {
  it('a provider without a limit gets no reservation', async () => {
    const t = await freshTenant();
    expect(await t.run((ctx) => reserve(ctx, 'demo', 5, NOV))).toMatchObject({ reservationId: null, level: 'ok' });
    expect(await t.run((ctx) => checkCap(ctx, 'demo', 5, NOV))).toEqual({ status: 'ok', used: 0, limit: null, resetsAt: null });
  });

  it('on a fresh tenant, checkCap then reserve in one transaction does not deadlock', async () => {
    const t = await freshTenant();
    const r = await t.run(async (ctx) => {
      expect((await checkCap(ctx, 'apollo', 1, NOV)).limit).toBe(2000);
      expect((await listCaps(ctx, NOV)).length).toBe(4);
      return reserve(ctx, 'apollo', 1, NOV);
    });
    expect(r.reservationId).not.toBeNull();
  });

  it('a second settle of the same reservation is a no-op', async () => {
    const t = await withLimit(100);
    const r = await t.run((ctx) => reserve(ctx, 'apollo', 10, NOV));
    await t.run((ctx) => settle(ctx, r, 4));
    await t.run((ctx) => settle(ctx, r, 4));
    expect(await capOf(t, 'apollo')).toMatchObject({ used: 4, reserved: 0 });
  });

  it('rejects bad amounts and rounds fractional ones', async () => {
    const t = await withLimit(100);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(t.run((ctx) => reserve(ctx, 'apollo', bad, NOV))).rejects.toThrow();
    }
    const r = await t.run((ctx) => reserve(ctx, 'apollo', 2.1, NOV));
    expect(await capOf(t, 'apollo')).toMatchObject({ reserved: 3 });
    await expect(t.run((ctx) => settle(ctx, r, -1))).rejects.toThrow();
    await t.run((ctx) => settle(ctx, r, 2.4));
    expect(await capOf(t, 'apollo')).toMatchObject({ used: 2, reserved: 0 });
  });

  it('straight to blocked publishes warn first, then blocked', async () => {
    const t = await withLimit(10);
    await expect(t.run((ctx) => reserve(ctx, 'apollo', 11, NOV))).rejects.toMatchObject({ slug: 'blocked_by_cap' });
    await t.run(async (ctx) => settle(ctx, await reserve(ctx, 'apollo', 9, NOV), 9));
    const warns = await thresholds(t.tenantId, 'warn');
    const blocks = await thresholds(t.tenantId, 'blocked');
    expect(warns).toHaveLength(1);
    expect(blocks).toHaveLength(1);
    expect(warns[0]!.id < blocks[0]!.id).toBe(true);
  });

  it('reserve holds the amount; settle moves the actual amount to used', async () => {
    const t = await withLimit(100);
    const r = await t.run((ctx) => reserve(ctx, 'apollo', 10, NOV));
    expect(r.reservationId).not.toBeNull();
    expect(await capOf(t, 'apollo')).toMatchObject({ used: 0, reserved: 10 });
    await t.run((ctx) => settle(ctx, r, 7));
    expect(await capOf(t, 'apollo')).toMatchObject({ used: 7, reserved: 0, level: 'ok' });
    expect(await t.run((ctx) => checkCap(ctx, 'apollo', 94, NOV))).toEqual({
      status: 'blocked',
      used: 7,
      limit: 100,
      resetsAt: new Date('2026-12-01T00:00:00Z'),
    });
  });

  it('settle inside a caller transaction commits with it', async () => {
    const t = await withLimit(100);
    const r = await t.run((ctx) => reserve(ctx, 'apollo', 10, NOV));
    await expect(
      t.run(async (ctx) => {
        await settle(ctx, r, 10, ctx.tx);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    // The rolled-back settle leaves the reservation held (Ruling 6); a committed one moves it to used.
    expect(await capOf(t, 'apollo')).toMatchObject({ used: 0, reserved: 10 });
    const next = await t.run((ctx) => reserve(ctx, 'apollo', 5, NOV));
    await t.run((ctx) => settle(ctx, next, 5, ctx.tx));
    expect(await capOf(t, 'apollo')).toMatchObject({ used: 5, reserved: 10 });
  });

  it('two concurrent reservations that together pass the limit: one is refused (Review Focus 1)', async () => {
    const t = await withLimit(100);
    await t.run(async (ctx) => settle(ctx, await reserve(ctx, 'apollo', 0, NOV), 0)); // the period row exists
    // A third transaction holds the row while both start, so both read it at the same moment once it lets go.
    let both!: Promise<PromiseSettledResult<unknown>[]>;
    await withTenant(t.tenantId, async (tx) => {
      await tx.select().from(usagePeriod).where(eq(usagePeriod.tenantId, t.tenantId)).for('update');
      both = Promise.allSettled([
        t.run((ctx) => reserve(ctx, 'apollo', 60, NOV)),
        t.run((ctx) => reserve(ctx, 'apollo', 60, NOV)),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const results = await both;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({
      slug: 'blocked_by_cap',
      status: 429,
      message: 'Apollo reached its monthly limit.',
      detail: 'An owner can raise it in Settings, Integrations.',
      extensions: { resets_at: '2026-12-01T00:00:00.000Z' },
    });
    expect(Number(failed.reason.headers['retry-after'])).toBeGreaterThan(0);
    expect(await capOf(t, 'apollo')).toMatchObject({ reserved: 60 });
  });

  it('publishes warn once per period', async () => {
    const t = await withLimit(10);
    const a = await t.run((ctx) => reserve(ctx, 'apollo', 8, NOV));
    expect(a.level).toBe('warn');
    await t.run((ctx) => settle(ctx, a, 8));
    await t.run(async (ctx) => settle(ctx, await reserve(ctx, 'apollo', 1, NOV), 1));
    const warns = await thresholds(t.tenantId, 'warn');
    expect(warns).toHaveLength(1);
    expect((warns[0]!.payload as { data: unknown }).data).toEqual({
      providerKey: 'apollo',
      unit: 'credits',
      period: 'month',
      periodStart: '2026-11-01',
      level: 'warn',
      used: 0,
      limit: 10,
      resetsAt: '2026-12-01T00:00:00.000Z',
    });
    // A new period warns again.
    await t.run((ctx) => reserve(ctx, 'apollo', 9, DEC));
    expect(await thresholds(t.tenantId, 'warn')).toHaveLength(2);
  });

  it('publishes blocked once, when settled usage reaches the limit, and keeps refusing', async () => {
    const t = await withLimit(10);
    await t.run(async (ctx) => settle(ctx, await reserve(ctx, 'apollo', 10, NOV), 10));
    expect(await thresholds(t.tenantId, 'blocked')).toHaveLength(1);
    expect((await capOf(t, 'apollo')).level).toBe('blocked');
    await expect(t.run((ctx) => reserve(ctx, 'apollo', 1, NOV))).rejects.toMatchObject({ slug: 'blocked_by_cap' });
    await expect(t.run((ctx) => reserve(ctx, 'apollo', 1, NOV))).rejects.toMatchObject({ slug: 'blocked_by_cap' });
    expect(await thresholds(t.tenantId, 'blocked')).toHaveLength(1);
  });

  it('a refused reservation publishes blocked once', async () => {
    const t = await withLimit(10);
    await expect(t.run((ctx) => reserve(ctx, 'apollo', 11, NOV))).rejects.toMatchObject({ slug: 'blocked_by_cap' });
    await expect(t.run((ctx) => reserve(ctx, 'apollo', 11, NOV))).rejects.toMatchObject({ slug: 'blocked_by_cap' });
    expect(await thresholds(t.tenantId, 'blocked')).toHaveLength(1);
    expect(await capOf(t, 'apollo')).toMatchObject({ used: 0, reserved: 0 });
  });
});

describe('setCapLimit and allowOverage', () => {
  it('setCapLimit validates and is audited', async () => {
    const t = await freshTenant();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(t.run((ctx) => setCapLimit(ctx, 'apollo', bad))).rejects.toMatchObject({
        status: 400,
        message: 'Enter a whole number of 1 or more.',
        errors: [{ path: 'limit', message: 'Enter a whole number of 1 or more.' }],
      });
    }
    await expect(t.run((ctx) => setCapLimit(ctx, 'microsoft', 5))).rejects.toMatchObject({ status: 404 });
    await t.run((ctx) => setCapLimit(ctx, 'apollo', 3000));
    expect((await capOf(t, 'apollo')).limit).toBe(3000);
    const rows = await adminDb
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, t.tenantId), eq(auditLog.action, 'integrations.cap.set')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subjectType: 'usage_cap', subjectId: 'apollo', before: { limit: 2000 }, after: { limit: 3000 } });
  });

  it('a raised limit clears the flags it drops below, so the thresholds publish again', async () => {
    const t = await withLimit(10);
    await t.run(async (ctx) => settle(ctx, await reserve(ctx, 'apollo', 10, NOV), 10));
    expect(await thresholds(t.tenantId, 'blocked')).toHaveLength(1);
    expect(await thresholds(t.tenantId, 'warn')).toHaveLength(1);
    await t.run((ctx) => setCapLimit(ctx, 'apollo', 100, NOV));
    const a = await t.run((ctx) => reserve(ctx, 'apollo', 85, NOV));
    expect(a.level).toBe('warn');
    expect(await thresholds(t.tenantId, 'warn')).toHaveLength(2);
    await t.run((ctx) => settle(ctx, a, 85));
    await t.run(async (ctx) => settle(ctx, await reserve(ctx, 'apollo', 5, NOV), 5));
    expect(await thresholds(t.tenantId, 'blocked')).toHaveLength(2);
  });

  it('a limit raised only out of blocked keeps the warn flag', async () => {
    const t = await withLimit(10);
    await t.run(async (ctx) => settle(ctx, await reserve(ctx, 'apollo', 10, NOV), 10));
    await t.run((ctx) => setCapLimit(ctx, 'apollo', 12, NOV));
    const [row] = await adminDb.select().from(usagePeriod).where(eq(usagePeriod.tenantId, t.tenantId));
    expect(row).toMatchObject({ warned: true, blocked: false });
  });

  it('overage lets usage pass the limit until the period resets (Review Focus 5)', async () => {
    const t = await withLimit(10);
    await t.run(async (ctx) => settle(ctx, await reserve(ctx, 'apollo', 10, NOV), 10));
    await t.run((ctx) => allowOverage(ctx, 'apollo', NOV));
    expect(await capOf(t, 'apollo')).toMatchObject({ overage: true, level: 'warn' });
    const over = await t.run((ctx) => reserve(ctx, 'apollo', 5, NOV));
    expect(over.level).toBe('warn');
    await t.run((ctx) => settle(ctx, over, 5));
    const audits = await adminDb
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, t.tenantId), eq(auditLog.action, 'integrations.cap.overage')));
    expect(audits).toHaveLength(1);

    // December: a new period with nothing used, and the limit blocks again at 100%.
    expect(await capOf(t, 'apollo', DEC)).toMatchObject({ overage: false, used: 0, level: 'ok' });
    await t.run(async (ctx) => settle(ctx, await reserve(ctx, 'apollo', 10, DEC), 10));
    await expect(t.run((ctx) => reserve(ctx, 'apollo', 1, DEC))).rejects.toMatchObject({ slug: 'blocked_by_cap' });
  });
});

describe('tenant timezone (Review Focus 2)', () => {
  it('America/New_York at 2026-12-01 03:00 UTC is November; at 05:01 UTC a new period starts with zero used', async () => {
    const t = await withLimit(10);
    await adminDb.update(tenant).set({ timezone: 'America/New_York' }).where(eq(tenant.id, t.tenantId));
    const late = new Date('2026-12-01T03:00:00Z');
    const r = await t.run((ctx) => reserve(ctx, 'apollo', 10, late));
    await t.run((ctx) => settle(ctx, r, 10));
    expect(await capOf(t, 'apollo', late)).toMatchObject({ used: 10, level: 'blocked', resetsAt: new Date('2026-12-01T05:00:00Z') });
    const next = new Date('2026-12-01T05:01:00Z');
    expect(await capOf(t, 'apollo', next)).toMatchObject({ used: 0, level: 'ok' });
    expect((await t.run((ctx) => checkCap(ctx, 'apollo', 10, next))).status).toBe('warn');
  });
});
