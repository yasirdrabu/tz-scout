import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as offerPlaybooksRoute } from '@/http/routes/v1/offers/[id]/playbooks/route';
import { PUT as putOfferPlaybook } from '@/http/routes/v1/offers/[id]/playbooks/[tier]/route';
import { DELETE as deleteRoute, GET as getRoute, PATCH as patchRoute, POST as actionRoute } from '@/http/routes/v1/playbooks/[id]/route';
import { GET as listRoute, POST as createRoute } from '@/http/routes/v1/playbooks/route';
import { approveOffer, createOffer, createPractice } from '@/modules/offers';
import { setPrincipalCacheTtl } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import { completeOffer } from '../offers/helpers';
import { workspace, type Workspace } from './review-helpers';

let w: Workspace;
let other: Workspace;
let leader: string;
let seller: string;
let operator: string;
let offerId: string;

const steps = [
  { day: 0, channel: 'email', owner_role: 'seller', title: 'Intro', subject: 'Hi {person.first_name}', body: 'Body' },
  { day: 4, channel: 'call', owner_role: 'seller', title: 'Call', crm_task: false },
];

beforeAll(async () => {
  w = await workspace('Playbook Co');
  other = await workspace('Other Playbook Co');
  leader = await w.person('leader');
  seller = await w.person('seller');
  operator = await w.person('operator');
  const practice = await w.run((ctx) => createPractice(ctx, { name: 'Main' }));
  offerId = (await w.run(async (ctx) => {
    const o = await createOffer(ctx, { name: 'Pilot', practiceId: practice.id, ...completeOffer });
    return approveOffer(ctx, o.id);
  })).id;
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

describe('/api/v1/playbooks', () => {
  it('a seller can read but not create (403); a leader creates (201) with snake_case JSON', async () => {
    const denied = await w.as(seller, createRoute, 'playbooks', 'POST', { name: 'Nope' });
    expect(denied.status).toBe(403);
    expect((await w.as(seller, listRoute, 'playbooks')).status).toBe(200);

    const res = await w.as(leader, createRoute, 'playbooks', 'POST', { name: 'Route playbook', when_to_use: 'Always', steps });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ name: 'Route playbook', status: 'draft', version: 1, when_to_use: 'Always', stop_when: 'reply_or_meeting', step_count: 2, days: 4 });
    expect(body.tenant_id).toBeUndefined();
    expect(body.steps[0]).toMatchObject({ order: 1, day: 0, channel: 'email', owner_role: 'seller', subject: 'Hi {person.first_name}', crm_task: true });
    expect(body.steps[1]).toMatchObject({ crm_task: false, subject: null });
  });

  it('validates the body', async () => {
    const noName = await w.as(leader, createRoute, 'playbooks', 'POST', { name: '  ' });
    expect(noName.status).toBe(400);
    expect((await noName.json()).title).toBe('Give the playbook a name.');
    const badDay = await w.as(leader, createRoute, 'playbooks', 'POST', { name: 'x', steps: [{ ...steps[1], day: 400 }] });
    expect(badDay.status).toBe(400);
    const long = await w.as(leader, createRoute, 'playbooks', 'POST', { name: 'x', steps: [{ ...steps[1], title: 'a'.repeat(201) }] });
    expect(long.status).toBe(400);
    expect((await long.json()).errors[0].message).toBe('Keep this under 200 characters.');
    const unknown = await w.as(leader, createRoute, 'playbooks', 'POST', { name: 'x', auto_send: true });
    expect(unknown.status).toBe(400);
  });

  it('activates only with steps, versions an active edit, and reads ?version=1', async () => {
    const made = await (await w.as(leader, createRoute, 'playbooks', 'POST', { name: 'Flow' })).json();
    const empty = await w.as(leader, patchRoute, `playbooks/${made.id}`, 'PATCH', { status: 'active' });
    expect(empty.status).toBe(400);
    expect((await empty.json()).title).toBe('Add at least one step.');

    const live = await (await w.as(leader, patchRoute, `playbooks/${made.id}`, 'PATCH', { status: 'active', steps: [steps[0]] })).json();
    expect(live).toMatchObject({ status: 'active', version: 1 });
    const v2 = await (await w.as(leader, patchRoute, `playbooks/${made.id}`, 'PATCH', { steps })).json();
    expect(v2.version).toBe(2);
    const v1 = await (await w.as(seller, getRoute, `playbooks/${made.id}?version=1`)).json();
    expect(v1.steps).toHaveLength(1);
    expect((await w.as(seller, getRoute, `playbooks/${made.id}`)).status).toBe(200);
    expect((await w.as(seller, getRoute, `playbooks/${made.id}?version=9`)).status).toBe(404);
  });

  it('lists with counts, duplicates, archives and deletes', async () => {
    const made = await (await w.as(leader, createRoute, 'playbooks', 'POST', { name: 'Cycle', status: 'active', steps })).json();
    const list = await (await w.as(seller, listRoute, 'playbooks')).json();
    const row = list.data.find((x: { id: string }) => x.id === made.id);
    expect(row).toMatchObject({ steps: 2, days: 4, channels: { email: 1, call: 1 }, runs_on: [], running: 0 });

    expect((await w.as(seller, actionRoute, `playbooks/${made.id}:duplicate`, 'POST')).status).toBe(403);
    const copy = await w.as(leader, actionRoute, `playbooks/${made.id}:duplicate`, 'POST');
    expect(copy.status).toBe(201);
    expect(await copy.json()).toMatchObject({ name: 'Cycle (copy)', status: 'draft' });
    const archived = await (await w.as(leader, actionRoute, `playbooks/${made.id}:archive`, 'POST')).json();
    expect(archived.status).toBe('archived');
    expect((await w.as(leader, actionRoute, `playbooks/${made.id}:nope`, 'POST')).status).toBe(404);

    expect((await w.as(leader, deleteRoute, `playbooks/${made.id}`, 'DELETE')).status).toBe(204);
    expect((await w.as(leader, getRoute, `playbooks/${made.id}`)).status).toBe(404);
  });

  it('is tenant-isolated', async () => {
    const made = await (await w.as(leader, createRoute, 'playbooks', 'POST', { name: 'Private' })).json();
    const theirs = await other.person('leader');
    expect((await other.as(theirs, getRoute, `playbooks/${made.id}`)).status).toBe(404);
  });
});

