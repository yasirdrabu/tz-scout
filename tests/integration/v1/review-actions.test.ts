import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as changesRoute } from '@/http/routes/v1/accounts/[id]/changes/route';
import { PUT as putLeadOffer } from '@/http/routes/v1/accounts/[id]/lead-offer/route';
import { GET as getNotes, POST as postNote } from '@/http/routes/v1/accounts/[id]/notes/route';
import { POST as accountAction } from '@/http/routes/v1/accounts/[id]/route';
import { PUT as putTier } from '@/http/routes/v1/accounts/[id]/tier/route';
import { GET as sellersRoute } from '@/http/routes/v1/assignable-sellers/route';
import { GET as assignmentsRoute } from '@/http/routes/v1/assignments/route';
import { PATCH as patchReviewStatus } from '@/http/routes/v1/accounts/[id]/review-status/route';
import { POST as assignPreviewRoute } from '@/http/routes/v1/review-queue/assign-preview/route';
import { POST as bulkRoute } from '@/http/routes/v1/review-queue/bulk/route';
import { GET as facetsRoute } from '@/http/routes/v1/review-queue/facets/route';
import { GET as queueRoute } from '@/http/routes/v1/review-queue/route';
import { backfillReviewFlow } from '@/entry/seed';
import { accountSummary } from '@/modules/accounts/db/schema';
import { sourceFeedback } from '@/modules/intake/db/schema';
import { assignment, statusChange } from '@/modules/routing/db/schema';
import { seedMockCrm, syncOwners } from '@/modules/crm';
import { activity, mockCompany } from '@/modules/crm/db/schema';
import { callLog } from '@/modules/integrations/db/schema';
import { approveOffer, createOffer, createPractice } from '@/modules/offers';
import { scoreAccount } from '@/modules/scoring';
import { accountScore } from '@/modules/scoring/db/schema';
import { setPrincipalCacheTtl } from '@/modules/tenancy';
import { adminDb, closeDbs } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { completeOffer } from '../offers/helpers';
import { call, keyFor, personAndAgent } from './intake-helpers';
import { workspace, type Workspace } from './review-helpers';

let w: Workspace;
let other: Workspace;
let leader: string;
let seller: string;
let limited: string;
let hidden: { personId: string; agentId: string };
let otherAccount: string;
let dt: { id: string };
let ai: { id: string };
let dtOffer: string;
let aiOffer: string;
let draftOffer: string;

type Row = Record<string, unknown> & { account_id: string };
const json = async (res: Response | Promise<Response>) => (await res).json();
const queueRow = async (id: string, path = 'review-queue') => (await json(w.as(leader, queueRoute, path))).data.find((r: Row) => r.account_id === id);
const slug = (s: string) => `${s}-${newId('evt').slice(-8).toLowerCase()}`;

