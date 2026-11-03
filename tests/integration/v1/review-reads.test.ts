import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as exportRoute } from '@/http/routes/v1/accounts/export/route';
import { GET as accountFacetsRoute } from '@/http/routes/v1/accounts/facets/route';
import { GET as changesRoute } from '@/http/routes/v1/accounts/[id]/changes/route';
import { GET as reviewRoute } from '@/http/routes/v1/accounts/[id]/review/route';
import { PATCH as patchReviewStatus } from '@/http/routes/v1/accounts/[id]/review-status/route';
import { POST as accountAction } from '@/http/routes/v1/accounts/[id]/route';
import { GET as accountsRoute } from '@/http/routes/v1/accounts/route';
import { DELETE as resetColumns, GET as getColumns, PUT as putColumns } from '@/http/routes/v1/me/preferences/review-queue-columns/route';
import { GET as facetsRoute } from '@/http/routes/v1/review-queue/facets/route';
import { GET as queueRoute } from '@/http/routes/v1/review-queue/route';
import { GET as conflictsRoute } from '@/http/routes/v1/accounts/[id]/conflicts/route';
import { POST as conflictAction } from '@/http/routes/v1/conflicts/[id]/route';
import { activity, deal } from '@/modules/crm/db/schema';
import { stageChange } from '@/modules/routing/db/schema';
import { accountScore } from '@/modules/scoring/db/schema';
import { setPrincipalCacheTtl } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { setSummary } from '../routing/helpers';
import { call, keyFor, personAndAgent } from './intake-helpers';
import { workspace, type Workspace } from './review-helpers';

let w: Workspace;
let other: Workspace;
let leader: string;
let seller: string;
let limited: string;
let hidden: { personId: string; agentId: string };
let otherAccount: string;

type Row = Record<string, unknown> & { account_id: string };
const ids = (body: { data: Row[] }) => body.data.map((r) => r.account_id);
const json = async (res: Response | Promise<Response>) => (await res).json();

