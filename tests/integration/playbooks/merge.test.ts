import { describe, expect, it } from 'vitest';
import { mergeAccounts, upsertFromArrival } from '@/modules/accounts';
import { and, eq, isNull } from 'drizzle-orm';
import { briefDraftHandler, editSection, getBrief, requestDraft } from '@/modules/playbooks';
import { adminDb } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { EnvelopeSchema, type Envelope } from '@/platform/events/envelope';
import { deliverOnce } from '@/platform/runtime/worker';
import { runOutbox } from '../helpers/run-outbox';
import { arrival, asPerson, briefRow, domain, draftJobs, historyRows, routingTenant, scoredAccount, sectionRows } from './helpers';

describe('brief on merge', () => {
  it('moves the merged brief to a survivor that has none, then redrafts it', async () => {
    const t = await routingTenant();
    const merged = await scoredAccount(t, 'watch');
    await asPerson(t, (ctx) => editSection(ctx, merged, 'overview', { body: 'Notes from the expo.' }));
    const { accountId: survivor } = await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: 'Survivor Co', domain: domain() } })));
    await asPerson(t, (ctx) => mergeAccounts(ctx, survivor, merged));
    await runOutbox(t.tenantId);

    expect(await briefRow(merged)).toBeUndefined();
    expect(await sectionRows(merged)).toEqual([]);
    expect(await historyRows(merged)).toEqual([]);
    expect(await briefRow(survivor)).toMatchObject({ draftState: expect.any(String) });
    expect((await sectionRows(survivor)).find((s) => s.key === 'overview')).toMatchObject({ body: 'Notes from the expo.', origin: 'human' });
    // The moved history comes along; the redraft then archives the sections it rewrote, never the person's.
    expect((await historyRows(survivor)).filter((h) => h.key === 'overview').map((h) => h.version)).toEqual([1]);
    expect(await draftJobs(t.tenantId, survivor)).toBeGreaterThanOrEqual(1);
    expect((await t.run((ctx) => getBrief(ctx, survivor)))!.sections[0]!.body).toBe('Notes from the expo.');
  });

  it('a merge while the merged brief is drafting still drafts the survivor', async () => {
    const t = await routingTenant();
    const merged = await scoredAccount(t, 'watch');
    await t.run((ctx) => requestDraft(ctx, merged, { manual: true }));
    expect(await briefRow(merged)).toMatchObject({ draftState: 'drafting' });
    const { accountId: survivor } = await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: 'Survivor Co', domain: domain() } })));
    // The old draft is still running elsewhere: hold its job until after the merge consumer ran.
    const held = (await adminDb.select().from(outbox).where(and(eq(outbox.tenantId, t.tenantId), isNull(outbox.sentAt)))).filter(
      (r) => (r.payload as { type: string }).type === 'jobs.playbooks.brief.draft',
    );
    expect(held).toHaveLength(1);
    await adminDb.update(outbox).set({ sentAt: new Date() }).where(eq(outbox.seq, held[0]!.seq));
    await asPerson(t, (ctx) => mergeAccounts(ctx, survivor, merged));
    await runOutbox(t.tenantId);
    await deliverOnce(briefDraftHandler, EnvelopeSchema.parse(held[0]!.payload) as Envelope);
    await runOutbox(t.tenantId);
    expect(await draftJobs(t.tenantId, survivor)).toBeGreaterThanOrEqual(1);
    const row = (await briefRow(survivor))!;
    expect(row).toMatchObject({ draftState: 'ready' });
    expect(row.draftedSeq).toBe(row.requestedSeq);
    expect((await sectionRows(survivor)).find((s) => s.key === 'overview')!.body).toContain('Survivor Co');
  });

  it('a survivor with its own brief keeps it and takes the merged sections into its history', async () => {
    const t = await routingTenant();
    const survivor = await scoredAccount(t, 'watch');
    const merged = await scoredAccount(t, 'watch');
    const own = (await sectionRows(survivor)).find((s) => s.key === 'risks')!;
    const theirs = (await sectionRows(merged)).find((s) => s.key === 'risks')!;
    await asPerson(t, (ctx) => mergeAccounts(ctx, survivor, merged));
    await runOutbox(t.tenantId);

    expect(await briefRow(merged)).toBeUndefined();
    expect(await sectionRows(merged)).toEqual([]);
    const risks = (await sectionRows(survivor)).find((s) => s.key === 'risks')!;
    expect(risks.version).toBeGreaterThan(own.version + 1);
    const history = (await historyRows(survivor)).filter((h) => h.key === 'risks');
    expect(history.map((h) => h.body)).toContain(theirs.body);
    expect(new Set(history.map((h) => h.version)).size).toBe(history.length);
  });
});