describe('/api/v1/offers/{id}/playbooks', () => {
  it('sets, reads and clears a tier; refuses archived, bad tier and unknown offer', async () => {
    const pb = await (await w.as(leader, createRoute, 'playbooks', 'POST', { name: 'Offer map', status: 'active', steps })).json();

    expect((await w.as(seller, putOfferPlaybook, `offers/${offerId}/playbooks/act_now`, 'PUT', { playbook_id: pb.id })).status).toBe(403);
    // A leader holds playbooks:manage but not offers:manage, and may map playbooks.
    const byLeader = await w.as(leader, putOfferPlaybook, `offers/${offerId}/playbooks/good_fit`, 'PUT', { playbook_id: pb.id });
    expect(byLeader.status).toBe(200);
    await w.as(leader, putOfferPlaybook, `offers/${offerId}/playbooks/good_fit`, 'PUT', { playbook_id: null });
    const set = await w.as(operator, putOfferPlaybook, `offers/${offerId}/playbooks/act_now`, 'PUT', { playbook_id: pb.id });
    expect(set.status).toBe(200);

    const read = await (await w.as(seller, offerPlaybooksRoute, `offers/${offerId}/playbooks`)).json();
    expect(read.data.map((d: { tier: string }) => d.tier)).toEqual(['act_now', 'good_fit', 'watch']);
    expect(read.data[0]).toMatchObject({ tier: 'act_now', playbook: { id: pb.id, name: 'Offer map', status: 'active', steps: 2, days: 4 }, first_email: { subject: 'Hi {person.first_name}', body: 'Body' } });
    expect(read.data[1]).toEqual({ tier: 'good_fit', playbook: null, first_email: null });

    const badTier = await w.as(operator, putOfferPlaybook, `offers/${offerId}/playbooks/nurture`, 'PUT', { playbook_id: pb.id });
    expect(badTier.status).toBe(400);
    await w.as(leader, actionRoute, `playbooks/${pb.id}:archive`, 'POST');
    const archived = await w.as(operator, putOfferPlaybook, `offers/${offerId}/playbooks/watch`, 'PUT', { playbook_id: pb.id });
    expect(archived.status).toBe(400);
    expect((await archived.json()).title).toBe("That playbook isn't available.");

    const cleared = await (await w.as(operator, putOfferPlaybook, `offers/${offerId}/playbooks/act_now`, 'PUT', { playbook_id: null })).json();
    expect(cleared.data[0].playbook).toBeNull();

    expect((await w.as(operator, offerPlaybooksRoute, 'offers/off_missing/playbooks')).status).toBe(404);
    expect((await w.as(operator, putOfferPlaybook, 'offers/off_missing/playbooks/watch', 'PUT', { playbook_id: null })).status).toBe(404);
  });
});
