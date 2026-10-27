import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as listPracticesRoute, POST as createPracticeRoute } from '@/app/v1/practices/route';
import { PATCH as patchPractice, POST as practiceAction } from '@/app/v1/practices/[id]/route';
import { GET as listOffersRoute, POST as createOfferRoute } from '@/app/v1/offers/route';
import { GET as getOfferRoute, PATCH as patchOffer, POST as offerAction } from '@/app/v1/offers/[id]/route';
import { PUT as putOfferCases } from '@/app/v1/offers/[id]/case-studies/route';
import { GET as listCasesRoute, POST as createCaseRoute } from '@/app/v1/case-studies/route';
import { POST as caseAction } from '@/app/v1/case-studies/[id]/route';
import { approveOffer, createCaseStudy, createOffer, createPractice } from '@/modules/offers';
import { SYSTEM_GRANTOR, createApiKey, setPrincipalCacheTtl } from '@/modules/tenancy';
import { completeOffer, freshTenant } from '../offers/helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;
let practiceId: string;
let readKey: string;
let manageKey: string;

const key = (scopes: string[]) =>
  t
    .run((ctx) => createApiKey(ctx, { name: 'k', environment: 'live', scopes: scopes as never }, SYSTEM_GRANTOR))
    .then((k) => k.secret);

beforeAll(async () => {
  t = await freshTenant();
  practiceId = (await t.run((ctx) => createPractice(ctx, { name: 'Main' }))).id;
  readKey = await key(['offers:read']);
  manageKey = await key(['offers:read', 'offers:manage']);
});
beforeEach(() => setPrincipalCacheTtl(0));

