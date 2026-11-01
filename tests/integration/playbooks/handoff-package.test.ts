import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { handoffPackageProvider, seedMockCrm, setCrmSettings, syncOwners } from '@/modules/crm';
import { handoff, mockNote, mockTask } from '@/modules/crm/db/schema';
import { approveOffer, createOffer, createPractice } from '@/modules/offers';
import { editSection, handoffPackage, playbooksHandoffPackage } from '@/modules/playbooks';
import { brief, briefSection } from '@/modules/playbooks/db/schema';
import { assign } from '@/modules/routing';
import { adminDb, closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { completeOffer } from '../offers/helpers';
import { member } from '../routing/helpers';
import { asPerson, routingTenant, scoredAccount, sectionRows, type Tenant } from './helpers';

let t: Tenant;
let seller: string;
let practiceId: string;

beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
  await t.run((ctx) => seedMockCrm(ctx));
  await t.run((ctx) => syncOwners(ctx));
  const practice = await t.run((ctx) => createPractice(ctx, { name: 'Package Practice', slug: `pp-${newId('prc').slice(-8).toLowerCase()}` }));
  practiceId = practice.id;
  const o = await t.run((ctx) => createOffer(ctx, { name: 'Package Offer', practiceId, ...completeOffer }));
  await t.run((ctx) => approveOffer(ctx, o.id));
});
afterAll(closeDbs);

const people = [
  { firstName: 'Maria', lastName: 'Lopez', title: 'COO', email: `maria.${newId('acc').slice(-6).toLowerCase()}@pkg.example` },
];
const signals = [
  { kind: 'trigger' as const, type: 'leadership', title: 'Brief Co appoints first CIO', occurredAt: new Date('2026-10-01T00:00:00Z'), url: 'https://news.example/cio' },
  { kind: 'research' as const, type: 'intent', title: 'Researching: AI governance', occurredAt: new Date('2026-10-20T00:00:00Z') },
  { kind: 'trigger' as const, type: 'risk', title: 'Lawsuit: Rider data class action', occurredAt: new Date('2026-09-01T00:00:00Z') },
];

const account = () => scoredAccount(t, 'good_fit', { people, signals }, { practiceIds: [practiceId] });

const counts = async () => {
  const rows = (await adminDb.execute(sql`
    select (select count(*)::int from playbooks.brief where tenant_id = ${t.tenantId}) as briefs,
           (select count(*)::int from playbooks.brief_section where tenant_id = ${t.tenantId}) as sections,
           (select count(*)::int from playbooks.brief_section_history where tenant_id = ${t.tenantId}) as history,
           (select count(*)::int from ai.ai_run where tenant_id = ${t.tenantId}) as runs,
           (select count(*)::int from platform.outbox where tenant_id = ${t.tenantId}) as outbox`)) as unknown as Record<string, number>[];
  return rows[0];
};

describe('the handoff package in the CRM push (PLB-E3-S4)', () => {
  it('compose registers the playbooks provider (AC1)', () => {
    expect(handoffPackageProvider()).toBe(playbooksHandoffPackage);
  });

  it('a push writes the note from the brief, the opener as the first touch and the follow-ups on the tenant days', async () => {
    await t.run((ctx) => setCrmSettings(ctx, { followUpDays: [2, 9] }));
    const a = await account();
    const overview = (await sectionRows(a)).find((s) => s.key === 'overview')!;
    await asPerson(t, (ctx) => editSection(ctx, a, 'overview', { body: 'They run the second-largest fleet in the state.', ifVersion: overview.version }));
    await runOutbox(t.tenantId);
    await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
    await runOutbox(t.tenantId);

    const [h] = await t.run((ctx) => ctx.tx.select().from(handoff).where(eq(handoff.accountId, a)));
    expect(h!.status).toBe('completed');
    const [note] = await t.run((ctx) => ctx.tx.select().from(mockNote).where(eq(mockNote.companyExternalId, h!.companyExternalId!)));
    expect(note!.html.startsWith('<p><strong>Score</strong></p>')).toBe(true);
    expect(note!.html).toContain("Scout's recommendation");
    expect(note!.html).toContain('They run the second-largest fleet in the state.');
    expect(note!.html).toMatch(/<em>Edited by [^<]+<\/em>/);
    expect(note!.html).toContain('Open in Scout');
    expect(note!.html).toContain('Researching: AI governance');

    const tasks = await t.run((ctx) => ctx.tx.select().from(mockTask).where(eq(mockTask.companyExternalId, h!.companyExternalId!)).orderBy(mockTask.dueAt));
    expect(tasks.map((x) => x.subject)).toEqual([
      'First touch: Maria Lopez at Brief Co',
      'Follow-up 1 of 2 (day 2): New angle, email Maria Lopez',
      'Follow-up 2 of 2 (day 9): Close the loop, email Maria Lopez',
    ]);
    const stored = (await t.run((ctx) => ctx.tx.select().from(brief).where(eq(brief.accountId, a))))[0]!;
    expect(tasks[0]!.body).toContain(`Subject: ${stored.openerSubject}`);
    expect(tasks[0]!.body).toContain(stored.openerBody!);
    const buyerText = tasks.map((x) => `${x.subject}\n${x.body}`).join('\n');
    expect(buyerText).not.toMatch(/governance|lawsuit|class action|researching/i);
    await t.run((ctx) => setCrmSettings(ctx, { followUpDays: [3, 7, 14] }));
  });

  it('reads only: no ai_run row and no write', async () => {
    const a = await account();
    const before = await counts();
    const pkg = await t.run((ctx) => handoffPackage(ctx, a));
    expect(pkg!.sections.length).toBeGreaterThan(5);
    expect(await counts()).toEqual(before);
  });

  it('with no stored brief, it is a rules package', async () => {
    const a = await account();
    await adminDb.delete(briefSection).where(eq(briefSection.accountId, a));
    await adminDb.delete(brief).where(eq(brief.accountId, a));
    const pkg = (await t.run((ctx) => handoffPackage(ctx, a)))!;
    const labels = pkg.sections.flatMap((s) => [...s.html.matchAll(/<em>([^<]+)<\/em>/g)].map((m) => m[1]));
    expect(labels.length).toBeGreaterThan(5);
    expect(new Set(labels)).toEqual(new Set(['Assembled from rules']));
    expect(pkg.firstTouch!.body).toContain('Opener (Assembled from rules):');
  });

  it('is null for a missing account', async () => {
    expect(await t.run((ctx) => handoffPackage(ctx, 'acc_missing'))).toBeNull();
  });
});
