import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as listRoute, POST as addRoute } from '@/http/routes/v1/costs/lines/route';
import { PATCH as editRoute, POST as actionRoute } from '@/http/routes/v1/costs/lines/[id]/route';
import { addManualLine, recordLine } from '@/modules/analytics';
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

  it('an API key with costs:write can neither add nor edit a line', async () => {
    const line = await run((ctx) => addManualLine(ctx, { occurredOn: '2026-11-02', category: 'partner_fees', amountCents: 100, note: null }));
    const { secret } = await run((ctx) => createApiKey(ctx, { name: 'k', environment: 'live', scopes: ['costs:write', 'costs:read'] }, SYSTEM_GRANTOR));
    const key = (path: string, method: string, body: unknown) =>
      new Request(`http://localhost:4240/api/v1${path}`, { method, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await addRoute(key('/costs/lines', 'POST', manual()))).status).toBe(403);
    expect((await editRoute(key(`/costs/lines/${line.id}`, 'PATCH', { amount_cents: 1 }))).status).toBe(403);
  });
});

describe('validation and changes', () => {
  it('an amount of 0 gets "Enter an amount above zero."', async () => {
    const res = await addRoute(as('owner', '/costs/lines', { method: 'POST', body: manual({ amount_cents: 0 }) }));
    expect(res.status).toBe(400);
    expect((await res.json()).title).toBe('Enter an amount above zero.');
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
      recordLine(ctx, { originEventId: newId('evt'), occurredOn: '2026-11-02', category: 'ai_usage', provider: 'anthropic', amountCents: 40, accountId: null }),
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
