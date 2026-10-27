import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { upsertFromArrival } from '@/modules/accounts';
import { submitArrival, submitBatch } from '@/modules/intake';
import { arrival, batch } from '@/modules/intake/db/schema';
import { adminDb } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { asSource, freshTenant, personAndAgent, validArrival, type Tenant } from './helpers';

let t: Tenant;
let personId: string;
let agentId: string;

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId); // registers apollo, vibe and hubspot_qualified
  ({ personId, agentId } = await personAndAgent(t));
});

const rowOf = async (id: string) =>
  (await t.run((ctx) => ctx.tx.select().from(arrival).where(eq(arrival.id, id))))[0]!;
const asAgent = <T>(fn: Parameters<typeof asSource<T>>[2]) => asSource(t, agentId, fn);

async function outboxFor(arrivalId: string) {
  return adminDb
    .select({ payload: outbox.payload })
    .from(outbox)
    .where(and(eq(outbox.tenantId, t.tenantId), sql`${outbox.payload}::text like ${'%' + arrivalId + '%'}`));
}

describe('submitArrival (SRC-E2-S1)', () => {
  it('stores the arrival with intake.arrival.received and a resolve job in one transaction (AC1)', async () => {
    const out = await asAgent((ctx) => submitArrival(ctx, validArrival({ external_ref: 'r-ac1' }), { channel: 'api' }));
    expect(out).toEqual({ arrivalId: expect.stringMatching(/^arr_/), status: 'received', duplicateOfRequest: false });
    const row = await rowOf(out.arrivalId);
    expect(row).toMatchObject({ status: 'received', channel: 'api', externalRef: 'r-ac1', closestSourceId: agentId });
    const types = (await outboxFor(out.arrivalId)).map((r) => (r.payload as { type: string }).type).sort();
    expect(types).toEqual(['intake.arrival.received', 'jobs.intake.resolve']);
  });

  it('keeps payload.raw exactly as sent (AC2)', async () => {
    const body = {
      account: { name: 'Miami-Dade County DTPW', website: 'https://www.miamidade.gov/global/transportation/home.page' },
      people: [{ name: 'Jarice Rodriguez', title: 'Chief of Paratransit Operations & Mobility Services' }],
      signals: [{ type: 'trigger', title: 'Re-solicitation approved', occurred_at: '2026-06-02', confidence: 0.9 }],
      facts: { contract_value_cents: 2_090_000_000 },
    };
    const out = await asAgent((ctx) => submitArrival(ctx, body, { channel: 'api' }));
    const row = await rowOf(out.arrivalId);
    expect(row.payload).toEqual({ raw: body, contractVersion: 1 });
    expect(row.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the first arrival for the same external_ref from the same source (AC3)', async () => {
    const first = await asAgent((ctx) => submitArrival(ctx, validArrival({ external_ref: 'r-ac3' }), { channel: 'api' }));
    const again = await asAgent((ctx) => submitArrival(ctx, validArrival({ external_ref: 'r-ac3' }), { channel: 'api' }));
    expect(again).toEqual({ arrivalId: first.arrivalId, status: 'received', duplicateOfRequest: true });
    // Another source may use the same ref.
    const other = await asSource(t, personId, (ctx) =>
      submitArrival(ctx, validArrival({ external_ref: 'r-ac3' }), { channel: 'api' }),
    );
    expect(other.arrivalId).not.toBe(first.arrivalId);
  });

  it('keeps one row for two concurrent arrivals with the same ref (AC3)', async () => {
    const slow = () =>
      asAgent(async (ctx) => {
        const r = await submitArrival(ctx, validArrival({ external_ref: 'r-race' }), { channel: 'api' });
        await new Promise((resolve) => setTimeout(resolve, 300));
        return r;
      });
    const [a, b] = await Promise.all([slow(), slow()]);
    expect(a.arrivalId).toBe(b.arrivalId);
    expect([a.duplicateOfRequest, b.duplicateOfRequest].sort()).toEqual([false, true]);
    const rows = await t.run((ctx) => ctx.tx.select().from(arrival).where(eq(arrival.externalRef, 'r-race')));
    expect(rows).toHaveLength(1);
  });

  it('takes the source chain from the key, never from the body (AC5)', async () => {
    const out = await asAgent((ctx) => submitArrival(ctx, { ...validArrival(), via_vendor: 'Apollo' }, { channel: 'api' }));
    const row = await rowOf(out.arrivalId);
    const [apollo] = await t.run((ctx) =>
      ctx.tx.execute(sql`select id from intake.source where settings->>'key' = 'apollo'`),
    );
    expect(row).toMatchObject({
      agentSourceId: agentId,
      personSourceId: personId,
      vendorSourceId: (apollo as { id: string }).id,
      closestSourceId: agentId,
    });

    const unknown = await asAgent((ctx) => submitArrival(ctx, { ...validArrival(), via_vendor: 'nobody' }, { channel: 'api' }));
    expect((await rowOf(unknown.arrivalId)).vendorSourceId).toBeNull();

    await expect(
      asAgent((ctx) => submitArrival(ctx, { ...validArrival(), person_source_id: personId }, { channel: 'api' })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses an invalid body with every failing path and stores nothing', async () => {
    const err = await asAgent((ctx) =>
      submitArrival(ctx, { account: { domain: 'not a domain' } }, { channel: 'api' }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, slug: 'validation' });
    expect((err as { errors: { path: string }[] }).errors.map((e) => e.path).sort()).toEqual(['account.domain', 'account.name']);
  });

  it('refuses an arrival over 256 KB', async () => {
    const big = validArrival({ notes: 'x'.repeat(256 * 1024) });
    await expect(asAgent((ctx) => submitArrival(ctx, big, { channel: 'api' }))).rejects.toMatchObject({
      status: 400,
      slug: 'validation',
      message: 'An arrival can be up to 256 KB.',
    });
  });

  it('gives 404 for a target account the principal cannot see, and stores one it can', async () => {
    const hidden = await t.run((ctx) =>
      upsertFromArrival(ctx, {
        arrivalId: newId('arr'),
        receivedAt: new Date(),
        sourceChain: { personSourceId: 'src_someone_else' },
        account: { name: 'Hidden Co', domain: `hidden-${Date.now()}.com` },
        people: [],
        signals: [],
        facts: [],
        research: {},
        soleProprietor: false,
        externalIds: [],
      }),
    );
    for (const id of [hidden.accountId, 'acc_missing']) {
      await expect(
        asAgent((ctx) => submitArrival(ctx, { target_account_id: id, people: [{ name: 'Al' }] }, { channel: 'api' })),
      ).rejects.toMatchObject({ status: 404, slug: 'not-found' });
    }
    // A principal that sees every account can target it.
    const out = await t.run((ctx) =>
      submitArrival(
        { ...ctx, access: { sourceId: agentId, dataLimit: { kind: 'all' } } },
        { target_account_id: hidden.accountId, people: [{ name: 'Al' }] },
        { channel: 'enrichment' },
      ),
    );
    expect((await rowOf(out.arrivalId)).targetAccountId).toBe(hidden.accountId);
  });

  it('does not enqueue a resolve job for an inline arrival', async () => {
    const target = await t.run((ctx) =>
      upsertFromArrival(ctx, {
        arrivalId: newId('arr'),
        receivedAt: new Date(),
        sourceChain: { agentSourceId: agentId },
        account: { name: 'Inline Co', domain: `inline-${Date.now()}.com` },
        people: [],
        signals: [],
        facts: [],
        research: {},
        soleProprietor: false,
        externalIds: [],
      }),
    );
    const out = await asAgent((ctx) =>
      submitArrival(ctx, { target_account_id: target.accountId, people: [{ name: 'Bo' }] }, { channel: 'api', inline: true }),
    );
    const types = (await outboxFor(out.arrivalId)).map((r) => (r.payload as { type: string }).type);
    expect(types).toEqual(['intake.arrival.received']);
  });
});

describe('submitBatch (Review Focus 5, submission side)', () => {
  it('stores every item in order, rejecting invalid items and a repeated ref', async () => {
    const items = [
      validArrival({ external_ref: 'b-1' }),
      { account: { name: 'No identity', external_ref: 'b-2' } },
      { ...validArrival(), external_ref: 'b-3' }, // item-level ref, moved into account
      { account: { domain: 'acme.com' }, unknown_field: true },
      validArrival({ external_ref: 'b-3' }),
    ];
    const out = await asAgent((ctx) =>
      submitBatch(ctx, { name: 'Mixed run', notes: 'n', metadata: { reported_cost: { credits: 3 } }, items }, { channel: 'api' }),
    );
    expect(out.batchId).toMatch(/^bat_/);
    expect(out.items.map((i) => [i.externalRef, i.status])).toEqual([
      ['b-1', 'received'],
      ['b-2', 'rejected'],
      ['b-3', 'received'],
      [null, 'rejected'],
      ['b-3', 'rejected'],
    ]);
    const rows = await Promise.all(out.items.map((i) => rowOf(i.arrivalId)));
    expect(rows.every((r) => r.batchId === out.batchId)).toBe(true);
    expect(rows.map((r) => r.rejectReason)).toEqual([null, 'invalid', null, 'invalid', 'duplicate_in_batch']);
    expect(rows[1]!.rejectDetail).toContain('account.domain');
    expect(rows[3]!.rejectDetail).toContain('unknown_field');
    expect(rows.map((r) => r.externalRef)).toEqual(['b-1', null, 'b-3', null, null]);
    expect((rows[4]!.payload as { raw: unknown }).raw).toEqual(items[4]);

    const [b] = await t.run((ctx) => ctx.tx.select().from(batch).where(eq(batch.id, out.batchId)));
    expect(b).toMatchObject({ name: 'Mixed run', itemCount: 5, agentSourceId: agentId, personSourceId: personId, status: 'processing' });
    const events = await adminDb
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(and(eq(outbox.tenantId, t.tenantId), sql`${outbox.payload}->>'type' = 'intake.batch.created'`));
    expect(events.some((e) => (e.payload as { data: { batchId: string } }).data.batchId === out.batchId)).toBe(true);
  });

  it('rejects a repeated normalised domain duplicate_in_batch', async () => {
    const d = `dup-${Date.now()}.com`;
    const out = await asAgent((ctx) =>
      submitBatch(
        ctx,
        { name: 'Dups', items: [{ account: { name: 'A', domain: d } }, { account: { name: 'B', website: `https://www.${d}/x` } }] },
        { channel: 'api' },
      ),
    );
    expect(out.items.map((i) => i.status)).toEqual(['received', 'rejected']);
    expect((await rowOf(out.items[1]!.arrivalId)).rejectReason).toBe('duplicate_in_batch');
  });

  it('stores an item over 256 KB rejected invalid', async () => {
    const out = await asAgent((ctx) =>
      submitBatch(ctx, { name: 'Big', items: [validArrival({ notes: 'x'.repeat(256 * 1024) }), validArrival()] }, { channel: 'api' }),
    );
    expect(out.items.map((i) => i.status)).toEqual(['rejected', 'received']);
    expect(await rowOf(out.items[0]!.arrivalId)).toMatchObject({ rejectReason: 'invalid', rejectDetail: 'An arrival can be up to 256 KB.' });
  });

  it('refuses a bad envelope with 400 and stores nothing', async () => {
    const before = await t.run(async (ctx) => (await ctx.tx.select().from(batch)).length);
    for (const body of [{ items: [validArrival()] }, { name: 'Empty', items: [] }]) {
      await expect(asAgent((ctx) => submitBatch(ctx, body, { channel: 'api' }))).rejects.toMatchObject({ status: 400 });
    }
    expect(await t.run(async (ctx) => (await ctx.tx.select().from(batch)).length)).toBe(before);
  });
});
