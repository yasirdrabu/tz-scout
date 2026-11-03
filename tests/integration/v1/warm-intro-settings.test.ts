import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as getSettings, PUT as putSettings } from '@/http/routes/v1/settings/warm-intros/route';
import { setPrincipalCacheTtl } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import { call, keyFor } from './intake-helpers';
import { workspace, type Workspace } from './review-helpers';

let w: Workspace;
let operator: string;
let seller: string;
const json = async (res: Response | Promise<Response>) => (await res).json();

type Settings = { relationships: { key: string; points: number }[]; rules: { id: string; introducer_user_id?: string }[]; introducers: unknown[]; rescoring_account_count?: number };
const get = (who = w.owner) => json(w.as(who, getSettings, 'settings/warm-intros')) as Promise<Settings>;
const put = (body: unknown, who = w.owner) => w.as(who, putSettings, 'settings/warm-intros', 'PUT', body);
const rels = async () => (await get()).relationships.map(({ key, points }) => ({ key, points }));

beforeAll(async () => {
  w = await workspace('Warm Settings Co');
  operator = await w.person('operator', { name: 'Olive Operator' });
  seller = await w.person('seller', { name: 'Sam Seller' });
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

describe('GET and PUT /settings/warm-intros (SRC-E5-S2)', () => {
  it('an owner and an operator read the tab in snake case; a seller is refused', async () => {
    const s = await get();
    expect(s.relationships.map((r) => r.key)).toContain('employee_network');
    expect(s.relationships[0]).toEqual({ key: expect.any(String), label: expect.any(String), points: expect.any(Number), intro_count: 0 });
    expect(s.rules).toEqual([]);
    expect(Array.isArray(s.introducers)).toBe(true);
    expect((await w.as(operator, getSettings, 'settings/warm-intros')).status).toBe(200);
    expect((await w.as(seller, getSettings, 'settings/warm-intros')).status).toBe(403);
    expect((await put({ relationships: [], rules: [] }, seller)).status).toBe(403);
  });

  it('saves relationship points and rules (a member and an outside person), and reads them back', async () => {
    const before = await rels();
    const res = await put(
      {
        relationships: before.map((r) => (r.key === 'employee_network' ? { ...r, points: 11 } : r)),
        rules: [
          { introducer_user_id: seller, relationship_key: 'employee_network', points: 15 },
          { id: null, introducer_email: 'Pat@Outside.example.com', introducer_name: 'Pat Outside', relationship_key: 'other', points: 1 },
        ],
      },
      operator,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Settings & { rules: Record<string, unknown>[] };
    expect(body.rescoring_account_count).toBe(0);
    expect(body.relationships.find((r) => r.key === 'employee_network')!.points).toBe(11);
    expect(body.rules).toHaveLength(2);
    expect(body.rules).toContainEqual(expect.objectContaining({ introducer_user_id: seller, introducer_name: 'Sam Seller', relationship_key: 'employee_network', points: 15 }));
    expect(body.rules).toContainEqual(expect.objectContaining({ introducer_email: 'pat@outside.example.com', introducer_name: 'Pat Outside', points: 1 }));
    expect((await get()).rules).toHaveLength(2);

    // Rules in the body replace the stored ones: a rule left out is deleted.
    const keep = body.rules.find((r) => r.introducer_user_id === seller)!;
    const second = await put({ relationships: await rels(), rules: [{ id: keep.id, introducer_user_id: seller, relationship_key: 'employee_network', points: 16 }] });
    expect(second.status).toBe(200);
    expect((await get()).rules).toEqual([expect.objectContaining({ id: keep.id, points: 16 })]);
  });

  it('an agent key is refused for reading (it lists member emails) and saving (people only)', async () => {
    const key = await keyFor(w.tenant, ['scoring:manage']);
    expect((await call(getSettings, key, 'settings/warm-intros')).status).toBe(403);
    const res = await call(putSettings, key, 'settings/warm-intros', { method: 'PUT', body: { relationships: [], rules: [] } });
    expect(res.status).toBe(403);
  });

  it('a bad save is a 400 with errors[] at the field and saves nothing', async () => {
    const before = await get();
    const base = await rels();
    const bad = await put({
      relationships: base,
      rules: [
        { introducer_user_id: seller, relationship_key: 'employee_network', points: 5 },
        { introducer_email: 'x@outside.example.com', introducer_name: 'X', relationship_key: 'other', points: 5 },
        { introducer_user_id: seller, relationship_key: 'other', points: 21 },
      ],
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).errors).toEqual([{ path: 'rules[2].points', message: 'Points must be a whole number from 0 to 20.' }]);

    const missing = await put({ relationships: base, rules: [{ introducer_email: 'nobody@outside.example.com', relationship_key: 'other', points: 5 }] });
    expect(missing.status).toBe(400);
    expect((await missing.json()).errors).toEqual([{ path: 'rules[0].introducer_name', message: "Enter the person's name and email." }]);

    const dup = await put({
      relationships: base,
      rules: [
        { introducer_user_id: seller, relationship_key: 'employee_network', points: 5 },
        { introducer_user_id: seller, relationship_key: 'employee_network', points: 6 },
      ],
    });
    expect(dup.status).toBe(400);
    expect((await dup.json()).errors).toEqual([{ path: 'rules[1].relationship_key', message: 'Sam Seller already has a rule for someone on our team knows them.' }]);

    expect((await put({ relationships: base, rules: [], extra: 1 })).status).toBe(400);
    expect(await get()).toEqual(before);
  });
});
