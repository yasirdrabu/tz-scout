import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as listRoute, POST as addRoute } from '@/http/routes/v1/costs/lines/route';
import { PATCH as editRoute, POST as actionRoute } from '@/http/routes/v1/costs/lines/[id]/route';
import { GET as budgetsRoute, PUT as saveBudgetsRoute } from '@/http/routes/v1/costs/budgets/route';
import { GET as summaryRoute } from '@/http/routes/v1/costs/summary/route';
import { GET as bySourceRoute } from '@/http/routes/v1/costs/by-source/route';
import { PUT as targetRoute } from '@/http/routes/v1/costs/target/route';
import { addManualLine, recordLine } from '@/modules/analytics';
import { registerSource, removeSource } from '@/modules/intake';
import { SYSTEM_GRANTOR, addMember, createApiKey, setPrincipalCacheTtl, type Role } from '@/modules/tenancy';
import { newId } from '@/platform/ids';
import { inTenant, seedUser } from '../tenancy/helpers';
import { signedIn, tenantOwnedBy, v1Req, type Person, type ReqOpts } from './session-helpers';

const people: Partial<Record<Role, Person>> = {};
const cookies: Record<string, Headers> = {};
let t: { tenantId: string; slug: string };

beforeAll(async () => {
  const admin = await seedUser({ admin: true, signedIn: true });
  people.owner = await seedUser({ signedIn: true });
  t = await tenantOwnedBy(admin, people.owner.email);
  for (const role of ['leader', 'operator', 'seller', 'viewer'] as const) {
    const p = (people[role] = await seedUser({ signedIn: true }));
    await inTenant(t.tenantId, people.owner.actor, (ctx) => addMember(ctx, { email: p.email, role }));
  }
  for (const p of Object.values(people)) cookies[p.id] = await signedIn(p.id);
});
beforeEach(() => setPrincipalCacheTtl(0));

const as = (role: Role, path: string, opts: Omit<ReqOpts, 'cookies' | 'tenant'> = {}) =>
  v1Req(path, { ...opts, cookies: cookies[people[role]!.id], tenant: t.slug });
const run = <T>(fn: Parameters<typeof inTenant<T>>[2]) => inTenant(t.tenantId, people.owner!.actor, fn);
const manual = (over: Record<string, unknown> = {}) => ({ occurred_on: '2026-11-02', category: 'partner_fees', amount_cents: 12_500, note: 'Referral fee', ...over });

describe('access', () => {
  it('a seller gets 403 on every /costs/lines route', async () => {
    const line = await run((ctx) => addManualLine(ctx, { occurredOn: '2026-11-02', category: 'partner_fees', amountCents: 100, note: null }));
    const responses = [
      await listRoute(as('seller', '/costs/lines')),
      await addRoute(as('seller', '/costs/lines', { method: 'POST', body: manual() })),
      await editRoute(as('seller', `/costs/lines/${line.id}`, { method: 'PATCH', body: { amount_cents: 1 } })),
      await actionRoute(as('seller', `/costs/lines/${line.id}:void`, { method: 'POST', body: { reason: 'No' } })),
    ];
    expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403]);
  });

  it('an operator can read and add; a viewer cannot read', async () => {
    expect((await listRoute(as('operator', '/costs/lines'))).status).toBe(200);
    const res = await addRoute(as('operator', '/costs/lines', { method: 'POST', body: manual() }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ origin: 'manual', category: 'partner_fees', amount_cents: 12_500, occurred_on: '2026-11-02', note: 'Referral fee', created_by: people.operator!.id });
    expect((await listRoute(as('viewer', '/costs/lines'))).status).toBe(403);
  });

  it('an API key with costs:write can neither add, edit nor void a line', async () => {
    const line = await run((ctx) => addManualLine(ctx, { occurredOn: '2026-11-02', category: 'partner_fees', amountCents: 100, note: null }));
    const { secret } = await run((ctx) => createApiKey(ctx, { name: 'k', environment: 'live', scopes: ['costs:write', 'costs:read'] }, SYSTEM_GRANTOR));
    const key = (path: string, method: string, body: unknown) =>
      new Request(`http://localhost:4240/api/v1${path}`, { method, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await addRoute(key('/costs/lines', 'POST', manual()))).status).toBe(403);
    expect((await editRoute(key(`/costs/lines/${line.id}`, 'PATCH', { amount_cents: 1 }))).status).toBe(403);
    expect((await actionRoute(key(`/costs/lines/${line.id}:void`, 'POST', { reason: 'No' }))).status).toBe(403);
  });
});