const call = (
  h: (r: Request) => Promise<Response>,
  secret: string,
  path: string,
  method = 'GET',
  body?: unknown,
  extra: Record<string, string> = {},
) =>
  h(
    new Request(`http://x/v1/${path}`, {
      method,
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const draft = (name: string, extra: Record<string, unknown> = {}) =>
  t.run((ctx) => createOffer(ctx, { name, practiceId, ...completeOffer, ...extra }));
const approved = async (name: string) => {
  const o = await draft(name);
  await t.run((ctx) => approveOffer(ctx, o.id));
  return o;
};
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe('offers on /v1', () => {
  it('a read-only key sees approved offers only, in snake_case', async () => {
    const a = await approved('Visible');
    const d = await draft('Hidden');
    const res = await call(listOffersRoute, readKey, 'offers?status=draft');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(ids(data)).toContain(a.id);
    expect(ids(data)).not.toContain(d.id);
    expect(data.every((o: { status: string }) => o.status === 'approved')).toBe(true);
    expect(data.find((o: { id: string }) => o.id === a.id)).toMatchObject({
      practice_id: practiceId,
      typical_deal_cents: 5_000_000,
      target_titles: ['CTO'],
    });
    expect((await call(getOfferRoute, readKey, `offers/${d.id}`)).status).toBe(404);
    expect((await call(getOfferRoute, readKey, `offers/${a.id}`)).status).toBe(200);
  });

  it('a manage key sees drafts and can filter by status', async () => {
    const d = await draft('Managed draft');
    const { data } = await (await call(listOffersRoute, manageKey, 'offers?status=draft')).json();
    expect(ids(data)).toContain(d.id);
    expect((await call(listOffersRoute, manageKey, 'offers?status=nope')).status).toBe(400);
  });

  it('creates an offer and refuses fields that are not editable', async () => {
    const res = await call(createOfferRoute, manageKey, 'offers', 'POST', {
      name: 'Created',
      practice_id: practiceId,
      promise: 'A promise.',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: 'Created', status: 'draft' });
    for (const field of ['status', 'approved_by', 'approved_at', 'tenant_id', 'id', 'origin']) {
      const bad = await call(createOfferRoute, manageKey, 'offers', 'POST', {
        name: 'Bad',
        practice_id: practiceId,
        promise: 'x',
        [field]: 'approved',
      });
      expect(bad.status, field).toBe(400);
    }
    expect((await call(createOfferRoute, readKey, 'offers', 'POST', {})).status).toBe(403);
  });

  it('approving with an API key returns 403 with the owner copy', async () => {
    const o = await draft('Needs owner');
    const res = await call(offerAction, manageKey, `offers/${o.id}:approve`, 'POST');
    expect(res.status).toBe(403);
    expect((await res.json()).title).toBe('Only an owner can approve an offer.');
  });

  it('archives an offer and 404s an unknown action', async () => {
    const o = await draft('To archive');
    const res = await call(offerAction, manageKey, `offers/${o.id}:archive`, 'POST');
    expect(await res.json()).toMatchObject({ status: 'archived' });
    expect((await call(offerAction, manageKey, `offers/${o.id}:explode`, 'POST')).status).toBe(404);
    expect((await call(offerAction, manageKey, `offers/${o.id}`, 'POST')).status).toBe(404);
  });

  it('PATCH on an approved offer buyer definition returns a warning and goes back to draft', async () => {
    const o = await approved('Warned');
    const res = await call(patchOffer, manageKey, `offers/${o.id}`, 'PATCH', { industries: ['retail'] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warning).toBe('This sends the offer back to draft until an owner approves it.');
    expect(body).toMatchObject({ status: 'draft', industries: ['retail'] });
    const quiet = await call(patchOffer, manageKey, `offers/${o.id}`, 'PATCH', { name: 'Renamed' });
    expect((await quiet.json()).warning).toBeUndefined();
    expect((await call(patchOffer, manageKey, `offers/${o.id}`, 'PATCH', { status: 'approved' })).status).toBe(400);
  });

  it('PUT case-studies replaces the linked set and the offer shows it', async () => {
    const o = await draft('With cases');
    const [a, b] = await t.run(async (ctx) => [
      await createCaseStudy(ctx, { title: 'A' }),
      await createCaseStudy(ctx, { title: 'B', public: true }),
    ]);
    const path = `offers/${o.id}/case-studies`;
    const first = await call(putOfferCases, manageKey, path, 'PUT', { case_study_ids: [a!.id, b!.id] });
    expect((await first.json()).data).toHaveLength(2);
    const second = await call(putOfferCases, manageKey, path, 'PUT', { case_study_ids: [b!.id] });
    expect(ids((await second.json()).data)).toEqual([b!.id]);
    const shown = await (await call(getOfferRoute, manageKey, `offers/${o.id}`)).json();
    expect(ids(shown.case_studies)).toEqual([b!.id]);
    expect((await call(putOfferCases, manageKey, path, 'PUT', { case_study_ids: ['cs_nope'] })).status).toBe(404);
  });
});

describe('case studies on /v1', () => {
  it('an agent list leaves out non-public case studies', async () => {
    const pub = await t.run((ctx) => createCaseStudy(ctx, { title: 'Public one', public: true }));
    const priv = await t.run((ctx) => createCaseStudy(ctx, { title: 'Private one' }));
    const agent = ids((await (await call(listCasesRoute, readKey, 'case-studies')).json()).data);
    expect(agent).toContain(pub.id);
    expect(agent).not.toContain(priv.id);
  });

  it('creates and archives a case study', async () => {
    const res = await call(createCaseRoute, manageKey, 'case-studies', 'POST', { title: 'New', client_name: 'Acme' });
    expect(res.status).toBe(201);
    const cs = await res.json();
    expect(cs).toMatchObject({ client_name: 'Acme', public: false });
    const arch = await call(caseAction, manageKey, `case-studies/${cs.id}:archive`, 'POST');
    expect((await arch.json()).archived_at).not.toBeNull();
    const bad = await call(createCaseRoute, manageKey, 'case-studies', 'POST', { title: 'x', archived_at: 'now' });
    expect(bad.status).toBe(400);
  });
});

describe('practices on /v1', () => {
  it('lists as { data, next_cursor } and pages by limit and cursor', async () => {
    for (const n of ['P1', 'P2', 'P3']) await t.run((ctx) => createPractice(ctx, { name: n }));
    const one = await (await call(listPracticesRoute, readKey, 'practices?limit=2')).json();
    expect(one.data).toHaveLength(2);
    expect(typeof one.next_cursor).toBe('string');
    const two = await (await call(listPracticesRoute, readKey, `practices?limit=2&cursor=${one.next_cursor}`)).json();
    expect(ids(two.data)).not.toContain(one.data[0].id);
    const all = await (await call(listPracticesRoute, readKey, 'practices')).json();
    expect(all.next_cursor).toBeNull();
    expect((await call(listPracticesRoute, readKey, 'practices?limit=0')).status).toBe(400);
    for (const [h, path] of [[listOffersRoute, 'offers'], [listCasesRoute, 'case-studies']] as const) {
      expect(await (await call(h, readKey, path)).json()).toMatchObject({ next_cursor: null });
    }
  });

  it('a POST without the idempotent flag replays on a repeated Idempotency-Key', async () => {
    const send = () =>
      call(createPracticeRoute, manageKey, 'practices', 'POST', { name: 'Once' }, { 'idempotency-key': 'k-once' });
    const first = await send();
    const second = await send();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect((await second.json()).id).toBe((await first.json()).id);
  });

  it('a malformed percent sequence in an id is a 404', async () => {
    expect((await call(patchPractice, manageKey, 'practices/%E0%A4%A', 'PATCH', {})).status).toBe(404);
  });

  it('lists, creates, edits and archives', async () => {
    const created = await call(createPracticeRoute, manageKey, 'practices', 'POST', { name: 'Second', keywords: ['two'] });
    expect(created.status).toBe(201);
    const p = await created.json();
    const patched = await call(patchPractice, manageKey, `practices/${p.id}`, 'PATCH', { description: 'Hello' });
    expect((await patched.json()).description).toBe('Hello');
    const list = await (await call(listPracticesRoute, readKey, 'practices')).json();
    expect(ids(list.data)).toContain(p.id);
    const arch = await call(practiceAction, manageKey, `practices/${p.id}:archive`, 'POST');
    expect((await arch.json()).status).toBe('archived');
    expect((await call(practiceAction, manageKey, `practices/${p.id}:nope`, 'POST')).status).toBe(404);
    expect((await call(createPracticeRoute, readKey, 'practices', 'POST', { name: 'x' })).status).toBe(403);
  });
});