beforeAll(async () => {
  w = await workspace('Actions Co');
  other = await workspace('Other Actions Co');
  leader = await w.person('leader', { name: 'Dana Leader' });
  seller = await w.person('seller', { name: 'Sam Seller' });
  hidden = await personAndAgent(w.tenant, 'Hidden');
  limited = await w.person('leader', { name: 'Lee Limited', dataLimit: { kind: 'sources', ids: [w.source.agentId] } });
  otherAccount = await other.sent({ name: 'Elsewhere Co' });
  dt = await w.run((ctx) => createPractice(ctx, { name: 'Digital Transformation', slug: slug('dt') }));
  ai = await w.run((ctx) => createPractice(ctx, { name: 'AI Transformation', slug: slug('ai') }));
  dtOffer = (await w.run((ctx) => createOffer(ctx, { name: 'Modernization Blueprint', practiceId: dt.id, ...completeOffer }))).id;
  aiOffer = (await w.run((ctx) => createOffer(ctx, { name: 'AI Pilot', practiceId: ai.id, ...completeOffer }))).id;
  draftOffer = (await w.run((ctx) => createOffer(ctx, { name: 'Draft Offer', practiceId: dt.id, ...completeOffer }))).id;
  await w.run((ctx) => approveOffer(ctx, dtOffer));
  await w.run((ctx) => approveOffer(ctx, aiOffer));
  await w.deliver();
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

describe('notes (Decision 3)', () => {
  it('adds notes newest first with the author, counts them on the queue row, and shows them to everyone who can see the account', async () => {
    const a = await w.account('Notes Co');
    expect(await json(w.as(leader, getNotes, `accounts/${a}/notes`))).toEqual({ data: [], total: 0 });
    const first = await w.as(leader, postNote, `accounts/${a}/notes`, 'POST', { body: '  Ash knows their CIO.  ' });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ id: expect.stringMatching(/^nte_/), body: 'Ash knows their CIO.', by_user_id: leader, by_name: 'Dana Leader', at: expect.any(String) });
    await w.as(w.owner, postNote, `accounts/${a}/notes`, 'POST', { body: 'RFP re-issue in December.' });
    const list = await json(w.as(limited, getNotes, `accounts/${a}/notes`));
    expect(list.total).toBe(2);
    expect(list.data.map((n: { body: string }) => n.body)).toEqual(['RFP re-issue in December.', 'Ash knows their CIO.']);
    await w.deliver();
    expect((await queueRow(a)).note_count).toBe(2);
  });

  it('refuses an empty or too long note, an API key, and a caller who can neither review nor edit', async () => {
    const a = await w.account('Note Rules Co');
    const empty = await w.as(leader, postNote, `accounts/${a}/notes`, 'POST', { body: '   ' });
    expect(empty.status).toBe(400);
    expect((await empty.json()).title).toBe('Write the note first, then add it.');
    expect((await w.as(leader, postNote, `accounts/${a}/notes`, 'POST', { body: 'x'.repeat(4001) })).status).toBe(400);
    expect((await w.as(leader, postNote, `accounts/${a}/notes`, 'POST', { text: 'wrong field' })).status).toBe(400);
    expect((await call(postNote, await keyFor(w.tenant, ['review:act', 'accounts:write']), `accounts/${a}/notes`, { body: { body: 'x' } })).status).toBe(403);
    const viewer = await w.person('operator', { name: 'Ops' });
    // Operators hold review:act by default; a key with only accounts:read can read but not write.
    expect((await w.as(viewer, postNote, `accounts/${a}/notes`, 'POST', { body: 'ok' })).status).toBe(201);
    expect((await call(getNotes, await keyFor(w.tenant, ['review:act']), `accounts/${a}/notes`)).status).toBe(403);
  });

  it('a merge moves the notes to the survivor and recounts them', async () => {
    const [keep, gone] = [await w.account('Keep Co'), await w.account('Gone Co')];
    await w.as(leader, postNote, `accounts/${keep}/notes`, 'POST', { body: 'Kept note' });
    await w.as(leader, postNote, `accounts/${gone}/notes`, 'POST', { body: 'Moved note' });
    expect((await w.as(leader, accountAction, `accounts/${keep}:merge`, 'POST', { merged_id: gone })).status).toBe(200);
    await w.deliver();
    expect((await json(w.as(leader, getNotes, `accounts/${keep}/notes`))).total).toBe(2);
    expect((await json(w.as(leader, getNotes, `accounts/${gone}/notes`))).total).toBe(2);
    expect((await queueRow(keep)).note_count).toBe(2);
  });

  it("another tenant's account, a hidden one, and a seller's unassigned one are 404", async () => {
    const h = await w.account('Hidden Notes Co', hidden.agentId);
    expect((await w.as(leader, getNotes, `accounts/${otherAccount}/notes`)).status).toBe(404);
    expect((await w.as(leader, postNote, `accounts/${otherAccount}/notes`, 'POST', { body: 'x' })).status).toBe(404);
    expect((await w.as(limited, getNotes, `accounts/${h}/notes`)).status).toBe(404);
    expect((await w.as(seller, postNote, `accounts/${h}/notes`, 'POST', { body: 'x' })).status).toBe(404);
  });
});

