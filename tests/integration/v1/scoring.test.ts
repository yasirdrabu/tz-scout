import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { GET as getHistory } from '@/app/v1/accounts/[id]/score/history/route';
import { GET as getMatches } from '@/app/v1/accounts/[id]/matches/route';
import { GET as getScore } from '@/app/v1/accounts/[id]/score/route';
import { POST as rescore } from '@/app/v1/rescore/route';
import { POST as resetProfile } from '@/app/v1/scoring/profile/reset/route';
import { GET as getProfile, PUT as putProfile } from '@/app/v1/scoring/profile/route';
import { upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { approveOffer, createOffer, createPractice, replaceSignalRules } from '@/modules/offers';
import { scoreAccount } from '@/modules/scoring';
import { setPrincipalCacheTtl, type Permission } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { completeOffer } from '../offers/helpers';
import { call, freshTenant, keyFor, personAndAgent } from './intake-helpers';

afterAll(closeDbs);
beforeEach(() => setPrincipalCacheTtl(0));

const READ: Permission[] = ['accounts:read'];
const MANAGE: Permission[] = ['accounts:read', 'scoring:manage'];
const ALL = { dataLimit: { kind: 'all' } } as const;
const domain = () => `${newId('acc').slice(-10).toLowerCase()}-example.com`;

const arrival = (agentSourceId: string, over: Partial<ArrivalForAccounts> = {}): ArrivalForAccounts => ({
  arrivalId: newId('arr'),
  receivedAt: new Date('2026-10-26T15:00:00Z'),
  sourceChain: { agentSourceId },
  account: { name: 'Score Co', domain: domain(), industry: 'Logistics' },
  people: [],
  signals: [{ kind: 'trigger', type: 'funding', title: 'Series B', occurredAt: new Date() }],
  facts: [],
  research: {},
  soleProprietor: false,
  externalIds: [],
  ...over,
});

/** A tenant with two approved offers (the first fits the account, the second does not), two agents and a scored account for each. */
async function world() {
  const t = await freshTenant();
  await runOutbox(t.tenantId);
  const practice = await t.run((ctx) => createPractice(ctx, { name: 'V1 Practice', slug: `p-${newId('prc').slice(-8).toLowerCase()}` }));
  const best = await t.run((ctx) => createOffer(ctx, { name: 'Best Offer', practiceId: practice.id, ...completeOffer }));
  const other = await t.run((ctx) => createOffer(ctx, { name: 'Other Offer', practiceId: practice.id, ...completeOffer, industries: ['healthcare'] }));
  for (const o of [best, other]) await t.run((ctx) => approveOffer(ctx, o.id));
  await t.run((ctx) =>
    replaceSignalRules(ctx, best.id, [
      { type: 'funding', label: 'Fresh funding', weight: 40, match: [], minValue: null, why: 'Money to spend.', enabled: true },
      { type: 'leadership', label: 'New leader', weight: 30, match: [], minValue: null, why: 'A new leader buys.', enabled: true },
    ]),
  );
  const ash = await personAndAgent(t, 'Ash');
  const bo = await personAndAgent(t, 'Bo');
  const mine = await t.run((ctx) => upsertFromArrival(ctx, arrival(ash.agentId)));
  const theirs = await t.run((ctx) => upsertFromArrival(ctx, arrival(bo.agentId)));
  await runOutbox(t.tenantId);
  for (const a of [mine, theirs]) await t.run((ctx) => scoreAccount(ctx, a.accountId, 'manual_rescore'));
  await runOutbox(t.tenantId);
  return { t, practice, best, other, ash, bo, mine: mine.accountId, theirs: theirs.accountId };
}

const json = async (res: Response) => res.json();
const READS = [
  [getScore, 'score'],
  [getMatches, 'matches'],
  [getHistory, 'score/history'],
] as const;

describe('GET /v1/accounts/{id}/score', () => {
  it('SCO-E4-S2-AC3: the explanation in snake_case, with would_raise and a summary', async () => {
    const w = await world();
    const key = await keyFor(w.t, READ, ALL);
    const res = await call(getScore, key, `accounts/${w.mine}/score`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({
      account_id: w.mine,
      offer: { id: w.best.id, name: 'Best Offer' },
      best_offer: { id: w.best.id, name: 'Best Offer' },
      tier_reason: 'computed',
      warm_intro_points: 0,
      profile_version: expect.any(Number),
      computed_at: expect.any(String),
    });
    expect(body.lines.map((l: { group: string }) => l.group)).toEqual(expect.arrayContaining(['fit', 'intent', 'combine']));
    expect(body.lines.find((l: { group: string }) => l.group === 'intent')).toMatchObject({ label: 'Fresh funding', kind: 'trigger', signal_ids: [expect.stringMatching(/^sig_/)] });
    expect(body.other_offers).toEqual([expect.objectContaining({ id: w.other.id, name: 'Other Offer' })]);
    expect(body.would_raise).toContain('A signal for New leader');
    expect(body.summary).toMatch(new RegExp(`for Best Offer \\(priority ${body.priority}\\): .*\\.$`));
    for (const k of Object.keys(body)) expect(k).toBe(k.toLowerCase());
  });

  it('SCO-E4-S2-AC4: offer_id explains a non-best offer by its match and names the best offer', async () => {
    const w = await world();
    const key = await keyFor(w.t, READ, ALL);
    const best = await json(await call(getScore, key, `accounts/${w.mine}/score`));
    const res = await call(getScore, key, `accounts/${w.mine}/score?offer_id=${w.other.id}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    const matches = (await json(await call(getMatches, key, `accounts/${w.mine}/matches`))).data;
    const m = matches.find((x: { offer_id: string }) => x.offer_id === w.other.id);
    expect(body).toMatchObject({
      offer: { id: w.other.id, name: 'Other Offer' },
      best_offer: { id: w.best.id, name: 'Best Offer' },
      priority: m.match_total,
      fit: m.fit,
      intent: m.intent,
      tier: m.tier,
      warm_intro_points: 0,
    });
    expect(body.lines.some((l: { group: string }) => l.group === 'adjust')).toBe(false);
    expect(body.summary).toContain('for Other Offer');
    expect(body.priority).toBeLessThanOrEqual(best.priority);
    // The best offer asked for by id is the plain explanation, and an unknown offer is a 404.
    expect(await json(await call(getScore, key, `accounts/${w.mine}/score?offer_id=${w.best.id}`))).toEqual(best);
    expect((await call(getScore, key, `accounts/${w.mine}/score?offer_id=off_nope`)).status).toBe(404);
  });

  it('Review Focus 5: a hidden or missing account is a 404 on score, matches and history, never a 403', async () => {
    const w = await world();
    const key = await keyFor(w.t, READ, { dataLimit: { kind: 'own_source' }, sourceId: w.ash.agentId });
    for (const [handler, path] of READS) {
      expect((await call(handler, key, `accounts/${w.mine}/${path}`)).status).toBe(200);
      for (const id of [w.theirs, 'acc_missing']) {
        const res = await call(handler, key, `accounts/${id}/${path}`);
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toContain('application/problem+json');
      }
    }
  });

  it('needs accounts:read', async () => {
    const w = await world();
    const key = await keyFor(w.t, ['arrivals:read'], ALL);
    for (const [handler, path] of READS) expect((await call(handler, key, `accounts/${w.mine}/${path}`)).status).toBe(403);
  });
});

describe('matches and history', () => {
  it('lists a match per approved offer, best first', async () => {
    const w = await world();
    const key = await keyFor(w.t, READ, ALL);
    const { data } = await json(await call(getMatches, key, `accounts/${w.mine}/matches`));
    expect(data.map((m: { offer_id: string }) => m.offer_id)).toEqual([w.best.id, w.other.id]);
    expect(data[0]).toMatchObject({ account_id: w.mine, match_total: expect.any(Number), fit_parts: expect.any(Array), rule_hits: expect.any(Array) });
    expect(data[0]).not.toHaveProperty('tenant_id');
  });

  it('SCO-E4-S3-AC1: history is newest first with the cause in words, and limit is 1 to 50', async () => {
    const w = await world();
    await w.t.run((ctx) => replaceSignalRules(ctx, w.best.id, []));
    await w.t.run((ctx) => scoreAccount(ctx, w.mine, 'rules_changed'));
    const key = await keyFor(w.t, READ, ALL);
    const { data } = await json(await call(getHistory, key, `accounts/${w.mine}/score/history`));
    expect(data.length).toBeGreaterThanOrEqual(2);
    expect(data[0]).toMatchObject({ cause: 'rules_changed', cause_text: 'The scoring settings changed.', from_priority: expect.any(Number), to_priority: expect.any(Number), at: expect.any(String) });
    expect(data[data.length - 1]).toMatchObject({ from_priority: null });
    for (const c of data) expect(c.cause_text).toMatch(/\.$/);
    expect((await json(await call(getHistory, key, `accounts/${w.mine}/score/history?limit=1`))).data).toHaveLength(1);
    for (const bad of ['0', '51', 'abc', '1.5']) {
      expect((await call(getHistory, key, `accounts/${w.mine}/score/history?limit=${bad}`)).status).toBe(400);
    }
    expect((await call(getHistory, key, `accounts/${w.mine}/score/history?limit=50`)).status).toBe(200);
  });
});

describe('TEN-E3-S1-AC2: each data limit kind on score, matches and history', () => {
  it('shows only what the limit allows', async () => {
    const w = await world();
    const kinds: { name: string; limit: unknown; source?: string; ash: boolean; bo: boolean }[] = [
      { name: 'all', limit: { kind: 'all' }, ash: true, bo: true },
      { name: 'own_source', limit: { kind: 'own_source' }, source: w.ash.agentId, ash: true, bo: false },
      { name: 'sources', limit: { kind: 'sources', ids: [w.bo.agentId] }, ash: false, bo: true },
      { name: 'practices (in)', limit: { kind: 'practices', ids: [w.practice.id] }, ash: true, bo: true },
      { name: 'practices (out)', limit: { kind: 'practices', ids: ['prc_none'] }, ash: false, bo: false },
      { name: 'own_accounts', limit: { kind: 'own_accounts' }, ash: false, bo: false },
      { name: 'any_of', limit: { kind: 'any_of', limits: [{ kind: 'own_source' }, { kind: 'sources', ids: [w.bo.agentId] }] }, source: w.ash.agentId, ash: true, bo: true },
    ];
    for (const k of kinds) {
      const key = await keyFor(w.t, READ, { dataLimit: k.limit as never, ...(k.source ? { sourceId: k.source } : {}) });
      for (const [id, sees] of [
        [w.mine, k.ash],
        [w.theirs, k.bo],
      ] as const) {
        for (const [handler, path] of READS) {
          const res = await call(handler, key, `accounts/${id}/${path}`);
          expect([k.name, path, res.status]).toEqual([k.name, path, sees ? 200 : 404]);
        }
      }
    }
  });
});

describe('scoring profile', () => {
  it('needs scoring:manage', async () => {
    const w = await world();
    const key = await keyFor(w.t, READ, ALL);
    expect((await call(getProfile, key, 'scoring/profile')).status).toBe(403);
    expect((await call(putProfile, key, 'scoring/profile', { method: 'PUT', body: { half_life_days: 30 } })).status).toBe(403);
    expect((await call(resetProfile, key, 'scoring/profile/reset', { method: 'POST', body: {} })).status).toBe(403);
    expect((await call(rescore, key, 'rescore', { body: {} })).status).toBe(403);
  });

  it('GET shows the defaults in snake_case; PUT validates in plain words and saves with 202', async () => {
    const w = await world();
    const key = await keyFor(w.t, MANAGE, ALL);
    const got = await json(await call(getProfile, key, 'scoring/profile'));
    expect(got).toMatchObject({
      fit_weight: 0.55,
      half_life_days: 45,
      tier_thresholds: { not_fit_below: 40, act_now: { fit: 60, intent: 35, total: 60 }, good_fit: { fit: 60 } },
      version: expect.any(Number),
    });

    const put = (body: unknown) => call(putProfile, key, 'scoring/profile', { method: 'PUT', body });
    const bad = await put({ fit_parts: { industry: 50 } });
    expect(bad.status).toBe(400);
    expect((await json(bad)).errors).toEqual([{ path: 'fitParts', message: 'The fit parts must add up to 100.' }]);
    expect((await put({ fit_weight: 0, intent_weight: 0 })).status).toBe(400);
    expect((await put({ half_life_days: 'x' })).status).toBe(400);
    expect((await put({ nope: 1 })).status).toBe(400);

    const res = await put({ half_life_days: 30, tier_thresholds: { act_now: { total: 70 } } });
    expect(res.status).toBe(202);
    const saved = await json(res);
    expect(saved).toMatchObject({
      half_life_days: 30,
      version: got.version + 1,
      tier_thresholds: { not_fit_below: 40, act_now: { fit: 60, intent: 35, total: 70 } },
    });
    expect(await json(await call(getProfile, key, 'scoring/profile'))).toEqual(saved);
  });

  it('a PUT changes tiers once the jobs have run, and reset puts the defaults back', async () => {
    const w = await world();
    const reader = await keyFor(w.t, READ, ALL);
    const key = await keyFor(w.t, MANAGE, ALL);
    const before = await json(await call(getScore, reader, `accounts/${w.mine}/score`));
    expect(before.tier).not.toBe('not_fit');
    const put = await call(putProfile, key, 'scoring/profile', { method: 'PUT', body: { tier_thresholds: { not_fit_below: 100 } } });
    expect(put.status).toBe(202);
    await runOutbox(w.t.tenantId);
    const after = await json(await call(getScore, reader, `accounts/${w.mine}/score`));
    expect(after.tier).toBe('not_fit');
    expect(after.profile_version).toBe(before.profile_version + 1);

    const reset = await call(resetProfile, key, 'scoring/profile/reset', { method: 'POST', body: {} });
    expect(reset.status).toBe(202);
    expect((await json(reset)).tier_thresholds.not_fit_below).toBe(40);
    await runOutbox(w.t.tenantId);
    expect((await json(await call(getScore, reader, `accounts/${w.mine}/score`))).tier).toBe(before.tier);
  });
});

describe('POST /v1/rescore', () => {
  it('returns 202 with a job id, for the tenant, a practice or a source', async () => {
    const w = await world();
    const key = await keyFor(w.t, MANAGE, ALL);
    for (const body of ['', {}, { practice_id: w.practice.id }, { source_id: w.ash.agentId }]) {
      const res = await call(rescore, key, 'rescore', { method: 'POST', body });
      expect(res.status).toBe(202);
      expect(await json(res)).toEqual({ job_id: expect.any(String) });
    }
    await runOutbox(w.t.tenantId);
  });

  it('refuses both a practice and a source, and unknown fields', async () => {
    const w = await world();
    const key = await keyFor(w.t, MANAGE, ALL);
    const both = await call(rescore, key, 'rescore', { body: { practice_id: w.practice.id, source_id: w.ash.agentId } });
    expect(both.status).toBe(400);
    expect((await json(both)).title).toBe('Choose a practice or a source, not both.');
    expect((await call(rescore, key, 'rescore', { body: { nope: 1 } })).status).toBe(400);
  });
});
