import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { upsertFromArrival } from '@/modules/accounts';
import { EMPTY_SECTION, NO_SUCH_SECTION, SECTION_CHANGED, SECTION_TOO_LONG, editSection, getBrief, requestDraft } from '@/modules/playbooks';
import { runOutbox } from '../helpers/run-outbox';
import { createApiKey, SYSTEM_GRANTOR } from '@/modules/tenancy';
import { adminDb } from '@/platform/db/client';
import { inTenant } from '../tenancy/helpers';
import { arrival, asPerson, briefRow, domain, historyRows, routingTenant, scoredAccount, sectionRows } from './helpers';

describe('editSection', () => {
  it('saves a new version with the editor, keeps the old one in history, and publishes the update (PLB-E3-S2-AC1)', async () => {
    const t = await routingTenant();
    const id = await scoredAccount(t, 'watch');
    const v1 = (await sectionRows(id)).find((s) => s.key === 'risks')!;
    const saved = await asPerson(t, (ctx) => editSection(ctx, id, 'risks', { body: '  Their budget resets in July.  ', ifVersion: 1 }));
    expect(saved).toMatchObject({ key: 'risks', title: 'Risks', body: 'Their budget resets in July.', writtenBy: 'person', version: 2 });
    expect(saved.label).toBe(`Edited by ${saved.editedByName}`);
    expect(saved.editedAt).toBeInstanceOf(Date);
    expect((await historyRows(id)).map((h) => [h.key, h.version, h.body])).toEqual([['risks', 1, v1.body]]);
    const events = (await adminDb.execute(
      sql`select payload->'data' as data from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = 'playbooks.brief.updated' and payload->'data'->>'origin' = 'human'`,
    )) as unknown as { data: unknown }[];
    expect(events.map((e) => e.data)).toEqual([{ accountId: id, sectionKeys: ['risks'], origin: 'human', mode: null }]);
  });

  it('refuses an empty body, more than 4,000 characters, a stale version and an unknown key', async () => {
    const t = await routingTenant();
    const id = await scoredAccount(t, 'watch');
    const edit = (key: string, body: string, ifVersion?: number) => asPerson(t, (ctx) => editSection(ctx, id, key, { body, ifVersion }));
    await expect(edit('overview', '   ')).rejects.toMatchObject({ status: 400, message: EMPTY_SECTION });
    expect(EMPTY_SECTION).toBe('Write the section first, then save it.');
    await expect(edit('overview', 'x'.repeat(4001))).rejects.toMatchObject({ status: 400, message: SECTION_TOO_LONG });
    expect(SECTION_TOO_LONG).toBe('Keep it under 4,000 characters.');
    await edit('overview', 'x'.repeat(4000), 1);
    await expect(edit('overview', 'Later text', 1)).rejects.toMatchObject({ status: 409, message: SECTION_CHANGED });
    expect(SECTION_CHANGED).toBe('Someone changed this section since you opened it. Reload to see their version.');
    await expect(edit('why_now', 'Not a page section')).rejects.toMatchObject({ status: 404, message: NO_SUCH_SECTION });
  });

  it('a save on a version only a draft has moved past is accepted; a person changing it since is a 409', async () => {
    const t = await routingTenant();
    const id = await scoredAccount(t, 'watch');
    await t.run((ctx) => requestDraft(ctx, id, { manual: true }));
    await runOutbox(t.tenantId);
    expect((await sectionRows(id)).find((s) => s.key === 'approach')).toMatchObject({ version: 2, origin: 'ai' });
    const saved = await asPerson(t, (ctx) => editSection(ctx, id, 'approach', { body: 'Opened at version 1.', ifVersion: 1 }));
    expect(saved).toMatchObject({ version: 3, body: 'Opened at version 1.' });
    await t.run((ctx) => requestDraft(ctx, id, { manual: true, includeEdited: ['approach'] }));
    await runOutbox(t.tenantId);
    // Version 3 (a person's) sits between 2 and the current 4.
    await expect(asPerson(t, (ctx) => editSection(ctx, id, 'approach', { body: 'Stale', ifVersion: 2 }))).rejects.toMatchObject({ status: 409 });
  });

  it('an API key editor shows the key name (PLB-E3-S2-AC2)', async () => {
    const t = await routingTenant();
    const id = await scoredAccount(t, 'watch');
    const key = await t.run((ctx) => createApiKey(ctx, { name: 'Research agent key', environment: 'live', scopes: ['playbooks:write'] }, SYSTEM_GRANTOR));
    const saved = await inTenant(t.tenantId, { kind: 'agent', id: key.id }, (ctx) =>
      editSection({ ...ctx, access: { dataLimit: { kind: 'all' } } }, id, 'approach', { body: 'Start with the depot manager.' }),
    );
    expect(saved).toMatchObject({ label: 'Edited by Research agent key', editedByName: 'Research agent key' });
    expect((await sectionRows(id)).find((s) => s.key === 'approach')!.editedBy).toBe(`key:${key.id}`);
  });

  it('creates the brief row for an account never drafted', async () => {
    const t = await routingTenant();
    const { accountId } = await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: 'Never drafted', domain: domain() } })));
    await asPerson(t, (ctx) => editSection(ctx, accountId, 'overview', { body: 'Known from the conference.' }));
    expect(await briefRow(accountId)).toMatchObject({ draftState: 'not_drafted' });
    const b = (await t.run((ctx) => getBrief(ctx, accountId)))!;
    expect(b.state).toBe('not_drafted');
    expect(b.sections[0]).toMatchObject({ body: 'Known from the conference.', writtenBy: 'person', version: 1 });
    expect(b.sections[1]).toMatchObject({ body: null, label: null, version: null });
  });

  it('a hidden or missing account is a 404', async () => {
    const t = await routingTenant();
    const id = await scoredAccount(t, 'watch');
    await expect(
      asPerson(t, (ctx) => editSection(ctx, id, 'overview', { body: 'Hi' }), { dataLimit: { kind: 'own_accounts' } }),
    ).rejects.toMatchObject({ status: 404 });
    const other = await routingTenant();
    await expect(asPerson(other, (ctx) => editSection(ctx, id, 'overview', { body: 'Hi' }))).rejects.toMatchObject({ status: 404 });
  });
});