describe('PUT /accounts/{id}/tier (Decision 4)', () => {
  it('sets the tier by hand, keeps it through a rescore, records who and why, and gives it back to Scout', async () => {
    const a = await w.account('Tier Co');
    const [score] = await w.run((ctx) => ctx.tx.select().from(accountScore).where(eq(accountScore.accountId, a)));
    expect(score).toBeDefined();
    const scored = score!.tier;
    const res = await w.as(leader, putTier, `accounts/${a}/tier`, 'PUT', { tier: 'act_now', note: 'Their CIO asked for a call.' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tier: 'act_now', scored_tier: scored, tier_set_by: leader, tier_set_by_name: 'Dana Leader', tier_note: 'Their CIO asked for a call.', tier_set_at: expect.any(String) });
    await w.deliver();
    expect(await queueRow(a)).toMatchObject({ tier: 'act_now', scored_tier: scored, tier_set_by_name: 'Dana Leader' });

    // A rescore (a day later, so it really recomputes) keeps the manual tier and refreshes the scored one.
    const tomorrow = new Date(Date.now() + 86_400_000);
    await w.run((ctx) => scoreAccount(ctx, a, 'manual_rescore', undefined, { now: tomorrow }));
    const [after] = await w.run((ctx) => ctx.tx.select().from(accountScore).where(eq(accountScore.accountId, a)));
    expect(after).toMatchObject({ tier: 'act_now', scoredTier: scored, tierOverride: 'act_now', tierOverrideBy: leader });
    expect(after!.computedAt.getTime()).toBe(tomorrow.getTime());
    await w.deliver();
    expect((await queueRow(a)).tier).toBe('act_now');

    const changes = await json(w.as(leader, changesRoute, `accounts/${a}/changes`));
    expect(changes.data).toContainEqual(expect.objectContaining({ kind: 'tier', field: 'tier', to: 'Act now', by_name: 'Dana Leader', note: 'Their CIO asked for a call.' }));
    const audited = await adminDb.select().from(auditLog).where(and(eq(auditLog.tenantId, w.tenantId), eq(auditLog.action, 'scoring.tier.changed')));
    expect(audited.length).toBeGreaterThanOrEqual(1);

    const back = await json(w.as(leader, putTier, `accounts/${a}/tier`, 'PUT', { tier: null }));
    expect(back).toMatchObject({ tier: scored, scored_tier: scored, tier_set_by: null, tier_set_by_name: null, tier_note: null });
    await w.deliver();
    expect((await queueRow(a)).tier).toBe(scored);
  });

  it('refuses an unknown tier, a seller, an API key and another tenant', async () => {
    const a = await w.account('Tier Rules Co');
    expect((await w.as(leader, putTier, `accounts/${a}/tier`, 'PUT', { tier: 'hot' })).status).toBe(400);
    expect((await w.as(leader, putTier, `accounts/${a}/tier`, 'PUT', {})).status).toBe(400);
    expect((await w.as(seller, putTier, `accounts/${a}/tier`, 'PUT', { tier: 'watch' })).status).toBe(403);
    expect((await call(putTier, await keyFor(w.tenant, ['review:act']), `accounts/${a}/tier`, { method: 'PUT', body: { tier: 'watch' } })).status).toBe(403);
    expect((await w.as(leader, putTier, `accounts/${otherAccount}/tier`, 'PUT', { tier: 'watch' })).status).toBe(404);
  });
});

