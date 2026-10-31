import { eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accepted, created, v1Route } from '@/http/routes/v1/_lib/v1-route';
import { SYSTEM_GRANTOR, createApiKey, createTenant, setPrincipalCacheTtl } from '@/modules/tenancy';
import { membership } from '@/modules/tenancy/db/schema';
import { adminDb } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { pingResult, sendPing } from '@/platform/diagnostics';
import { runOutbox } from '../helpers/run-outbox';
import { inTenant, seedUser, uniqueSlug } from '../tenancy/helpers';

let tenantId: string;
let owner: Awaited<ReturnType<typeof seedUser>>;

beforeAll(async () => {
  const admin = await seedUser({ admin: true });
  owner = await seedUser({ signedIn: true });
  const t = await createTenant(admin.actor, {
    slug: uniqueSlug(),
    name: 'Idem Co',
    currency: 'USD',
    timezone: 'UTC',
    ownerEmail: owner.email,
  });
  await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.id, t.ownerMembershipId));
  tenantId = t.tenantId;
});
beforeEach(() => setPrincipalCacheTtl(0));

const newKey = async () =>
  (
    await inTenant(tenantId, owner.actor, (ctx) =>
      createApiKey(ctx, { name: 'k', environment: 'live', scopes: [] }, SYSTEM_GRANTOR),
    )
  ).secret;

const route = v1Route({ idempotent: true }, async (req, _p, ctx) => {
  const body = (await req.json()) as { n: number };
  await new Promise((r) => setTimeout(r, 150));
  const jobId = await sendPing(ctx);
  return accepted({ jobId, n: body.n });
});

const request = (secret: string, key: string | null, body: unknown) =>
  new Request('http://x/v1/y', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: JSON.stringify(body),
  });
const post = (secret: string, key: string | null, body: unknown) => route(request(secret, key, body));

const pings = async () => (await adminDb.select().from(outbox).where(eq(outbox.tenantId, tenantId))).length;

describe('idempotent v1Route', () => {
  it('runs two concurrent identical POSTs once and replays the second', async () => {
    const secret = await newKey();
    const before = await pings();
    const [a, b] = await Promise.all([post(secret, 'k-concurrent', { n: 1 }), post(secret, 'k-concurrent', { n: 1 })]);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect((await pings()) - before).toBe(1);
    expect([a, b].filter((r) => r.headers.get('idempotent-replayed') === 'true')).toHaveLength(1);
    expect(await a.json()).toEqual(await b.json());
  });

  it('replays a later identical request with the stored body', async () => {
    const secret = await newKey();
    const first = await post(secret, 'k-later', { n: 2 });
    const second = await post(secret, 'k-later', { n: 2 });
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(await second.json()).toEqual(await first.json());
  });

  it('409 idempotency-mismatch for the same key with a different body', async () => {
    const secret = await newKey();
    expect((await post(secret, 'k-mismatch', { n: 1 })).status).toBe(202);
    const res = await post(secret, 'k-mismatch', { n: 2 });
    expect(res.status).toBe(409);
    expect((await res.json()).type).toMatch(/\/idempotency-mismatch$/);
  });

  it('keeps the same key apart for two API keys in one tenant', async () => {
    const [one, two] = [await newKey(), await newKey()];
    const a = await post(one, 'k-shared', { n: 1 });
    const b = await post(two, 'k-shared', { n: 9 });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.headers.get('idempotent-replayed')).toBeNull();
  });

  it('takes over a key older than 24 hours', async () => {
    const secret = await newKey();
    await post(secret, 'k-old', { n: 1 });
    await adminDb.execute(
      sql`update platform.idempotency_key set created_at = now() - interval '25 hours' where key = 'k-old'`,
    );
    const again = await post(secret, 'k-old', { n: 2 });
    expect(again.status).toBe(202);
    expect(again.headers.get('idempotent-replayed')).toBeNull();
    expect((await again.json()).n).toBe(2);
  });

  it('stores nothing when the handler fails, so a retry runs again', async () => {
    const secret = await newKey();
    let calls = 0;
    const flaky = v1Route({ idempotent: true }, async () => {
      if (++calls === 1) throw new Error('x');
      return created({ ok: true });
    });
    expect((await flaky(request(secret, 'k-fail', {}))).status).toBe(500);
    const retry = await flaky(request(secret, 'k-fail', {}));
    expect(retry.status).toBe(201);
    expect(retry.headers.get('idempotent-replayed')).toBeNull();
  });

  it('runs every time when no key is sent', async () => {
    const secret = await newKey();
    const before = await pings();
    await post(secret, null, { n: 1 });
    await post(secret, null, { n: 1 });
    expect((await pings()) - before).toBe(2);
  });
});

describe('statuses and problem bodies', () => {
  it('answers 201 for created, and problems carry the correlation id', async () => {
    const secret = await newKey();
    const get = (id: string) =>
      new Request('http://x/v1/y', { headers: { authorization: `Bearer ${secret}`, 'x-correlation-id': id } });
    const res = await v1Route({}, async () => created({ madeBy: 'me' }))(get('cor_a'));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ made_by: 'me' });
    const bad = await v1Route({}, async () => {
      throw new Error('x');
    })(get('cor_b'));
    expect((await bad.json()).correlation_id).toBe('cor_b');
  });
});

describe('runOutbox', () => {
  it('runs the matching job handler once and marks the row sent', async () => {
    const id = await inTenant(tenantId, owner.actor, (ctx) => sendPing(ctx));
    await runOutbox(tenantId);
    expect(await pingResult(id)).not.toBeNull();
    const [row] = await adminDb.select().from(outbox).where(eq(outbox.id, id));
    expect(row?.sentAt).not.toBeNull();
    await runOutbox(tenantId);
  });
});
