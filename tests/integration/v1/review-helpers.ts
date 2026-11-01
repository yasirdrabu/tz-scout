import { and, eq } from 'drizzle-orm';
import '@/entry/compose';
import { membership, user } from '@/modules/tenancy/db/schema';
import { addMember, createTenant, handleDevSignIn, type DataLimit } from '@/modules/tenancy';
import { adminDb } from '@/platform/db/client';
import { runOutbox } from '../helpers/run-outbox';
import { arrivedAccount } from '../routing/helpers';
import { inTenant, seedUser, uniqueSlug } from '../tenancy/helpers';
import { POST as postArrival } from '@/http/routes/v1/arrivals/route';
import { arrival } from '@/modules/intake/db/schema';
import { newId } from '@/platform/ids';
import { call, keyFor, personAndAgent, SEND } from './intake-helpers';

export type Role = 'leader' | 'seller' | 'operator';
type Handler = (r: Request) => Promise<Response>;

async function signIn(userId: string): Promise<string> {
  const res = await handleDevSignIn(
    new Request('http://localhost:4240/api/dev/sign-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId }) }),
    { enabled: true },
  );
  return res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ');
}

export type Workspace = Awaited<ReturnType<typeof workspace>>;

/**
 * A tenant with an owner and every module's defaults delivered, plus helpers to add signed-in people
 * and accounts and to call routes as one of them, with the headers the web app sends.
 */
export async function workspace(name = 'Review Co') {
  const admin = await seedUser({ admin: true });
  const owner = await seedUser({ signedIn: true });
  await adminDb.update(user).set({ name: `${name} Owner` }).where(eq(user.id, owner.id));
  const slug = uniqueSlug();
  const t = await createTenant(admin.actor, { slug, name, currency: 'USD', timezone: 'UTC', ownerEmail: owner.email });
  await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.id, t.ownerMembershipId));
  const tenantId = t.tenantId;
  await runOutbox(tenantId);
  const run = <T>(fn: Parameters<typeof inTenant<T>>[2]) => inTenant(tenantId, owner.actor, fn);
  const tenant = { tenantId, actor: owner.actor, run } as never;
  const cookies = new Map<string, string>([[owner.id, await signIn(owner.id)]]);
  const source = await personAndAgent(tenant, `${name} Ash`);

  /** A signed-in member; sellers get a HubSpot owner id unless `crm: false`, since the preflight blocks one without. */
  const person = async (role: Role, opts: { name?: string; dataLimit?: DataLimit; extra?: string[]; crm?: boolean } = {}) => {
    const u = await seedUser({ signedIn: true });
    if (opts.name) await adminDb.update(user).set({ name: opts.name }).where(eq(user.id, u.id));
    const crm = role === 'seller' && opts.crm !== false;
    await run((ctx) => addMember(ctx, { email: u.email, role, ...(crm ? { crmOwnerIds: { hubspot: `mock-${u.id}` } } : {}) }));
    if (opts.dataLimit || opts.extra) {
      await adminDb
        .update(membership)
        .set({ ...(opts.dataLimit ? { dataLimit: opts.dataLimit } : {}), ...(opts.extra ? { extraPermissions: opts.extra } : {}) })
        .where(and(eq(membership.tenantId, tenantId), eq(membership.userId, u.id)));
    }
    cookies.set(u.id, await signIn(u.id));
    return u.id;
  };

  /** A request as the person; a FormData body goes as multipart, anything else as JSON. */
  const as = (userId: string, handler: Handler, path: string, method = 'GET', body?: unknown) => {
    const form = body instanceof FormData;
    return handler(
      new Request(`http://localhost:4240/api/v1/${path}`, {
        method,
        headers: {
          cookie: cookies.get(userId)!,
          'x-scout-tenant': slug,
          origin: 'http://localhost:4240',
          ...(form ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
      }),
    );
  };

  const account = (accountName = 'Route Co', agentSourceId = source.agentId) => arrivedAccount(tenant, { name: accountName, sourceChain: { agentSourceId } });

  /** Delivers what is in the outbox, so read models (the account summary) catch up. */
  const deliver = () => runOutbox(tenantId);

  /** An account sent through the API by the agent (a real arrival, so it has a source chain), delivered. */
  const sent = async (fields: Record<string, unknown> & { name: string }, agentSourceId = source.agentId) => {
    const key = await keyFor(tenant, SEND, { sourceId: agentSourceId, dataLimit: { kind: 'own_source' } });
    const res = await call(postArrival, key, 'arrivals', { body: { account: { domain: `${newId('acc').slice(-10).toLowerCase()}-example.com`, ...fields } } });
    if (res.status !== 202) throw new Error(JSON.stringify(await res.json()));
    const arrivalId = (await res.json()).arrival_id as string;
    await deliver();
    const [row] = await run((ctx) => ctx.tx.select({ accountId: arrival.accountId }).from(arrival).where(eq(arrival.id, arrivalId)));
    return row!.accountId!;
  };

  return { tenantId, slug, owner: owner.id, ownerName: `${name} Owner`, run, tenant, source, person, as, account, deliver, sent };
}