describe('PUT /accounts/{id}/lead-offer (Decision 5)', () => {
  it('picks an approved offer, which rows and the offer filter then use, and null gives it back to Scout', async () => {
    const a = await w.account('Offer Co');
    const res = await w.as(leader, putLeadOffer, `accounts/${a}/lead-offer`, 'PUT', { offer_id: dtOffer });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      account_id: a,
      lead_offer: { offer_id: dtOffer, name: 'Modernization Blueprint', practice_id: dt.id, practice_name: 'Digital Transformation', chosen: true },
    });
    await w.deliver();
    const row = await queueRow(a, `review-queue?offer_id=${dtOffer}`);
    expect(row).toMatchObject({ lead_offer: { offer_id: dtOffer, chosen: true }, lead_offer_override_id: dtOffer });
    const changes = await json(w.as(leader, changesRoute, `accounts/${a}/changes`));
    expect(changes.data).toContainEqual(expect.objectContaining({ kind: 'lead_offer', field: 'best_offer', from: "Scout's pick", to: 'Modernization Blueprint', by_name: 'Dana Leader' }));
    const cleared = await json(w.as(leader, putLeadOffer, `accounts/${a}/lead-offer`, 'PUT', { offer_id: null }));
    expect(cleared.lead_offer?.chosen ?? false).toBe(false);
    await w.deliver();
    expect(await queueRow(a)).toMatchObject({ lead_offer_override_id: null });
    expect((await queueRow(a)).lead_offer?.chosen ?? false).toBe(false);
  });

  it('refuses a draft offer, a seller, and another tenant', async () => {
    const a = await w.account('Offer Rules Co');
    const draft = await w.as(leader, putLeadOffer, `accounts/${a}/lead-offer`, 'PUT', { offer_id: draftOffer });
    expect(draft.status).toBe(400);
    expect((await draft.json()).errors).toEqual([{ path: 'offer_id', message: 'Pick an approved offer.' }]);
    expect((await w.as(seller, putLeadOffer, `accounts/${a}/lead-offer`, 'PUT', { offer_id: dtOffer })).status).toBe(403);
    expect((await w.as(leader, putLeadOffer, `accounts/${otherAccount}/lead-offer`, 'PUT', { offer_id: null })).status).toBe(404);
  });
});