beforeAll(async () => {
  w = await workspace('Reads Co');
  other = await workspace('Other Reads Co');
  leader = await w.person('leader', { name: 'Dana Leader' });
  seller = await w.person('seller', { name: 'Sam Seller' });
  hidden = await personAndAgent(w.tenant, 'Hidden');
  limited = await w.person('leader', { name: 'Lee Limited', dataLimit: { kind: 'sources', ids: [w.source.agentId] } });
  otherAccount = await other.sent({ name: 'Elsewhere Co' });
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

describe('GET /review-queue rows (screens.md §2)', () => {
  it('carry location, fit and intent, the source and via, the status color and who set it', async () => {
    const a = await w.sent({ name: 'Miami-Dade DTPW', industry: 'Government', city: 'Miami', region: 'FL' });
    await setSummary(w.tenant, a, { priority: 99, fit: 85, intent: 70 });
    let row = (await json(w.as(leader, queueRoute, 'review-queue'))).data.find((r: Row) => r.account_id === a);
    expect(row).toMatchObject({
      name: 'Miami-Dade DTPW',
      industry: 'Government',
      hq_city: 'Miami',
      hq_state: 'FL',
      fit: 85,
      intent: 70,
      review_status_label: 'Ready for review',
      review_status_color: 'plum',
      status_changed_by_name: null,
      source: { source_id: w.source.agentId, name: 'Reads Co Ash agent', kind: 'agent', via: 'Reads Co Ash' },
      lead_offer: null,
      previous_tier: null,
      warm_intro: null,
      conflict_count: 0,
      enrichment_requested: false,
      enrichment_requested_by: null,
    });
    expect(row.status_changed_at).toEqual(expect.any(String));
    expect((await w.as(leader, patchReviewStatus, `accounts/${a}/review-status`, 'PATCH', { to: 'needs_review' })).status).toBe(200);
    await w.deliver();
    row = (await json(w.as(leader, queueRoute, 'review-queue'))).data.find((r: Row) => r.account_id === a);
    expect(row).toMatchObject({ review_status_label: 'In review', review_status_color: 'amber', status_changed_by_name: 'Dana Leader' });
  });

  it('counts open conflicts, filters by flag=conflicts, and drops to 0 once resolved', async () => {
    const domain = `${newId('acc').slice(-10).toLowerCase()}-example.com`;
    const second = await personAndAgent(w.tenant, 'Disputer');
    const a = await w.sent({ name: 'Disputed Co', domain, employees: 1000 });
    expect(await w.sent({ name: 'Disputed Co', domain, employees: 2000 }, second.agentId)).toBe(a);
    const calm = await w.sent({ name: 'Calm Co' });
    const rowsOf = async (qs = '') => (await json(w.as(leader, queueRoute, `review-queue${qs}`))).data as Row[];
    expect((await rowsOf()).find((r) => r.account_id === a)).toMatchObject({ conflict_count: 1 });
    expect((await rowsOf()).find((r) => r.account_id === calm)).toMatchObject({ conflict_count: 0 });
    expect((await rowsOf('?flag=conflicts')).map((r) => r.account_id)).toEqual([a]);
    const [c] = (await json(w.as(leader, conflictsRoute, `accounts/${a}/conflicts`))).data as { id: string; facts: { id: string }[] }[];
    expect((await w.as(leader, conflictAction, `conflicts/${c!.id}:resolve`, 'POST', { kept_fact_id: c!.facts[0]!.id })).status).toBe(200);
    expect((await rowsOf()).find((r) => r.account_id === a)).toMatchObject({ conflict_count: 0 });
    expect(await rowsOf('?flag=conflicts')).toEqual([]);
  });

  it('updated_since narrows to rows that changed; a bad value is a 400', async () => {
    const since = new Date().toISOString();
    const b = await w.account('Fresh Co');
    const body = await json(w.as(leader, queueRoute, `review-queue?updated_since=${encodeURIComponent(since)}`));
    expect(ids(body)).toEqual([b]);
    expect((await w.as(leader, queueRoute, 'review-queue?updated_since=yesterday')).status).toBe(400);
  });
});

describe('GET /review-queue/facets', () => {
  it('counts tiers, statuses and sources with names, each with the other filters applied', async () => {
    const src = await personAndAgent(w.tenant, 'Facet');
    const [a, b, c] = [await w.account('Facet A', src.agentId), await w.account('Facet B', src.agentId), await w.account('Facet C', src.agentId)];
    await setSummary(w.tenant, a, { tier: 'act_now' });
    await setSummary(w.tenant, b, { tier: 'act_now' });
    await setSummary(w.tenant, c, { tier: 'watch' });
    await w.as(leader, patchReviewStatus, `accounts/${c}/review-status`, 'PATCH', { to: 'reviewed' });
    await w.deliver();
    const res = await w.as(leader, facetsRoute, `review-queue/facets?source_id=${src.agentId}&tier=act_now`);
    expect(res.status).toBe(200);
    const f = await res.json();
    expect(f.total).toBe(2);
    expect(f.tiers).toEqual([
      { value: 'act_now', label: 'Act now', count: 2 },
      { value: 'good_fit', label: 'Good fit', count: 0 },
      { value: 'watch', label: 'Watch', count: 0 },
      { value: 'nurture', label: 'Nurture', count: 0 },
      { value: 'not_fit', label: 'Not a fit', count: 0 },
    ]);
    expect(f.sources).toContainEqual({ value: src.agentId, label: 'Facet agent', count: 2 });
    // Statuses count every status, so Approved shows the account that left the default view.
    const all = await json(w.as(leader, facetsRoute, `review-queue/facets?source_id=${src.agentId}`));
    expect(all.statuses.find((s: { value: string }) => s.value === 'reviewed')).toEqual({ value: 'reviewed', label: 'Approved', color: 'green', count: 1 });
    expect(all.statuses.find((s: { value: string }) => s.value === 'unvetted')).toMatchObject({ count: 2 });
    expect(all.oldest_arrived_at).toEqual(expect.any(String));
    expect(all.last_reviewed_at).toEqual(expect.any(String));
  });

  it('total_all_tiers drops only the tier filter; source_count counts the sources with an account, every filter but source_id applied', async () => {
    const one = await personAndAgent(w.tenant, 'Count One');
    const two = await personAndAgent(w.tenant, 'Count Two');
    const offerId = newId('off');
    const accounts = [await w.account('Count A', one.agentId), await w.account('Count B', one.agentId), await w.account('Count C', two.agentId)];
    for (const a of accounts) await setSummary(w.tenant, a, { bestOfferId: offerId });
    await setSummary(w.tenant, accounts[0]!, { tier: 'act_now' });
    await setSummary(w.tenant, accounts[1]!, { tier: 'watch' });
    await setSummary(w.tenant, accounts[2]!, { tier: 'good_fit' });
    const f = await json(w.as(leader, facetsRoute, `review-queue/facets?offer_id=${offerId}&tier=act_now`));
    expect(f.total).toBe(1);
    expect(f.total_all_tiers).toBe(3);
    expect(f.source_count).toBe(1);
    const all = await json(w.as(leader, facetsRoute, `review-queue/facets?offer_id=${offerId}&source_id=${one.agentId}`));
    expect(all.total).toBe(2);
    expect(all.source_count).toBe(2);
  });

  it("needs review:act, checks the filters, and never counts another tenant's accounts", async () => {
    expect((await w.as(seller, facetsRoute, 'review-queue/facets')).status).toBe(403);
    expect((await w.as(leader, facetsRoute, 'review-queue/facets?arrived_since=soon')).status).toBe(400);
    const theirs = await json(other.as(other.owner, facetsRoute, 'review-queue/facets'));
    expect(theirs.total).toBe(1);
    const mine = await json(w.as(leader, facetsRoute, `review-queue/facets?source_id=${other.source.agentId}`));
    expect(mine.total).toBe(0);
  });

  it('a data limit narrows the counts', async () => {
    await w.account('Hidden Co', hidden.agentId);
    const f = await json(w.as(limited, facetsRoute, 'review-queue/facets'));
    expect(f.sources.map((s: { value: string }) => s.value)).not.toContain(hidden.agentId);
  });
});

describe('/me/preferences/review-queue-columns', () => {
  const path = 'me/preferences/review-queue-columns';
  it('defaults, saves for the person only, and resets', async () => {
    const start = await json(w.as(leader, getColumns, path));
    expect(start).toMatchObject({ shown: 8, total: 12, is_default: true });
    const chosen = [...start.columns].reverse().map((c: { key: string }, i: number) => ({ key: c.key, visible: i < 3 }));
    const saved = await w.as(leader, putColumns, path, 'PUT', { columns: chosen });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ shown: 4, is_default: false, columns: [{ key: 'arrived', label: 'Arrived', visible: true }, expect.anything(), expect.anything(), { key: 'practice', visible: false }, ...Array(7).fill(expect.anything())] });
    expect((await json(w.as(leader, getColumns, path))).is_default).toBe(false);
    expect((await json(w.as(w.owner, getColumns, path))).is_default).toBe(true);
    expect((await json(other.as(other.owner, getColumns, path))).is_default).toBe(true);
    const reset = await w.as(leader, resetColumns, path, 'DELETE');
    expect(await reset.json()).toMatchObject({ is_default: true, shown: 8 });
  });

  it('refuses a list that leaves a column out or names an unknown one, a seller and an API key', async () => {
    const bad = await w.as(leader, putColumns, path, 'PUT', { columns: [{ key: 'tier', visible: true }] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).title).toBe('List every column once.');
    expect((await w.as(seller, getColumns, path)).status).toBe(403);
    const key = await keyFor(w.tenant, ['review:act']);
    expect((await call(getColumns, key, path)).status).toBe(403);
  });
});

