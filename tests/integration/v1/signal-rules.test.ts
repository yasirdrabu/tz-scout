import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as offerAction } from '@/http/routes/v1/offers/[id]/route';
import { GET as getRules, PUT as putRules } from '@/http/routes/v1/offers/[id]/signal-rules/route';
import { GET as getSignalTypes } from '@/http/routes/v1/signal-types/route';
import { approveOffer, createOffer, createPractice, listSignalRules } from '@/modules/offers';
import { SYSTEM_GRANTOR, createApiKey, setPrincipalCacheTtl } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import { completeOffer, freshTenant } from '../offers/helpers';

afterAll(closeDbs);

let t: Awaited<ReturnType<typeof freshTenant>>;
let practiceId: string;
let readKey: string;
let manageKey: string;
let scoringKey: string;

const key = (scopes: string[]) =>
  t
    .run((ctx) => createApiKey(ctx, { name: 'k', environment: 'live', scopes: scopes as never }, SYSTEM_GRANTOR))
    .then((k) => k.secret);

beforeAll(async () => {
  t = await freshTenant();
  practiceId = (await t.run((ctx) => createPractice(ctx, { name: 'Main' }))).id;
  readKey = await key(['offers:read']);
  manageKey = await key(['offers:read', 'offers:manage']);
  scoringKey = await key(['offers:read', 'scoring:manage']);
});
beforeEach(() => setPrincipalCacheTtl(0));

const call = (h: (r: Request) => Promise<Response>, secret: string, path: string, method = 'GET', body?: unknown) =>
  h(
    new Request(`http://x/v1/${path}`, {
      method,
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const draft = (name: string, extra: Record<string, unknown> = {}) =>
  t.run((ctx) => createOffer(ctx, { name, practiceId, ...completeOffer, ...extra }));

const rule = (over: Record<string, unknown> = {}) => ({
  type: 'intent',
  label: 'Researching',
  weight: 40,
  match: ['ai strategy'],
  min_value: 0.6,
  why: 'They are researching the problem.',
  enabled: true,
  ...over,
});

describe('signal rules on /v1', () => {
  it('AC0: PUT needs scoring:manage', async () => {
    const o = await draft('Locked');
    const before = await t.run((ctx) => listSignalRules(ctx, o.id));
    expect((await call(putRules, readKey, `offers/${o.id}/signal-rules`, 'PUT', { rules: [rule()] })).status).toBe(403);
    expect((await call(putRules, manageKey, `offers/${o.id}/signal-rules`, 'PUT', { rules: [rule()] })).status).toBe(403);
    expect(await t.run((ctx) => listSignalRules(ctx, o.id))).toEqual(before);
  });

  it('PUT replaces the rules and GET shows them in snake_case', async () => {
    const o = await draft('Editable');
    const res = await call(putRules, scoringKey, `offers/${o.id}/signal-rules`, 'PUT', {
      rules: [rule({ label: 'A' }), rule({ label: 'B', min_value: null, enabled: false })],
    });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.map((r: { label: string }) => r.label)).toEqual(['A', 'B']);
    expect(data[0]).toMatchObject({ offer_id: o.id, min_value: 0.6, weight: 40, match: ['ai strategy'], origin: 'manual', sort: 0 });
    expect(data[1]).toMatchObject({ min_value: null, enabled: false, sort: 1 });
    const got = await (await call(getRules, manageKey, `offers/${o.id}/signal-rules`)).json();
    expect(got.data).toHaveLength(2);
  });

  it('AC4: an empty why is a 400 with the message, and unknown fields are refused', async () => {
    const o = await draft('Why');
    const res = await call(putRules, scoringKey, `offers/${o.id}/signal-rules`, 'PUT', { rules: [rule({ why: '' })] });
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toEqual([{ path: 'rules.0.why', message: 'Add why this signal matters.' }]);
    const extra = await call(putRules, scoringKey, `offers/${o.id}/signal-rules`, 'PUT', { rules: [rule({ origin: 'default' })] });
    expect(extra.status).toBe(400);
    expect((await call(putRules, scoringKey, `offers/off_nope/signal-rules`, 'PUT', { rules: [] })).status).toBe(404);
  });

  it('GET hides the rules of a draft from a read-only key', async () => {
    const d = await draft('Hidden draft');
    expect((await call(getRules, readKey, `offers/${d.id}/signal-rules`)).status).toBe(404);
    expect((await call(getRules, manageKey, `offers/${d.id}/signal-rules`)).status).toBe(200);
    const a = await draft('Visible');
    await t.run((ctx) => approveOffer(ctx, a.id));
    expect((await call(getRules, readKey, `offers/${a.id}/signal-rules`)).status).toBe(200);
  });

  it(':reset-signal-rules needs scoring:manage and restores the defaults', async () => {
    const o = await draft('Modernization Blueprint', { slug: 'modernization-blueprint' });
    await call(putRules, scoringKey, `offers/${o.id}/signal-rules`, 'PUT', { rules: [rule({ label: 'Mine' })] });
    expect((await call(offerAction, manageKey, `offers/${o.id}:reset-signal-rules`, 'POST')).status).toBe(403);
    const res = await call(offerAction, scoringKey, `offers/${o.id}:reset-signal-rules`, 'POST');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toHaveLength(6);
    expect(data.every((r: { origin: string }) => r.origin === 'default')).toBe(true);
  });

  it('keeps :archive on offers:manage and 404s unknown actions', async () => {
    const o = await draft('Archive me');
    expect((await call(offerAction, scoringKey, `offers/${o.id}:archive`, 'POST')).status).toBe(403);
    expect((await call(offerAction, manageKey, `offers/${o.id}:archive`, 'POST')).status).toBe(200);
    expect((await call(offerAction, scoringKey, `offers/${o.id}:explode`, 'POST')).status).toBe(404);
  });
});

describe('OFF-E4-S2 signal guide', () => {
  it('AC1: lists the nine types with plain explanations', async () => {
    const res = await call(getSignalTypes, readKey, 'signal-types');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.map((s: { type: string }) => s.type).sort()).toEqual(
      ['intent', 'leadership', 'funding', 'news', 'risk', 'hiring', 'growth', 'workforce', 'tech'].sort(),
    );
    const intent = data.find((s: { type: string }) => s.type === 'intent');
    expect(intent).toMatchObject({ label: 'Researching', kind: 'research' });
    for (const s of data) {
      expect(s.what.length).toBeGreaterThan(10);
      expect(s.read.length).toBeGreaterThan(10);
    }
  });

  it('is closed to a key without offers:read', async () => {
    const none = await key(['accounts:read']);
    expect((await call(getSignalTypes, none, 'signal-types')).status).toBe(403);
  });
});
