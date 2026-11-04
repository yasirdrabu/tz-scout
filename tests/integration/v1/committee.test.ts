import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as getBriefRoute } from '@/http/routes/v1/accounts/[id]/brief/route';
import { GET as getCommitteeRoute } from '@/http/routes/v1/accounts/[id]/committee/route';
import { GET as listPeople, POST as addPerson } from '@/http/routes/v1/accounts/[id]/people/route';
import { PATCH as patchPerson } from '@/http/routes/v1/people/[id]/route';
import { accountSummary } from '@/modules/accounts/db/schema';
import { approveOffer, createOffer, createPractice } from '@/modules/offers';
import { setPrincipalCacheTtl } from '@/modules/tenancy';
import { adminDb, closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { completeOffer } from '../offers/helpers';
import { call, keyFor } from './intake-helpers';
import { workspace, type Workspace } from './review-helpers';

let w: Workspace;
let leader: string;
let account: string;
let techOffer: string;
let ownerOffer: string;
let ana: string;

beforeAll(async () => {
  w = await workspace('Committee Co');
  leader = await w.person('leader', { name: 'Dana Ruiz' });
  const practice = await w.run((ctx) => createPractice(ctx, { name: 'Cmt Practice', slug: `cm-${newId('prc').slice(-8).toLowerCase()}` }));
  const tech = await w.run((ctx) =>
    createOffer(ctx, { name: 'Tech Offer', practiceId: practice.id, ...completeOffer, targetBuyingRoles: ['technical_buyer'], optionalBuyingRoles: ['procurement'] }),
  );
  const owner = await w.run((ctx) =>
    createOffer(ctx, { name: 'Owner Offer', practiceId: practice.id, ...completeOffer, targetBuyingRoles: ['business_owner', 'technical_buyer'] }),
  );
  for (const o of [tech, owner]) await w.run((ctx) => approveOffer(ctx, o.id));
  techOffer = tech.id;
  ownerOffer = owner.id;
  account = await w.sent({ name: 'Committee Route Co' });
  await adminDb
    .update(accountSummary)
    .set({ leadOfferOverrideId: techOffer })
    .where(and(eq(accountSummary.tenantId, w.tenantId), eq(accountSummary.accountId, account)));
  const res = await w.as(leader, addPerson, `accounts/${account}/people`, 'POST', { first_name: 'Ana', last_name: 'Lopez', title: 'Chief Technology Officer' });
  expect(res.status).toBe(201);
  ana = (await res.json()).person_id;
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

const committee = async (query = '') => {
  const res = await w.as(leader, getCommitteeRoute, `accounts/${account}/committee${query}`);
  return { status: res.status, body: await res.json() };
};

describe('GET /accounts/{id}/committee', () => {
  it('returns the lead offer coverage and ?offer_id= switches it', async () => {
    const lead = await committee();
    expect(lead.status).toBe(200);
    expect(Object.keys(lead.body).sort()).toEqual(['gaps', 'offer', 'roles', 'summary']);
    expect(lead.body.offer).toEqual({ id: techOffer, name: 'Tech Offer' });
    expect(lead.body.roles.map((r: { key: string; required: boolean; status: string }) => [r.key, r.required, r.status])).toEqual([
      ['technical_buyer', true, 'guessed'],
      ['procurement', false, 'gap'],
    ]);
    expect(lead.body.roles[0].people).toEqual([{ id: ana, name: 'Ana Lopez', title: 'Chief Technology Officer', origin: 'guessed_from_title' }]);
    expect(lead.body.summary).toEqual({ covered: 0, required: 1, text: '0 of 1 role covered' });

    const other = await committee(`?offer_id=${ownerOffer}`);
    expect(other.body.offer.id).toBe(ownerOffer);
    expect(other.body.summary.required).toBe(2);
    expect(other.body.gaps).toEqual(['business_owner']);
  });

  it('is a 404 for an unknown offer or account', async () => {
    expect((await committee('?offer_id=ofr_missing')).status).toBe(404);
    expect((await w.as(leader, getCommitteeRoute, 'accounts/acc_missing/committee')).status).toBe(404);
  });

  it('the brief carries the same committee', async () => {
    const brief = await (await w.as(leader, getBriefRoute, `accounts/${account}/brief`)).json();
    expect(brief.committee).toEqual((await committee()).body);
  });
});

describe('PATCH /people/{id} confirm_role_keys and note', () => {
  it('confirming a guessed role makes it set_by_person with who and when', async () => {
    const res = await w.as(leader, patchPerson, `people/${ana}`, 'PATCH', { confirm_role_keys: ['technical_buyer'] });
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p.roles).toEqual([
      expect.objectContaining({ key: 'technical_buyer', origin: 'set_by_person', set_by_name: 'Dana Ruiz', set_at: expect.any(String) }),
    ]);
    expect((await committee()).body.summary.covered).toBe(1);
  });

  it('refuses to confirm a role the person does not hold', async () => {
    const res = await w.as(leader, patchPerson, `people/${ana}`, 'PATCH', { confirm_role_keys: ['procurement'] });
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toEqual([{ path: 'confirm_role_keys', message: 'Only a role the person holds can be confirmed.' }]);
  });

  it('a note over 1,000 characters is a 400; a saved note says who and when', async () => {
    const long = await w.as(leader, patchPerson, `people/${ana}`, 'PATCH', { decision_note: 'x'.repeat(1001) });
    expect(long.status).toBe(400);
    expect((await long.json()).errors).toEqual([{ path: 'decision_note', message: 'Keep the note under 1,000 characters.' }]);
    const ok = await w.as(leader, patchPerson, `people/${ana}`, 'PATCH', { decision_note: 'Champion, wants a pilot.' });
    const p = await ok.json();
    expect(p).toMatchObject({ decision_note: 'Champion, wants a pilot.', decision_note_by: { id: leader, name: 'Dana Ruiz' }, decision_note_at: expect.any(String) });
    const listed = await (await w.as(leader, listPeople, `accounts/${account}/people`)).json();
    expect(listed.data[0]).toMatchObject({ decision_note_by: { name: 'Dana Ruiz' } });
  });
});

describe('review fixes', () => {
  it('the committee of an account outside the data limit is a 404', async () => {
    const seller = await w.person('seller', { name: 'Sam Seller', dataLimit: { kind: 'own_accounts' } });
    expect((await w.as(seller, getCommitteeRoute, `accounts/${account}/committee`)).status).toBe(404);
  });

  it('an API key sending confirm_role_keys is a 400', async () => {
    const key = await keyFor(w.tenant, ['accounts:read', 'people:write'], { dataLimit: { kind: 'all' } });
    const res = await call(patchPerson, key, `people/${ana}`, { method: 'PATCH', body: { confirm_role_keys: ['technical_buyer'] } });
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0].path).toBe('confirm_role_keys');
  });

  it('decision_note_by is null for a note a source wrote; a person note over 1,000 characters on POST is a 400', async () => {
    const res = await w.as(leader, addPerson, `accounts/${account}/people`, 'POST', { first_name: 'Bo', last_name: 'Kay', notes: 'From the CRM.' });
    expect(res.status).toBe(201);
    const bo = (await res.json()).person_id;
    const listed = await (await w.as(leader, listPeople, `accounts/${account}/people`)).json();
    expect(listed.data.find((p: { id: string }) => p.id === bo)).toMatchObject({ decision_note: 'From the CRM.', decision_note_by: null, decision_note_at: null });
    const long = await w.as(leader, addPerson, `accounts/${account}/people`, 'POST', { first_name: 'Cy', notes: 'x'.repeat(1001) });
    expect(long.status).toBe(400);
    expect((await long.json()).errors).toEqual([{ path: 'notes', message: 'Keep the note under 1,000 characters.' }]);
  });

  it('confirms a role added in the same PATCH', async () => {
    const res = await w.as(leader, patchPerson, `people/${ana}`, 'PATCH', { role_keys: ['technical_buyer', 'procurement'], confirm_role_keys: ['procurement'] });
    expect(res.status).toBe(200);
    const roles = (await res.json()).roles as { key: string; origin: string }[];
    expect(roles.find((r) => r.key === 'procurement')).toMatchObject({ origin: 'set_by_person' });
  });
});
