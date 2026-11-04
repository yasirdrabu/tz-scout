import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as listPracticesRoute, POST as createPracticeRoute } from '@/http/routes/v1/practices/route';
import { GET as getPracticeRoute, PATCH as patchPractice, POST as practiceAction } from '@/http/routes/v1/practices/[id]/route';
import { GET as listOffersRoute, POST as createOfferRoute } from '@/http/routes/v1/offers/route';
import { DELETE as deleteOfferRoute, GET as getOfferRoute, PATCH as patchOffer, POST as offerAction } from '@/http/routes/v1/offers/[id]/route';
import { PUT as putOfferCases } from '@/http/routes/v1/offers/[id]/case-studies/route';
import { GET as listCasesRoute, POST as createCaseRoute } from '@/http/routes/v1/case-studies/route';
import { POST as caseAction } from '@/http/routes/v1/case-studies/[id]/route';
import { approveOffer, createCaseStudy, createOffer, createPractice } from '@/modules/offers';
import { SYSTEM_GRANTOR, createApiKey, setPrincipalCacheTtl } from '@/modules/tenancy';
import { offerMatch } from '@/modules/scoring/db/schema';
import { adminDb } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { completeOffer, freshTenant } from '../offers/helpers';
import { workspace, type Workspace } from './review-helpers';

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
    new Request(`http://x/api/v1/${path}`, {
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

describe('offers on /api/v1', () => {
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

  it('approving with an API key returns 403: only a person can approve', async () => {
    const o = await draft('Needs a person');
    const res = await call(offerAction, manageKey, `offers/${o.id}:approve`, 'POST');
    expect(res.status).toBe(403);
    expect((await res.json()).detail).toBe('Only a person can approve an offer.');
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
    expect(body.warning).toBe('This sends the offer back to draft until someone who manages offers approves it.');
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

describe('case studies on /api/v1', () => {
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

describe('practices on /api/v1', () => {
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

describe('R1 offer and practice routes (Rulings 12 to 14)', () => {
  let w: Workspace;
  let other: Workspace;
  let practice: string;
  let operator: string;
  let leader: string;
  let seller: string;
  const ready = {
    promise: 'Ship it.',
    target_titles: ['CTO'],
    industries: ['logistics'],
    typical_deal_cents: 5_000_000,
    sales_cycle_days: 60,
  };

  beforeAll(async () => {
    w = await workspace('Offer Routes Co');
    other = await workspace('Other Offers Co');
    operator = await w.person('operator', { name: 'Olive Operator' });
    leader = await w.person('leader');
    seller = await w.person('seller');
    const res = await w.as(w.owner, createPracticeRoute, 'practices', 'POST', { name: 'Routes', lead_user_id: operator });
    expect(res.status).toBe(201);
    practice = (await res.json()).id;
  });

  const create = async (name: string, extra: Record<string, unknown> = {}) => {
    const res = await w.as(w.owner, createOfferRoute, 'offers', 'POST', { name, practice_id: practice, ...ready, ...extra });
    expect(res.status).toBe(201);
    return res.json();
  };
  const theirs = async () =>
    other.run(async (ctx) => {
      const p = await createPractice(ctx, { name: `Theirs ${newId('om')}` });
      return { practiceId: p.id, offerId: (await createOffer(ctx, { name: `Their offer ${newId('om')}`, practiceId: p.id, promise: 'x' })).id };
    });

  it('create, patch and read carry the content fields and the labels', async () => {
    const o = await create('Content offer', {
      price_model: 'fixed',
      price_min_cents: 4_000_000,
      price_max_cents: 4_000_000,
      length_weeks: 6,
      key_offer: 'Key',
      why_us: 'Us',
      why_now: 'Now',
    });
    expect(o).toMatchObject({ price_model: 'fixed', length_weeks: 6, key_offer: 'Key', why_us: 'Us', why_now: 'Now', price_label: 'Fixed fee · $40,000 · 6 weeks', status_label: 'Draft' });
    const read = await (await w.as(w.owner, getOfferRoute, `offers/${o.id}`)).json();
    expect(read).toMatchObject({ price_label: 'Fixed fee · $40,000 · 6 weeks', status_label: 'Draft', practice_lead_name: 'Olive Operator', can_delete: true });
    const patched = await (await w.as(w.owner, patchOffer, `offers/${o.id}`, 'PATCH', { price_model: 'custom', why_us: 'Better' })).json();
    expect(patched).toMatchObject({ price_label: 'Custom quote · 6 weeks', why_us: 'Better' });
    const list = await (await w.as(w.owner, listOffersRoute, `offers?practice_id=${practice}`)).json();
    expect(list.data.find((x: { id: string }) => x.id === o.id)).toMatchObject({ price_label: 'Custom quote · 6 weeks', status_label: 'Draft' });
  });

  it('validates the new fields at their paths', async () => {
    const bad = async (body: Record<string, unknown>, path: string) => {
      const res = await w.as(w.owner, createOfferRoute, 'offers', 'POST', { name: 'Bad', practice_id: practice, promise: 'x', ...body });
      expect(res.status, path).toBe(400);
      expect((await res.json()).errors.map((e: { path: string }) => e.path), path).toContain(path);
    };
    await bad({ length_weeks: 0 }, 'length_weeks');
    await bad({ length_weeks: 261 }, 'length_weeks');
    await bad({ price_model: 'hourly' }, 'price_model');
    await bad({ why_us: 'x'.repeat(4001) }, 'why_us');
  });

  it('keeps required and optional buying roles, and refuses unknown keys and overlaps', async () => {
    const make = (body: Record<string, unknown>) => w.as(w.owner, createOfferRoute, 'offers', 'POST', { name: 'Roles', practice_id: practice, promise: 'x', ...body });
    const messages = async (res: Response) => (await res.json()).errors.map((e: { message: string }) => e.message);

    const unknown = await make({ target_buying_roles: ['wizard'] });
    expect(unknown.status).toBe(400);
    expect(await messages(unknown)).toContain('Unknown buying role: wizard');
    const overlap = await make({ target_buying_roles: ['procurement'], optional_buying_roles: ['procurement'] });
    expect(overlap.status).toBe(400);
    expect(await messages(overlap)).toContain("A role can't be both required and optional: Procurement");

    const made = await make({ target_buying_roles: ['technical_buyer'], optional_buying_roles: ['procurement'] });
    expect(made.status).toBe(201);
    const o = await made.json();
    expect(o).toMatchObject({ target_buying_roles: ['technical_buyer'], optional_buying_roles: ['procurement'] });

    const patch = (body: Record<string, unknown>) => w.as(w.owner, patchOffer, `offers/${o.id}`, 'PATCH', body);
    // Checked against the stored lists: procurement is already optional.
    const merged = await patch({ target_buying_roles: ['procurement'] });
    expect(merged.status).toBe(400);
    expect(await messages(merged)).toContain("A role can't be both required and optional: Procurement");
    expect((await patch({ optional_buying_roles: ['wizard'] })).status).toBe(400);
    const swapped = await patch({ target_buying_roles: ['procurement'], optional_buying_roles: ['technical_buyer'] });
    expect(swapped.status).toBe(200);
    expect(await swapped.json()).toMatchObject({ target_buying_roles: ['procurement'], optional_buying_roles: ['technical_buyer'] });
  });

  it('a content edit keeps an active offer active; a buyer edit sends it back with the warning', async () => {
    const o = await create('Edit me');
    expect((await w.as(operator, offerAction, `offers/${o.id}:approve`, 'POST')).status).toBe(200);
    const content = await (await w.as(w.owner, patchOffer, `offers/${o.id}`, 'PATCH', { why_us: 'Because.' })).json();
    expect(content).toMatchObject({ status: 'approved', status_label: 'Active' });
    expect(content.warning).toBeUndefined();
    const buyer = await (await w.as(w.owner, patchOffer, `offers/${o.id}`, 'PATCH', { industries: ['retail'] })).json();
    expect(buyer).toMatchObject({ status: 'draft' });
    expect(buyer.warning).toEqual(expect.any(String));
  });

  it(':approve needs offers:manage and a person, and lists what is missing', async () => {
    const o = await create('Approve me');
    expect((await w.as(leader, offerAction, `offers/${o.id}:approve`, 'POST')).status).toBe(403);
    const ok = await w.as(operator, offerAction, `offers/${o.id}:approve`, 'POST');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 'approved', status_label: 'Active' });
    const thin = await (await w.as(w.owner, createOfferRoute, 'offers', 'POST', { name: 'Thin', practice_id: practice, promise: 'x' })).json();
    const incomplete = await w.as(operator, offerAction, `offers/${thin.id}:approve`, 'POST');
    expect(incomplete.status).toBe(400);
    const body = await incomplete.json();
    expect(body.type).toContain('offer-incomplete');
    expect(body.errors.length).toBeGreaterThan(0);
    const { offerId } = await theirs();
    expect((await w.as(operator, offerAction, `offers/${offerId}:approve`, 'POST')).status).toBe(404);
  });

  it(':unapprove returns the draft; refuses people without offers:manage; 404 across tenants; 409 retired', async () => {
    const o = await create('Unapprove me');
    await w.as(operator, offerAction, `offers/${o.id}:approve`, 'POST');
    expect((await w.as(seller, offerAction, `offers/${o.id}:unapprove`, 'POST')).status).toBe(403);
    const res = await w.as(operator, offerAction, `offers/${o.id}:unapprove`, 'POST');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: o.id, status: 'draft', status_label: 'Draft', approved_by: null });
    const { offerId } = await theirs();
    expect((await w.as(operator, offerAction, `offers/${offerId}:unapprove`, 'POST')).status).toBe(404);
    await w.as(operator, offerAction, `offers/${o.id}:archive`, 'POST');
    expect((await w.as(operator, offerAction, `offers/${o.id}:unapprove`, 'POST')).status).toBe(409);
  });

  it('DELETE answers 204 for a never-matched offer, 409 with history, 403 and 404 otherwise', async () => {
    const o = await create('Delete me');
    expect((await w.as(seller, deleteOfferRoute, `offers/${o.id}`, 'DELETE')).status).toBe(403);
    const res = await w.as(operator, deleteOfferRoute, `offers/${o.id}`, 'DELETE');
    expect(res.status).toBe(204);
    expect((await w.as(w.owner, getOfferRoute, `offers/${o.id}`)).status).toBe(404);
    expect((await w.as(operator, deleteOfferRoute, `offers/${o.id}`, 'DELETE')).status).toBe(404);

    const kept = await create('Has history');
    await adminDb.insert(offerMatch).values({ id: newId('om'), tenantId: w.tenantId, accountId: 'acc_x', offerId: kept.id, fit: 1, intent: 1, matchTotal: 1, tier: 'watch', fitParts: {}, ruleHits: [], profileVersion: 1 });
    const conflict = await w.as(operator, deleteOfferRoute, `offers/${kept.id}`, 'DELETE');
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ title: 'Has history has matched accounts, so it can only be retired.' });
    expect((await (await w.as(w.owner, getOfferRoute, `offers/${kept.id}`)).json()).can_delete).toBe(false);

    const { offerId } = await theirs();
    expect((await w.as(operator, deleteOfferRoute, `offers/${offerId}`, 'DELETE')).status).toBe(404);
  });

  it('practices carry lead_name and offer_count; GET one; the lead must be a member', async () => {
    await create('Counted');
    const one = await w.as(seller, getPracticeRoute, `practices/${practice}`);
    expect(one.status).toBe(200);
    const p = await one.json();
    expect(p).toMatchObject({ id: practice, lead_user_id: operator, lead_name: 'Olive Operator' });
    expect(p.offer_count).toBeGreaterThan(0);
    const list = await (await w.as(seller, listPracticesRoute, 'practices')).json();
    expect(list.data.find((x: { id: string }) => x.id === practice)).toMatchObject({ lead_name: 'Olive Operator', offer_count: p.offer_count });

    const bad = await w.as(w.owner, patchPractice, `practices/${practice}`, 'PATCH', { lead_user_id: 'usr_nobody' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).errors).toEqual([{ path: 'lead_user_id', message: 'That person is not a member of this workspace.' }]);
    const cleared = await w.as(w.owner, patchPractice, `practices/${practice}`, 'PATCH', { lead_user_id: null });
    expect(await cleared.json()).toMatchObject({ lead_user_id: null, lead_name: null });
    expect((await w.as(seller, patchPractice, `practices/${practice}`, 'PATCH', { lead_user_id: null })).status).toBe(403);

    const { practiceId } = await theirs();
    expect((await w.as(seller, getPracticeRoute, `practices/${practiceId}`)).status).toBe(404);
  });

  it('offer_count counts only the offers the caller is shown', async () => {
    const p = (await (await w.as(w.owner, createPracticeRoute, 'practices', 'POST', { name: 'Counts' })).json()).id;
    const active = await (await w.as(w.owner, createOfferRoute, 'offers', 'POST', { name: 'Counted active', practice_id: p, ...ready })).json();
    await w.as(w.owner, createOfferRoute, 'offers', 'POST', { name: 'Counted draft', practice_id: p, ...ready });
    await w.as(operator, offerAction, `offers/${active.id}:approve`, 'POST');
    expect((await (await w.as(w.owner, getPracticeRoute, `practices/${p}`)).json()).offer_count).toBe(2);
    expect((await (await w.as(seller, getPracticeRoute, `practices/${p}`)).json()).offer_count).toBe(1);
    const row = (await (await w.as(seller, listPracticesRoute, 'practices')).json()).data.find((x: { id: string }) => x.id === p);
    expect(row.offer_count).toBe(1);
  });

  it(':archive on a practice with an active offer gives the new copy', async () => {
    const res = await w.as(w.owner, createPracticeRoute, 'practices', 'POST', { name: 'Blocked practice' });
    const p = (await res.json()).id;
    const o = await (await w.as(w.owner, createOfferRoute, 'offers', 'POST', { name: 'Blocker', practice_id: p, ...ready })).json();
    await w.as(operator, offerAction, `offers/${o.id}:approve`, 'POST');
    const blocked = await w.as(w.owner, practiceAction, `practices/${p}:archive`, 'POST');
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).title).toBe('Retire or move its active offers first.');
  });
});