describe('GET /assignable-sellers (Decision 8)', () => {
  it('lists sellers with practices, active accounts and the HubSpot link, and badges the best match with a reason', async () => {
    const busy = await w.person('seller', { name: 'Busy Dt', dataLimit: { kind: 'any_of', limits: [{ kind: 'own_accounts' }, { kind: 'practices', ids: [dt.id] }] } });
    const free = await w.person('seller', { name: 'Free Dt', dataLimit: { kind: 'practices', ids: [dt.id, ai.id] } });
    const unlinked = await w.person('seller', { name: 'Unlinked Dt', dataLimit: { kind: 'practices', ids: [dt.id] }, crm: false });
    const a = await w.account('Match Co');
    await w.as(leader, putLeadOffer, `accounts/${a}/lead-offer`, 'PUT', { offer_id: dtOffer });
    const busyAccount = await w.account('Busy Co');
    expect((await w.as(leader, accountAction, `accounts/${busyAccount}:assign`, 'POST', { seller_user_id: busy })).status).toBe(202);

    const res = await w.as(leader, sellersRoute, `assignable-sellers?account_ids=${a}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.best_match).toEqual({ user_id: free, reason: 'Covers Digital Transformation and has the fewest active accounts (0).' });
    const card = (id: string) => body.data.find((s: { user_id: string }) => s.user_id === id);
    expect(card(free)).toMatchObject({ name: 'Free Dt', practices: [{ id: dt.id, name: 'Digital Transformation' }, { id: ai.id, name: 'AI Transformation' }], all_practices: false, active_accounts: 0, crm_owner_linked: true, best_match: true });
    expect(card(busy)).toMatchObject({ practices: [{ id: dt.id, name: 'Digital Transformation' }], active_accounts: 1, best_match: false });
    expect(card(unlinked)).toMatchObject({ crm_owner_linked: false, best_match: false });
    expect(card(seller)).toMatchObject({ practices: [], all_practices: false });
  });

  it('gives no badge when nobody covers the offer, and checks ids and permission', async () => {
    const legal = await w.run((ctx) => createPractice(ctx, { name: 'Legal', slug: slug('legal') }));
    const legalOffer = (await w.run((ctx) => createOffer(ctx, { name: 'Contract Review', practiceId: legal.id, ...completeOffer }))).id;
    await w.run((ctx) => approveOffer(ctx, legalOffer));
    const a = await w.account('Nobody Co');
    await w.as(leader, putLeadOffer, `accounts/${a}/lead-offer`, 'PUT', { offer_id: legalOffer });
    expect((await json(w.as(leader, sellersRoute, `assignable-sellers?account_ids=${a}`))).best_match).toBeNull();
    expect((await w.as(leader, sellersRoute, 'assignable-sellers')).status).toBe(400);
    expect((await w.as(leader, sellersRoute, `assignable-sellers?account_ids=${otherAccount}`)).status).toBe(404);
    expect((await w.as(seller, sellersRoute, `assignable-sellers?account_ids=${a}`)).status).toBe(403);
  });
});

describe('My accounts reads', () => {
  it("each assignment carries the assigner's name, the offer, the stage, the handoff state and the last CRM activity", async () => {
    const a = await w.account('My Co');
    await w.as(leader, putLeadOffer, `accounts/${a}/lead-offer`, 'PUT', { offer_id: aiOffer });
    expect((await w.as(leader, accountAction, `accounts/${a}:assign`, 'POST', { seller_user_id: seller, notes: 'Call Ash first.' })).status).toBe(202);
    await w.run((ctx) => ctx.tx.insert(activity).values({ id: newId('cac'), tenantId: ctx.tenantId, accountId: a, system: 'hubspot', externalId: newId('evt'), kind: 'email', occurredAt: new Date('2026-10-27T09:00:00Z') }));
    await w.deliver();
    const body = await json(w.as(seller, assignmentsRoute, 'assignments?mine=true&status=pending'));
    expect(body.data.find((r: { account_id: string }) => r.account_id === a)).toMatchObject({
      account_name: 'My Co',
      assigned_by_name: 'Dana Leader',
      notes: 'Call Ash first.',
      offer_id: aiOffer,
      offer_name: 'AI Pilot',
      playbook_name: null,
      stage: 'reviewed',
      stage_label: 'Reviewed',
      next_step: null,
      last_activity: { kind: 'email', at: '2026-10-27T09:00:00.000Z' },
      handoff: { state: expect.any(String) },
    });
  });
});

describe('fix round', () => {
  it('backfill-review-flow: a lead offer picked before the snapshot carried it reaches the offer filter and facet', async () => {
    const a = await w.account('Old Pick Co');
    expect((await w.as(leader, accountAction, `accounts/${a}:assign`, 'POST', { seller_user_id: seller, lead_offer_id: aiOffer })).status).toBe(202);
    await w.deliver();
    // As it was before this branch: the summary never got the pick.
    await adminDb.update(accountSummary).set({ leadOfferOverrideId: null }).where(eq(accountSummary.accountId, a));
    const path = `review-queue?status=reviewed&offer_id=${aiOffer}`;
    expect(await queueRow(a, path)).toBeUndefined();
    await w.run((ctx) => backfillReviewFlow(ctx));
    await w.deliver();
    expect(await queueRow(a, path)).toMatchObject({ lead_offer_override_id: aiOffer });
    const facets = await json(w.as(leader, facetsRoute, 'review-queue/facets?status=reviewed'));
    expect(facets.offers.find((o: { value: string }) => o.value === aiOffer)?.count).toBeGreaterThanOrEqual(1);
  });

  it('a send back of a Not pursued account goes back to the source with its reason, not to In review', async () => {
    const a = await w.sent({ name: 'Declined Back Co' });
    expect((await w.as(leader, patchReviewStatus, `accounts/${a}/review-status`, 'PATCH', { to: 'declined', reason_key: 'duplicate' })).status).toBe(200);
    const noReason = await w.as(leader, patchReviewStatus, `accounts/${a}/review-status`, 'PATCH', { to: 'sent_back' });
    expect(await noReason.json()).toMatchObject({ title: 'Pick a reason' });
    const res = await w.as(leader, patchReviewStatus, `accounts/${a}/review-status`, 'PATCH', { to: 'sent_back', reason_key: 'wrong_practice' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ review_status_key: 'sent_back' });
    const [move] = await w.run((ctx) => ctx.tx.select().from(statusChange).where(and(eq(statusChange.accountId, a), eq(statusChange.toKey, 'sent_back'))));
    expect(move).toMatchObject({ fromKey: 'declined', reasonKey: 'wrong_practice' });
    await w.deliver();
    const feedback = await w.run((ctx) => ctx.tx.select().from(sourceFeedback).where(eq(sourceFeedback.accountId, a)));
    expect(feedback.map((f) => [f.kind, f.reasonKey])).toContainEqual(['sent_back', 'wrong_practice']);
  });

  it('bulk: a declined account in a send back is sent back like the others', async () => {
    const [a, b] = [await w.account('Bulk Declined'), await w.account('Bulk Fresh')];
    await w.as(leader, patchReviewStatus, `accounts/${a}/review-status`, 'PATCH', { to: 'declined', reason_key: 'bad_data' });
    const res = await json(w.as(leader, bulkRoute, 'review-queue/bulk', 'POST', { account_ids: [a, b], action: 'status', to: 'sent_back', reason_key: 'bad_contact' }));
    expect(res.results).toEqual([
      { account_id: a, ok: true },
      { account_id: b, ok: true },
    ]);
    await w.deliver();
    for (const id of [a, b]) expect((await w.run((ctx) => ctx.tx.select().from(accountSummary).where(eq(accountSummary.accountId, id))))[0]!.reviewStatusKey).toBe('sent_back');
  });

  it("last_reviewed_at only looks at accounts the caller can see", async () => {
    const p = await w.run((ctx) => createPractice(ctx, { name: 'Limited Practice', slug: slug('lim') }));
    const reviewer = await w.person('leader', { name: 'Pat Practice', dataLimit: { kind: 'practices', ids: [p.id] } });
    const seen = await w.account('Seen Co');
    await adminDb.update(accountSummary).set({ practiceIds: [p.id] }).where(eq(accountSummary.accountId, seen));
    await w.as(leader, patchReviewStatus, `accounts/${seen}/review-status`, 'PATCH', { to: 'reviewed' });
    const [mine] = await w.run((ctx) => ctx.tx.select().from(statusChange).where(and(eq(statusChange.accountId, seen), eq(statusChange.toKey, 'reviewed'))));
    // Someone reviews an account outside the practice afterwards.
    const outside = await w.account('Outside Co');
    await w.as(leader, patchReviewStatus, `accounts/${outside}/review-status`, 'PATCH', { to: 'reviewed' });
    await w.deliver();
    const limitedView = await json(w.as(reviewer, facetsRoute, 'review-queue/facets'));
    expect(limitedView.last_reviewed_at).toBe(mine!.at.toISOString());
    const full = await json(w.as(leader, facetsRoute, 'review-queue/facets'));
    expect(Date.parse(full.last_reviewed_at)).toBeGreaterThan(mine!.at.getTime());
  });
});

describe('assign previews: ownership details and the bulk preview', () => {
  const hubspotCalls = async () => (await adminDb.select({ id: callLog.id }).from(callLog).where(eq(callLog.tenantId, w.tenantId))).length;
  const preview = (accountId: string) => w.as(leader, accountAction, `accounts/${accountId}:assign-preview`, 'POST', { seller_user_id: seller });

  beforeAll(async () => {
    await w.run((ctx) => seedMockCrm(ctx));
    await w.run((ctx) => syncOwners(ctx));
  });

  it('an open-deal stop names the owner and the top open deal; a customer stop has no deal', async () => {
    const a = await w.sent({ name: 'Open Deal Co', domain: 'open-deal.example' });
    const res = await preview(a);
    expect(res.status).toBe(200);
    expect((await res.json()).preflight).toEqual({
      result: 'stop',
      message: 'Open deal owned by Vijay Kumar: will not change owner',
      reason: 'open_deal',
      current_owner_name: 'Vijay Kumar',
      deal: { name: 'Open Deal renewal', amount_cents: 5_000_000, currency: 'USD', last_activity_at: expect.any(String) },
    });
    const c = await w.sent({ name: 'Customer Co', domain: 'customer.example' });
    expect((await json(preview(c))).preflight).toMatchObject({ result: 'stop', reason: 'customer', current_owner_name: 'Vijay Kumar', deal: null });
  });

  it('bulk: one call answers each account in the order asked, from the stored check, with 404 for another tenant', async () => {
    const [x, y] = [await w.sent({ name: 'Bulk Preview A' }), await w.sent({ name: 'Bulk Preview B' })];
    // A check under a day old for each, as a single preview stores it.
    for (const id of [x, y]) expect((await preview(id)).status).toBe(200);
    const before = await hubspotCalls();
    const res = await w.as(leader, assignPreviewRoute, 'review-queue/assign-preview', 'POST', { account_ids: [y, otherAccount, x], seller_user_id: seller });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.map((r: { account_id: string; ok: boolean }) => [r.account_id, r.ok])).toEqual([
      [y, true],
      [otherAccount, false],
      [x, true],
    ]);
    expect(data[0]).toMatchObject({ preflight: { result: 'new' }, approves_to: { key: 'reviewed' }, replaces: null });
    expect(data[1]).toEqual({ account_id: otherAccount, ok: false, status: 404, message: expect.any(String) });
    expect(await hubspotCalls()).toBe(before);
  });

  it('bulk assign: a per-account keep leaves the stopped account with its owner and the others move to the seller', async () => {
    const a = await w.sent({ name: 'Bulk Keep Open Deal', domain: 'open-deal.example' });
    const b = await w.sent({ name: 'Bulk Move Owned', domain: 'owned-elsewhere.example' });
    const res = await w.as(leader, bulkRoute, 'review-queue/bulk', 'POST', { account_ids: [a, b], action: 'assign', seller_user_id: seller, ownership_decisions: { [a]: 'keep' } });
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([
      { account_id: a, ok: true },
      { account_id: b, ok: true },
    ]);
    const decisions = await w.run((ctx) => ctx.tx.select({ accountId: assignment.accountId, d: assignment.ownershipDecision }).from(assignment).where(inArray(assignment.accountId, [a, b])));
    expect(Object.fromEntries(decisions.map((r) => [r.accountId, r.d]))).toEqual({ [a]: 'keep', [b]: 'assign' });
    await w.deliver();
    const owner = async (domain: string) => (await w.run((ctx) => ctx.tx.select({ owner: mockCompany.ownerExternalId }).from(mockCompany).where(eq(mockCompany.domain, domain))))[0]!.owner;
    expect(await owner('owned-elsewhere.example')).toBe(`mock-${seller}`);
    expect(await owner('open-deal.example')).not.toBe(`mock-${seller}`);
    // Without a keep, the stopped account is refused on its own and the other still goes.
    const c = await w.sent({ name: 'Bulk No Keep', domain: 'customer.example' });
    const d = await w.sent({ name: 'Bulk Plain' });
    const plain = (await json(w.as(leader, bulkRoute, 'review-queue/bulk', 'POST', { account_ids: [c, d], action: 'assign', seller_user_id: seller }))).results;
    expect(plain).toEqual([
      { account_id: c, ok: false, status: 409, message: expect.stringContaining('will not change owner') },
      { account_id: d, ok: true },
    ]);
    expect((await w.as(leader, bulkRoute, 'review-queue/bulk', 'POST', { account_ids: [d], action: 'assign', seller_user_id: seller, ownership_decisions: { [d]: 'maybe' } })).status).toBe(400);
  });

  it('bulk: refuses 51 ids, a bad body, a seller and an API key', async () => {
    const a = await w.sent({ name: 'Bulk Preview Refused' });
    const post = (who: string, body: unknown) => w.as(who, assignPreviewRoute, 'review-queue/assign-preview', 'POST', body);
    const many = Array.from({ length: 51 }, (_, i) => `acc_${i}`);
    expect((await post(leader, { account_ids: many, seller_user_id: seller })).status).toBe(400);
    expect((await post(leader, { account_ids: [], seller_user_id: seller })).status).toBe(400);
    expect((await post(leader, { account_ids: [a] })).status).toBe(400);
    expect((await post(seller, { account_ids: [a], seller_user_id: seller })).status).toBe(403);
    const key = await keyFor(w.tenant, ['assign:act', 'review:act'], { dataLimit: { kind: 'all' } });
    expect((await call(assignPreviewRoute, key, 'review-queue/assign-preview', { body: { account_ids: [a], seller_user_id: seller } })).status).toBe(403);
  });
});
