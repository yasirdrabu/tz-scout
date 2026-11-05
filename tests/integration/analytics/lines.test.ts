import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { addManualLine, analyticsUsageLines, editManualLine, listLines, voidLine } from '@/modules/analytics';
import { costLine } from '@/modules/analytics/db/schema';
import { usageRecorded } from '@/modules/integrations/contracts/events';
import { createTenant } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { adminDb } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import type { Envelope } from '@/platform/events/envelope';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { inTenant, seedUser, uniqueSlug } from '../tenancy/helpers';

let tenantId: string;
let run: <T>(fn: (ctx: ModuleContext) => Promise<T>) => Promise<T>;

beforeAll(async () => {
  const admin = await seedUser({ admin: true });
  const owner = await seedUser({ signedIn: true });
  // New York: 02:30 UTC on 1 November is still 31 October there.
  const t = await createTenant(admin.actor, { slug: uniqueSlug(), name: 'Ledger', currency: 'USD', timezone: 'America/New_York', ownerEmail: owner.email });
  tenantId = t.tenantId;
  run = (fn) => inTenant(tenantId, owner.actor, fn);
  await runOutbox(tenantId);
});

const usage = (over: Record<string, unknown> = {}) =>
  usageRecorded.data.parse({
    callId: newId('call'),
    provider: 'apollo',
    operation: 'apollo.people_search',
    module: 'enrichment',
    units: 3,
    unit: 'credits',
    costCents: 30,
    accountId: 'acc_1',
    correlationId: 'cor_1',
    occurredAt: '2026-11-01T02:30:00.000Z',
    ...over,
  });

const linesOf = (eventId: string) => adminDb.select().from(costLine).where(and(eq(costLine.tenantId, tenantId), eq(costLine.originEventId, eventId)));

describe('usage lines', () => {
  it('makes one usage line per event, with the category from the provider and the tenant-date occurred_on', async () => {
    const e = await run((ctx) => publish(ctx, usageRecorded, usage()));
    await runOutbox(tenantId);
    const rows = await linesOf(e.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: 'usage', category: 'data_vendors', provider: 'apollo', amountCents: 30, occurredOn: '2026-10-31', accountId: 'acc_1', voidedAt: null });
  });

  it('a redelivered event makes no second line', async () => {
    const e = await run((ctx) => publish(ctx, usageRecorded, usage({ provider: 'anthropic', costCents: 12 })));
    await runOutbox(tenantId);
    const [row] = await adminDb.select().from(outbox).where(eq(outbox.id, e.id));
    // Past the worker's processed-event guard: the handler itself runs twice more.
    const envelope = row!.payload as Envelope<never>;
    await run((ctx) => analyticsUsageLines.handle(envelope, ctx));
    await run((ctx) => analyticsUsageLines.handle(envelope, ctx));
    const rows = await linesOf(e.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.category).toBe('ai_usage');
  });

  it('a usage event from a provider with no category fails, so it is dead-lettered rather than lost', async () => {
    const e = await run((ctx) => publish(ctx, usageRecorded, usage({ provider: 'mystery' })));
    const [row] = await adminDb.select().from(outbox).where(eq(outbox.id, e.id));
    await adminDb.update(outbox).set({ sentAt: new Date() }).where(eq(outbox.id, e.id));
    await expect(run((ctx) => analyticsUsageLines.handle(row!.payload as Envelope<never>, ctx))).rejects.toThrow(/mystery/);
    expect(await linesOf(e.id)).toHaveLength(0);
  });
});

describe('manual lines', () => {
  it('add, then edit: the old line is voided "Edited" and a new one replaces it', async () => {
    const added = await run((ctx) => addManualLine(ctx, { occurredOn: '2026-11-03', category: 'partner_fees', amountCents: 50_000, note: 'Referral, Acme' }));
    expect(added).toMatchObject({ origin: 'manual', category: 'partner_fees', amountCents: 50_000, note: 'Referral, Acme', voidedAt: null, replacesId: null });
    const edited = await run((ctx) => editManualLine(ctx, added.id, { amountCents: 45_000 }));
    expect(edited).toMatchObject({ origin: 'manual', category: 'partner_fees', amountCents: 45_000, note: 'Referral, Acme', occurredOn: '2026-11-03', replacesId: added.id });
    expect(edited.id).not.toBe(added.id);
    const [old] = await adminDb.select().from(costLine).where(eq(costLine.id, added.id));
    expect(old).toMatchObject({ voidReason: 'Edited', amountCents: 50_000 });
    expect(old!.voidedAt).not.toBeNull();
    // A voided line can't be edited again.
    await expect(run((ctx) => editManualLine(ctx, added.id, { amountCents: 1 }))).rejects.toMatchObject({ status: 409 });
  });

  it('an edit that changes nothing returns the line as it is, without voiding it', async () => {
    const added = await run((ctx) => addManualLine(ctx, { occurredOn: '2026-11-03', category: 'partner_fees', amountCents: 700, note: 'Same' }));
    const same = await run((ctx) => editManualLine(ctx, added.id, {}));
    expect(same).toEqual(added);
    const again = await run((ctx) => editManualLine(ctx, added.id, { amountCents: 700, note: 'Same', occurredOn: '2026-11-03', category: 'partner_fees' }));
    expect(again).toEqual(added);
    const [row] = await adminDb.select().from(costLine).where(eq(costLine.id, added.id));
    expect(row!.voidedAt).toBeNull();
  });

  it('editing a usage line is refused', async () => {
    const e = await run((ctx) => publish(ctx, usageRecorded, usage()));
    await runOutbox(tenantId);
    const [line] = await linesOf(e.id);
    await expect(run((ctx) => editManualLine(ctx, line!.id, { amountCents: 1 }))).rejects.toMatchObject({ status: 409, message: 'Only costs added by hand can be edited.' });
  });

  it('voiding needs a reason, and a voided line is hidden unless include_voided', async () => {
    const line = await run((ctx) => addManualLine(ctx, { occurredOn: '2026-11-04', category: 'lists_events', amountCents: 9_900, note: null }));
    await expect(run((ctx) => voidLine(ctx, line.id, '  '))).rejects.toMatchObject({ status: 400 });
    const voided = await run((ctx) => voidLine(ctx, line.id, 'Booked twice'));
    expect(voided).toMatchObject({ voidReason: 'Booked twice' });
    const shown = await run((ctx) => listLines(ctx, { category: 'lists_events' }));
    expect(shown.data.map((l) => l.id)).not.toContain(line.id);
    const all = await run((ctx) => listLines(ctx, { category: 'lists_events', includeVoided: true }));
    expect(all.data.map((l) => l.id)).toContain(line.id);
  });

  it('an amount of 0 is refused', async () => {
    await expect(run((ctx) => addManualLine(ctx, { occurredOn: '2026-11-04', category: 'lists_events', amountCents: 0, note: null }))).rejects.toMatchObject({
      status: 400,
      message: 'Enter an amount above zero.',
    });
  });
});
