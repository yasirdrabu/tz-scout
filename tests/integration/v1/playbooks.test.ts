import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as getBriefRoute } from '@/http/routes/v1/accounts/[id]/brief/route';
import { PUT as putSection } from '@/http/routes/v1/accounts/[id]/brief/sections/[key]/route';
import { POST as accountAction } from '@/http/routes/v1/accounts/[id]/route';
import { brief } from '@/modules/playbooks/db/schema';
import { createApiKey, setPrincipalCacheTtl, SYSTEM_GRANTOR } from '@/modules/tenancy';
import { adminDb, closeDbs } from '@/platform/db/client';
import { call, keyFor } from './intake-helpers';
import { workspace, type Workspace } from './review-helpers';

let w: Workspace;
let other: Workspace;
let leader: string;
let seller: string;
let operator: string;
let account: string;
let otherAccount: string;

beforeAll(async () => {
  w = await workspace('Brief Co');
  other = await workspace('Other Brief Co');
  leader = await w.person('leader', { name: 'Dana Ruiz' });
  seller = await w.person('seller', { name: 'Sam Seller', dataLimit: { kind: 'own_accounts' } });
  operator = await w.person('operator', { name: 'Olu Operator' });
  account = await w.sent({ name: 'Brief Route Co', industry: 'Logistics' });
  otherAccount = await other.sent({ name: 'Elsewhere Co' });
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

const json = async (res: Response | Promise<Response>) => (await res).json();
const draftJobs = async (accountId: string) =>
  (
    (await adminDb.execute(
      sql`select count(*)::int as n from platform.outbox where payload->>'type' = 'jobs.playbooks.brief.draft' and payload->'data'->>'accountId' = ${accountId}`,
    )) as unknown as { n: number }[]
  )[0]!.n;

describe('GET /accounts/{id}/brief', () => {
  it('returns the brief with labels and the four page sections in order', async () => {
    const res = await w.as(leader, getBriefRoute, `accounts/${account}/brief`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b).toMatchObject({ account_id: account, state: 'ready' });
    expect(Object.keys(b).sort()).toEqual(
      ['account_id', 'committee', 'last_drafted_at', 'offer_id', 'offer_name', 'opener', 'recommendation', 'sections', 'state', 'who_first', 'why_now'].sort(),
    );
    expect(b.recommendation).toMatchObject({ written_by: 'rules', label: 'Assembled from rules' });
    expect(b.recommendation.headline).toEqual(expect.any(String));
    expect(b.why_now).toMatchObject({ written_by: 'rules', citations: expect.any(Array) });
    expect(b.sections.map((s: { key: string; title: string }) => [s.key, s.title])).toEqual([
      ['overview', 'Overview'],
      ['approach', 'Approach'],
      ['value_angle', 'Value angle'],
      ['risks', 'Risks'],
    ]);
    expect(Object.keys(b.sections[0]).sort()).toEqual(
      ['body', 'citations', 'edited_at', 'edited_by_name', 'key', 'label', 'title', 'version', 'written_by', 'written_for_offer_name'].sort(),
    );
    expect(b.sections[0]).toMatchObject({ version: 1, written_by: 'rules', label: 'Assembled from rules', edited_by_name: null });
  });

  it('needs playbooks:read (403)', async () => {
    const key = await keyFor(w.tenant, ['accounts:read'], { dataLimit: { kind: 'all' } });
    expect((await call(getBriefRoute, key, `accounts/${account}/brief`)).status).toBe(403);
  });

  it('is a 404 for another tenant, a seller outside the data limit and a missing account', async () => {
    expect((await w.as(leader, getBriefRoute, `accounts/${otherAccount}/brief`)).status).toBe(404);
    expect((await w.as(seller, getBriefRoute, `accounts/${account}/brief`)).status).toBe(404);
    expect((await w.as(leader, getBriefRoute, 'accounts/acc_missing/brief')).status).toBe(404);
  });

  it('an action segment on the path is a 404', async () => {
    expect((await w.as(leader, getBriefRoute, `accounts/${account}:assign/brief`)).status).toBe(404);
  });
});

describe('PUT /accounts/{id}/brief/sections/{key}', () => {
  it('saves the section as the person, with the version guard', async () => {
    const res = await w.as(leader, putSection, `accounts/${account}/brief/sections/risks`, 'PUT', { body: 'Their budget resets in July.', if_version: 1 });
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(s).toMatchObject({ key: 'risks', title: 'Risks', body: 'Their budget resets in July.', written_by: 'person', label: 'Edited by Dana Ruiz', edited_by_name: 'Dana Ruiz', version: 2 });
    expect(s.edited_at).toEqual(expect.any(String));
    const stale = await w.as(leader, putSection, `accounts/${account}/brief/sections/risks`, 'PUT', { body: 'Later.', if_version: 1 });
    expect(stale.status).toBe(409);
    expect((await stale.json()).title).toBe('Someone changed this section since you opened it. Reload to see their version.');
    const b = await json(w.as(leader, getBriefRoute, `accounts/${account}/brief`));
    expect(b.sections[3]).toMatchObject({ key: 'risks', label: 'Edited by Dana Ruiz', version: 2 });
  });

  it('refuses a bad body (400) and an unknown key (404)', async () => {
    const put = (key: string, body: unknown) => w.as(leader, putSection, `accounts/${account}/brief/sections/${key}`, 'PUT', body);
    expect((await put('overview', {})).status).toBe(400);
    expect((await put('overview', { body: 'Hi', extra: true })).status).toBe(400);
    expect((await put('overview', { body: 'Hi', if_version: 'one' })).status).toBe(400);
    const empty = await put('overview', { body: '   ' });
    expect(empty.status).toBe(400);
    expect((await empty.json()).title).toBe('Write the section first, then save it.');
    const long = await put('overview', { body: 'x'.repeat(4001) });
    expect(long.status).toBe(400);
    expect((await long.json()).title).toBe('Keep it under 4,000 characters.');
    const unknown = await put('why_now', { body: 'Hi' });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).title).toBe("That brief section doesn't exist.");
    expect((await put('overview', { body: 'x'.repeat(17 * 1024) })).status).toBe(413);
  });

  it('needs playbooks:write: an operator is a 403', async () => {
    expect((await w.as(operator, putSection, `accounts/${account}/brief/sections/overview`, 'PUT', { body: 'Hi' })).status).toBe(403);
  });

  it('is a 404 for another tenant and a seller outside the data limit', async () => {
    expect((await w.as(leader, putSection, `accounts/${otherAccount}/brief/sections/overview`, 'PUT', { body: 'Hi' })).status).toBe(404);
    expect((await w.as(seller, putSection, `accounts/${account}/brief/sections/overview`, 'PUT', { body: 'Hi' })).status).toBe(404);
  });

  it('an API key with playbooks:write shows the key name (PLB-E3-S2-AC2)', async () => {
    const k = await w.run((ctx) =>
      createApiKey(ctx, { name: 'Research agent key', environment: 'live', scopes: ['playbooks:write'], dataLimit: { kind: 'all' } }, SYSTEM_GRANTOR),
    );
    const res = await call(putSection, k.secret, `accounts/${account}/brief/sections/approach`, { method: 'PUT', body: { body: 'Start with the depot manager.' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ label: 'Edited by Research agent key', edited_by_name: 'Research agent key', written_by: 'person' });
  });
});

describe('POST /accounts/{id}:draft-brief', () => {
  it('queues a manual draft (202) and runs it', async () => {
    const res = await w.as(leader, accountAction, `accounts/${account}:draft-brief`, 'POST');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ state: 'drafting' });
    expect((await json(w.as(leader, getBriefRoute, `accounts/${account}/brief`))).state).toBe('drafting');
    await w.deliver();
    expect((await json(w.as(leader, getBriefRoute, `accounts/${account}/brief`))).state).toBe('ready');
  });

  it('include_edited lets the draft rewrite an edited section', async () => {
    await w.as(leader, putSection, `accounts/${account}/brief/sections/value_angle`, 'PUT', { body: 'My own angle.' });
    const res = await w.as(leader, accountAction, `accounts/${account}:draft-brief`, 'POST', { include_edited: ['value_angle'] });
    expect(res.status).toBe(202);
    await w.deliver();
    const b = await json(w.as(leader, getBriefRoute, `accounts/${account}/brief`));
    expect(b.sections[2]).toMatchObject({ key: 'value_angle', written_by: expect.not.stringMatching(/^person$/) });
    expect(b.sections[2].body).not.toBe('My own angle.');
  });

  it('refuses a bad body (400)', async () => {
    const post = (body: unknown) => w.as(leader, accountAction, `accounts/${account}:draft-brief`, 'POST', body);
    expect((await post({ include_edited: ['why_now'] })).status).toBe(400);
    expect((await post({ include_edited: 'overview' })).status).toBe(400);
    expect((await post({ other: 1 })).status).toBe(400);
  });

  it('needs playbooks:write: an operator is a 403', async () => {
    expect((await w.as(operator, accountAction, `accounts/${account}:draft-brief`, 'POST')).status).toBe(403);
  });

  it('is a 404 for another tenant and a seller outside the data limit', async () => {
    expect((await w.as(leader, accountAction, `accounts/${otherAccount}:draft-brief`, 'POST')).status).toBe(404);
    expect((await w.as(seller, accountAction, `accounts/${account}:draft-brief`, 'POST')).status).toBe(404);
    const [row] = await adminDb.select().from(brief).where(and(eq(brief.tenantId, other.tenantId), eq(brief.accountId, otherAccount)));
    expect(row!.draftState).toBe('ready');
  });

  it('twice with one Idempotency-Key queues once', async () => {
    await w.deliver();
    const key = await keyFor(w.tenant, ['playbooks:write'], { dataLimit: { kind: 'all' } });
    const before = await draftJobs(account);
    const send = () => call(accountAction, key, `accounts/${account}:draft-brief`, { method: 'POST', body: {}, headers: { 'idempotency-key': 'draft-once' } });
    expect((await send()).status).toBe(202);
    const again = await send();
    expect(again.status).toBe(202);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(await draftJobs(account)).toBe(before + 1);
  });
});