describe('GET /accounts/{id}/review and /changes', () => {
  it('shows the status with who set it, stage dates, the open assignment with names, sources and version', async () => {
    const a = await w.sent({ name: 'Review Read Co' });
    await w.as(leader, patchReviewStatus, `accounts/${a}/review-status`, 'PATCH', { to: 'needs_review' });
    const assigned = await w.as(leader, accountAction, `accounts/${a}:assign`, 'POST', { seller_user_id: seller, notes: 'Start with the transit team.' });
    expect(assigned.status).toBe(202);
    await w.deliver();
    const res = await w.as(leader, reviewRoute, `accounts/${a}/review`);
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r).toMatchObject({
      account_id: a,
      status: { key: 'reviewed', label: 'Approved', color: 'green', set_by: 'reviewer', changed_by_name: 'Dana Leader' },
      stage: 'reviewed',
      stage_label: 'Reviewed',
      current_assignment: { seller_user_id: seller, seller_name: 'Sam Seller', assigned_by_name: 'Dana Leader', notes: 'Start with the transit team.', status: 'pending' },
      approved: { by_name: 'Dana Leader' },
      sources: [{ source_id: w.source.agentId, name: 'Reads Co Ash agent', kind: 'agent', via: 'Reads Co Ash', owner_name: null }],
      version: expect.any(Number),
    });
    expect(r.stages.map((s: { key: string }) => s.key)).toEqual(['arrived', 'reviewed', 'assigned', 'engaged', 'opportunity', 'won']);
    expect(r.stages[0].at).toEqual(expect.any(String));
    expect(r.stages[1]).toMatchObject({ current: true, at: expect.any(String) });
    // The seller sees the account assigned to them.
    expect((await w.as(seller, reviewRoute, `accounts/${a}/review`)).status).toBe(200);

    const changes = await json(w.as(leader, changesRoute, `accounts/${a}/changes`));
    const kinds = changes.data.map((c: { kind: string }) => c.kind);
    expect(kinds[kinds.length - 1]).toBe('arrived');
    expect(changes.data).toContainEqual(expect.objectContaining({ kind: 'status', field: 'review_status', from: 'Ready for review', to: 'In review', by_name: 'Dana Leader' }));
    expect(changes.data).toContainEqual(expect.objectContaining({ kind: 'assigned', to: 'Sam Seller', by_name: 'Dana Leader', note: 'Start with the transit team.' }));
    expect(changes.data).toContainEqual(expect.objectContaining({ kind: 'stage', from: 'Sent', to: 'Reviewed' }));
    expect(changes.data.find((c: { kind: string }) => c.kind === 'arrived')).toMatchObject({ to: 'Reads Co Ash agent' });
    const first = await json(w.as(leader, changesRoute, `accounts/${a}/changes?limit=2`));
    expect(first.data).toHaveLength(2);
    const second = await json(w.as(leader, changesRoute, `accounts/${a}/changes?limit=2&cursor=${first.next_cursor}`));
    expect(second.data[0].id).toBe(changes.data[2].id);
  });

  it('404 for another tenant, a hidden account and a seller without access; 403 without accounts:read; 400 for a bad cursor', async () => {
    const h = await w.account('Not Yours Co', hidden.agentId);
    for (const route of [reviewRoute, changesRoute]) {
      const path = (id: string) => `accounts/${id}/${route === reviewRoute ? 'review' : 'changes'}`;
      expect((await w.as(leader, route, path(otherAccount))).status).toBe(404);
      expect((await w.as(limited, route, path(h))).status).toBe(404);
      expect((await w.as(seller, route, path(h))).status).toBe(404);
      expect((await call(route, await keyFor(w.tenant, ['review:act']), path(h))).status).toBe(403);
    }
    expect((await w.as(leader, changesRoute, `accounts/${h}/changes?cursor=nope`)).status).toBe(400);
  });
});