describe('validation and changes', () => {
  it('an amount of 0 gets "Enter an amount above zero."', async () => {
    const res = await addRoute(as('owner', '/costs/lines', { method: 'POST', body: manual({ amount_cents: 0 }) }));
    expect(res.status).toBe(400);
    expect((await res.json()).title).toBe('Enter an amount above zero.');
  });

  it('a date in the future gets 400 at occurred_on', async () => {
    const res = await addRoute(as('owner', '/costs/lines', { method: 'POST', body: manual({ occurred_on: '2999-01-01' }) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.title).toBe("A cost can't be dated in the future.");
    expect(body.errors).toEqual([expect.objectContaining({ path: 'occurred_on' })]);
  });

  it('a note over 500 characters and an unknown category are refused', async () => {
    expect((await addRoute(as('owner', '/costs/lines', { method: 'POST', body: manual({ note: 'x'.repeat(501) }) }))).status).toBe(400);
    expect((await addRoute(as('owner', '/costs/lines', { method: 'POST', body: manual({ category: 'hours' }) }))).status).toBe(400);
  });

  it('editing a manual line voids it and returns the new line', async () => {
    const added = await (await addRoute(as('leader', '/costs/lines', { method: 'POST', body: manual() }))).json();
    const res = await editRoute(as('leader', `/costs/lines/${added.id}`, { method: 'PATCH', body: { amount_cents: 9_000, note: 'Corrected' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ amount_cents: 9_000, note: 'Corrected', replaces_id: added.id });
  });

  it('editing a usage line gets 409 "Only costs added by hand can be edited."', async () => {
    const line = await run((ctx) =>
      recordLine(ctx, { originEventId: newId('evt'), occurredOn: '2026-11-02', category: 'ai_usage', provider: 'anthropic', amountCents: 40, accountId: null, sourceId: null }),
    );
    const res = await editRoute(as('owner', `/costs/lines/${line!.id}`, { method: 'PATCH', body: { amount_cents: 1 } }));
    expect(res.status).toBe(409);
    expect((await res.json()).title).toBe('Only costs added by hand can be edited.');
  });

  it('void needs a reason; a voided line shows only with include_voided', async () => {
    const added = await (await addRoute(as('owner', '/costs/lines', { method: 'POST', body: manual({ category: 'lists_events' }) }))).json();
    expect((await actionRoute(as('owner', `/costs/lines/${added.id}:void`, { method: 'POST', body: {} }))).status).toBe(400);
    const res = await actionRoute(as('operator', `/costs/lines/${added.id}:void`, { method: 'POST', body: { reason: 'Duplicate' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: added.id, void_reason: 'Duplicate', voided_by: people.operator!.id });
    const ids = async (q: string) => ((await (await listRoute(as('owner', `/costs/lines?category=lists_events${q}`))).json()).data as { id: string }[]).map((l) => l.id);
    expect(await ids('')).not.toContain(added.id);
    expect(await ids('&include_voided=true')).toContain(added.id);
  });
});

describe('paging', () => {
  it('pages of 50, newest first, with a cursor', async () => {
    await run(async (ctx) => {
      for (let i = 0; i < 55; i++) {
        const day = String((i % 28) + 1).padStart(2, '0');
        await addManualLine(ctx, { occurredOn: `2026-10-${day}`, category: 'agents_hosting', amountCents: 100 + i, note: null });
      }
    });
    const first = await (await listRoute(as('owner', '/costs/lines?category=agents_hosting'))).json();
    expect(first.data).toHaveLength(50);
    expect(first.next_cursor).toEqual(expect.any(String));
    const days = (first.data as { occurred_on: string }[]).map((l) => l.occurred_on);
    expect(days).toEqual([...days].sort().reverse());
    expect(days[0]).toBe('2026-10-28');
    const second = await (await listRoute(as('owner', `/costs/lines?category=agents_hosting&cursor=${first.next_cursor}`))).json();
    expect(second.data).toHaveLength(5);
    expect(second.next_cursor).toBeNull();
    const all = new Set([...first.data, ...second.data].map((l: { id: string }) => l.id));
    expect(all.size).toBe(55);
  });

  it('from and to bound occurred_on', async () => {
    const page = await (await listRoute(as('owner', '/costs/lines?category=agents_hosting&from=2026-10-02&to=2026-10-03'))).json();
    expect(new Set((page.data as { occurred_on: string }[]).map((l) => l.occurred_on))).toEqual(new Set(['2026-10-02', '2026-10-03']));
  });
});

describe('budgets and summary', () => {
  const save = (role: Role, month: string, budgets: unknown[] = [{ category: 'ai_usage', amount_cents: 25_000 }]) =>
    saveBudgetsRoute(as(role, '/costs/budgets', { method: 'PUT', body: { month, budgets } }));

  it('a leader can save budgets; an operator can read but gets 403 on the PUT; a seller gets 403 on all', async () => {
    const current = await (await budgetsRoute(as('operator', '/costs/budgets'))).json();
    expect(current.month).toMatch(/^\d{4}-\d{2}$/);
    const res = await save('leader', current.month);
    expect(res.status).toBe(200);
    const saved = await res.json();
    expect(saved).toMatchObject({ month: current.month, total_cents: 25_000 });
    expect(saved.budgets).toContainEqual({ category: 'ai_usage', label: 'AI usage', amount_cents: 25_000, pausable: true });
    expect((await save('operator', current.month)).status).toBe(403);
    expect((await summaryRoute(as('operator', '/costs/summary'))).status).toBe(200);
    const seller = [await budgetsRoute(as('seller', '/costs/budgets')), await save('seller', current.month), await summaryRoute(as('seller', '/costs/summary'))];
    expect(seller.map((r) => r.status)).toEqual([403, 403, 403]);
  });

  it('an API key with budgets:write cannot save budgets (people only)', async () => {
    const { secret } = await run((ctx) => createApiKey(ctx, { name: 'b', environment: 'live', scopes: ['budgets:write', 'costs:read'] }, SYSTEM_GRANTOR));
    const req = new Request('http://localhost:4240/api/v1/costs/budgets', {
      method: 'PUT',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ month: '2099-01', budgets: [{ category: 'ai_usage', amount_cents: 1 }] }),
    });
    expect((await saveBudgetsRoute(req)).status).toBe(403);
  });

  it('a past month gets 409 "Past months can\'t be changed."; a bad month or amount gets 400', async () => {
    const res = await save('owner', '2000-01');
    expect(res.status).toBe(409);
    expect((await res.json()).title).toBe("Past months can't be changed.");
    expect((await save('owner', '2099-01', [{ category: 'ai_usage', amount_cents: -5 }])).status).toBe(400);
    expect((await budgetsRoute(as('owner', '/costs/budgets?month=soon'))).status).toBe(400);
  });

  it('the summary carries the tiles, five categories and six months', async () => {
    const body = await (await summaryRoute(as('owner', '/costs/summary'))).json();
    expect(Object.keys(body).sort()).toEqual([
      'budget_month_cents',
      'categories',
      'cost_per_sent_cents',
      'cost_per_won_cents',
      'month',
      'months',
      'return_ratio',
      'spend_90d_cents',
      'spend_month_cents',
      'target_cost_per_won_cents',
    ]);
    expect(body.categories.map((c: { key: string }) => c.key)).toEqual(['partner_fees', 'data_vendors', 'agents_hosting', 'lists_events', 'ai_usage']);
    expect(Object.keys(body.categories[0]).sort()).toEqual(['budget_cents', 'key', 'label', 'level', 'pausable', 'spend_90d_cents', 'spend_month_cents']);
    expect(body.months).toHaveLength(6);
    expect(body.months[5]).toMatchObject({ month: body.month, spend_cents: body.spend_month_cents, budget_cents: body.budget_month_cents });
  });
});

describe('R3b: sources on lines, the target and costs by source', () => {
  const put = (role: Role, body: unknown) => targetRoute(as(role, '/costs/target', { method: 'PUT', body }));
  const target = async () => (await (await summaryRoute(as('owner', '/costs/summary'))).json()).target_cost_per_won_cents;

  it('a manual line with a source saves it and lists its name; an unknown or removed source gets 400', async () => {
    const [kept, gone] = await run(async (ctx) => {
      const k = await registerSource(ctx, { kind: 'partner', name: 'Kestrel' });
      const g = await registerSource(ctx, { kind: 'partner', name: 'Gone partner' });
      await removeSource(ctx, g.id);
      return [k.id, g.id];
    });
    const res = await addRoute(as('owner', '/costs/lines', { method: 'POST', body: manual({ category: 'lists_events', source_id: kept }) }));
    expect(res.status).toBe(201);
    const added = await res.json();
    expect(added).toMatchObject({ source_id: kept, source_name: 'Kestrel' });
    const listed = (await (await listRoute(as('owner', '/costs/lines?category=lists_events'))).json()).data.find((l: { id: string }) => l.id === added.id);
    expect(listed).toMatchObject({ source_id: kept, source_name: 'Kestrel' });
    for (const source_id of ['src_nope', gone]) {
      const bad = await addRoute(as('owner', '/costs/lines', { method: 'POST', body: manual({ source_id }) }));
      expect(bad.status).toBe(400);
      expect((await bad.json()).title).toBe('Choose a source that exists.');
    }
    const edited = await editRoute(as('owner', `/costs/lines/${added.id}`, { method: 'PATCH', body: { source_id: null } }));
    expect(await edited.json()).toMatchObject({ source_id: null, source_name: null, replaces_id: added.id });
  });

  it('a line whose source was removed later can still be edited while it keeps that source', async () => {
    const later = await run(async (ctx) => (await registerSource(ctx, { kind: 'partner', name: 'Removed later' })).id);
    const added = await (await addRoute(as('owner', '/costs/lines', { method: 'POST', body: manual({ source_id: later }) }))).json();
    await run((ctx) => removeSource(ctx, later));
    const res = await editRoute(as('owner', `/costs/lines/${added.id}`, { method: 'PATCH', body: { amount_cents: 9_999, source_id: later } }));
    expect(res.status).toBe(200);
    const edited = await res.json();
    expect(edited).toMatchObject({ amount_cents: 9_999, source_id: later, source_name: 'Removed later', replaces_id: added.id });
    // Leaving the source out keeps it too.
    const again = await editRoute(as('owner', `/costs/lines/${edited.id}`, { method: 'PATCH', body: { amount_cents: 9_000 } }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ amount_cents: 9_000, source_id: later });
  });

  it('PUT /costs/target sets, refuses 0 and clears the target; the summary returns it', async () => {
    const res = await put('leader', { target_cost_per_won_cents: 200_000 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ target_cost_per_won_cents: 200_000 });
    expect(await target()).toBe(200_000);
    const zero = await put('owner', { target_cost_per_won_cents: 0 });
    expect(zero.status).toBe(400);
    expect((await zero.json()).title).toBe('Enter a target above zero, or clear it.');
    expect(await target()).toBe(200_000);
    expect((await put('owner', { target_cost_per_won_cents: null })).status).toBe(200);
    expect(await target()).toBeNull();
  });

  it('an operator gets 403 on the target; a seller gets 403 on the summary, the target and costs by source', async () => {
    expect((await put('operator', { target_cost_per_won_cents: 1 })).status).toBe(403);
    expect((await bySourceRoute(as('operator', '/costs/by-source'))).status).toBe(200);
    const seller = [
      await summaryRoute(as('seller', '/costs/summary')),
      await put('seller', { target_cost_per_won_cents: 1 }),
      await bySourceRoute(as('seller', '/costs/by-source')),
    ];
    expect(seller.map((r) => r.status)).toEqual([403, 403, 403]);
  });

  it('GET /costs/by-source ends with Shared costs and gives the total', async () => {
    const body = await (await bySourceRoute(as('owner', '/costs/by-source'))).json();
    expect(Object.keys(body).sort()).toEqual(['rows', 'total_spend_cents']);
    expect(body.rows.at(-1)).toEqual({ source_id: null, name: 'Shared costs', spend_cents: expect.any(Number), share_pct: expect.any(Number) });
    expect(body.rows.reduce((s: number, r: { spend_cents: number }) => s + r.spend_cents, 0)).toBe(body.total_spend_cents);
  });
});