describe('All accounts: GET /accounts, /accounts/facets, /accounts/export (screens.md §8)', () => {
  let src: { personId: string; agentId: string };
  let mine: string;
  let open: string;
  let sentBack: string;
  let won: string;

  beforeAll(async () => {
    src = await personAndAgent(w.tenant, 'Pipeline');
    mine = await w.sent({ name: 'Mine Co', city: 'Austin', region: 'TX' }, src.agentId);
    open = await w.sent({ name: 'Open Co' }, src.agentId);
    sentBack = await w.sent({ name: 'Back Co' }, src.agentId);
    won = await w.sent({ name: 'Won Co' }, src.agentId);
    await setSummary(w.tenant, mine, { priority: 40 });
    await setSummary(w.tenant, open, { priority: 90 });
    expect((await w.as(leader, accountAction, `accounts/${mine}:assign`, 'POST', { seller_user_id: seller })).status).toBe(202);
    expect((await w.as(leader, patchReviewStatus, `accounts/${sentBack}/review-status`, 'PATCH', { to: 'sent_back', reason_key: 'wrong_practice' })).status).toBe(200);
    await w.run(async (ctx) => {
      await ctx.tx.insert(deal).values({ id: newId('dea'), tenantId: ctx.tenantId, accountId: mine, system: 'hubspot', externalId: newId('evt'), name: 'Transit audit', status: 'open', amountCents: 4_800_000, currency: 'USD', openedAt: new Date() });
      await ctx.tx.insert(activity).values({ id: newId('cac'), tenantId: ctx.tenantId, accountId: mine, system: 'hubspot', externalId: newId('evt'), kind: 'reply', occurredAt: new Date('2026-08-02T10:00:00Z') });
      await ctx.tx.insert(stageChange).values({ id: newId('stc'), tenantId: ctx.tenantId, accountId: won, fromStage: 'opportunity', toStage: 'won', causeEventId: newId('evt') });
    });
    await w.deliver();
    await setSummary(w.tenant, won, { stage: 'won' });
  });

  it('rows carry the owner name, stage, source, CRM activity and value, with the total', async () => {
    const res = await w.as(leader, accountsRoute, `accounts?source_id=${src.agentId}&sort=stage_priority`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(4);
    const row = body.data.find((r: Row) => r.account_id === mine);
    expect(row).toMatchObject({
      name: 'Mine Co',
      hq_city: 'Austin',
      stage: 'reviewed',
      stage_label: 'Reviewed',
      review_status_label: 'Approved',
      owner_name: 'Sam Seller',
      source: { name: 'Pipeline agent' },
      last_activity: { kind: 'reply', at: '2026-08-02T10:00:00.000Z' },
      value: { amount_cents: 4_800_000, currency: 'USD', kind: 'open_deal', deal_name: 'Transit audit' },
      next_step: null,
    });
    // Sorted by stage, then priority: arrived (Open Co 90, then Back Co), reviewed, then won.
    expect(ids(body)).toEqual([open, sentBack, mine, won]);
  });

  it('filters by owner (me and unassigned), stage and the Other tab', async () => {
    const accepted = await json(w.as(seller, accountsRoute, 'accounts?owner_user_id=me'));
    expect(ids(accepted)).toContain(mine);
    expect(accepted.data.every((r: Row) => r.owner_user_id === seller)).toBe(true);
    const unassigned = await json(w.as(leader, accountsRoute, `accounts?source_id=${src.agentId}&unassigned=true`));
    expect(ids(unassigned).sort()).toEqual([open, sentBack, won].sort());
    const arrived = await json(w.as(leader, accountsRoute, `accounts?source_id=${src.agentId}&stage=arrived`));
    expect(ids(arrived)).toEqual([open]);
    const others = await json(w.as(leader, accountsRoute, `accounts?source_id=${src.agentId}&stage=other`));
    expect(ids(others)).toEqual([sentBack]);
    expect((await w.as(leader, accountsRoute, 'accounts?sort=sideways')).status).toBe(400);
    expect((await w.as(leader, accountsRoute, 'accounts?unassigned=maybe')).status).toBe(400);
    expect((await call(accountsRoute, await keyFor(w.tenant, ['accounts:read']), 'accounts?owner_user_id=me')).status).toBe(400);
  });

  it('facets give stage tabs with Other, owners with Unassigned, sources and won this year', async () => {
    const res = await w.as(leader, accountFacetsRoute, `accounts/facets?source_id=${src.agentId}`);
    expect(res.status).toBe(200);
    const f = await res.json();
    expect(f.total).toBe(4);
    expect(f.stages).toEqual([
      { key: 'arrived', label: 'Sent', count: 1 },
      { key: 'reviewed', label: 'Reviewed', count: 1 },
      { key: 'assigned', label: 'Assigned', count: 0 },
      { key: 'engaged', label: 'Engaged', count: 0 },
      { key: 'opportunity', label: 'Opportunity', count: 0 },
      { key: 'won', label: 'Won', count: 1 },
      { key: 'other', label: 'Other', count: 1 },
    ]);
    expect(f.won_this_year).toBeGreaterThanOrEqual(1);
    expect(f.owners).toContainEqual({ value: seller, label: 'Sam Seller', count: 1 });
    expect(f.owners[f.owners.length - 1]).toEqual({ value: 'unassigned', label: 'Unassigned', count: 3 });
    expect(f.sources).toContainEqual({ value: src.agentId, label: 'Pipeline agent', count: 4 });
    expect((await w.as(leader, accountFacetsRoute, 'accounts/facets?sort=up')).status).toBe(400);
    expect((await call(accountFacetsRoute, await keyFor(w.tenant, ['review:act']), 'accounts/facets')).status).toBe(403);
    const theirs = await json(other.as(other.owner, accountFacetsRoute, `accounts/facets?source_id=${src.agentId}`));
    expect(theirs.total).toBe(0);
  });

  it('exports the same rows as CSV', async () => {
    const res = await w.as(leader, exportRoute, `accounts/export?source_id=${src.agentId}&sort=stage_priority`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('scout-accounts.csv');
    expect(res.headers.get('x-scout-row-count')).toBe('4');
    const lines = (await res.text()).trim().split('\r\n');
    expect(lines[0]).toBe('Account,Domain,Industry,City,State,Stage,Review status,Owner,Best offer,Practice,Priority,Tier,Source,Last activity,Last activity at,Value,Currency,Value kind');
    expect(lines).toHaveLength(5);
    expect(lines[3]).toContain('Mine Co');
    expect(lines[3]).toContain('48000.00,USD,Open deal');
    expect((await w.as(leader, exportRoute, 'accounts/export?domain=not a domain')).status).toBe(400);
    expect((await call(exportRoute, await keyFor(w.tenant, ['review:act']), 'accounts/export')).status).toBe(403);
    const theirs = await other.as(other.owner, exportRoute, `accounts/export?source_id=${src.agentId}`);
    expect(theirs.headers.get('x-scout-row-count')).toBe('0');
  });
});

describe('All accounts: estimated value (Ruling 13)', () => {
  let src: { personId: string; agentId: string };
  let estimated: string;
  let withDeal: string;
  let noPotential: string;

  const score = (tenantId: string, accountId: string, revenuePotentialCents: number | null) => ({
    tenantId,
    accountId,
    fit: 50,
    intent: 50,
    matchTotal: 50,
    priority: 50,
    tier: 'warm',
    tierReason: 'computed',
    scoredTier: 'warm',
    revenuePotentialCents,
    revenueBand: revenuePotentialCents === null ? null : 'medium',
    explanation: {},
    inputsHash: 'h',
    profileVersion: 1,
  });

  beforeAll(async () => {
    src = await personAndAgent(w.tenant, 'Estimator');
    estimated = await w.sent({ name: 'Estimated Co' }, src.agentId);
    withDeal = await w.sent({ name: 'Deal Co' }, src.agentId);
    noPotential = await w.sent({ name: 'No Size Co' }, src.agentId);
    await w.run(async (ctx) => {
      await ctx.tx.delete(accountScore).where(inArray(accountScore.accountId, [estimated, withDeal, noPotential]));
      await ctx.tx.insert(accountScore).values([score(ctx.tenantId, estimated, 7_500_000), score(ctx.tenantId, withDeal, 9_900_000), score(ctx.tenantId, noPotential, null)]);
      await ctx.tx.insert(deal).values({ id: newId('dea'), tenantId: ctx.tenantId, accountId: withDeal, system: 'hubspot', externalId: newId('evt'), name: 'Real deal', status: 'open', amountCents: 1_200_000, currency: 'USD', openedAt: new Date() });
    });
  });

  it('a row with no deal shows the best offer deal size as an estimate; a deal wins; no deal size shows nothing', async () => {
    const body = await json(w.as(leader, accountsRoute, `accounts?source_id=${src.agentId}`));
    const by = (id: string) => body.data.find((r: Row) => r.account_id === id);
    expect(by(estimated).value).toEqual({ amount_cents: 7_500_000, currency: 'USD', kind: 'estimated', deal_name: null });
    expect(by(withDeal).value).toMatchObject({ amount_cents: 1_200_000, kind: 'open_deal' });
    expect(by(noPotential).value).toBeNull();
  });

  it('the CSV value kind is Estimated', async () => {
    const lines = (await (await w.as(leader, exportRoute, `accounts/export?source_id=${src.agentId}`)).text()).trim().split('\r\n');
    expect(lines.find((l) => l.includes('Estimated Co'))).toContain('75000.00,USD,Estimated');
  });
});
