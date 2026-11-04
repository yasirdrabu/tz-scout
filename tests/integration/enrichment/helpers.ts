import { and, eq } from 'drizzle-orm';
import { listPeople } from '@/modules/accounts';
import { getArrivalWithStatus, personSourceFor, registerSource, submitArrival } from '@/modules/intake';
import { ROLE_PERMISSIONS, actorFor, type Permission, type Principal } from '@/modules/tenancy';
import { user } from '@/modules/tenancy/db/schema';
import { accessFor } from '@/platform/access';
import type { ModuleContext } from '@/platform/context';
import { adminDb } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { seedUser } from '../tenancy/helpers';
import { asSource, freshTenant as intakeTenant, type Tenant } from '../intake/helpers';

export type { Tenant };

/** A person principal with a role's default permissions, seeing every account unless told otherwise. */
export async function person(t: Tenant, role: 'owner' | 'leader' | 'seller', name: string, userId?: string): Promise<Principal> {
  const id = userId ?? (await seedUser()).id;
  await adminDb.update(user).set({ name }).where(eq(user.id, id));
  return {
    tenantId: t.tenantId,
    kind: 'user',
    id,
    userId: id,
    permissions: [...ROLE_PERMISSIONS[role]],
    dataLimit: { kind: 'all' },
    platformAdmin: false,
    supportAccess: false,
  };
}

/** An API key principal for an agent source; by default it sees only what its source sent. */
export function agentKey(t: Tenant, sourceId: string, over: Partial<Principal> = {}): Principal {
  return {
    tenantId: t.tenantId,
    kind: 'api_key',
    id: newId('key'),
    sourceId,
    environment: 'live',
    permissions: ['enrichment:request', 'accounts:read'] as Permission[],
    dataLimit: { kind: 'own_source' },
    platformAdmin: false,
    supportAccess: false,
    ...over,
  };
}

/** Runs `fn` as the principal, with the actor and access the HTTP layer would give it. */
export function as<T>(t: Tenant, p: Principal, fn: (ctx: ModuleContext) => Promise<T>): Promise<T> {
  return t.run((ctx) => fn({ ...ctx, actor: actorFor(p), access: accessFor(p) }));
}

/**
 * A tenant whose owner is "Yasir Drabu" with a person source and an agent under it ("Yasir's agent"), and a
 * second agent owned by no one ("Loose agent").
 */
export async function enrichmentTenant() {
  const t = await intakeTenant();
  await runOutbox(t.tenantId);
  const owner = await person(t, 'owner', 'Yasir Drabu', t.actor.id);
  const sources = await t.run(async (ctx) => {
    const personId = (await personSourceFor(ctx, owner.id)) ?? (await registerSource(ctx, { kind: 'person', name: 'Yasir Drabu', userId: owner.id })).id;
    const agentId = (await registerSource(ctx, { kind: 'agent', name: 'Yasir bot', parentId: personId })).id;
    const loosePerson = (await registerSource(ctx, { kind: 'person', name: `Loose ${newId('src')}` })).id;
    const looseAgentId = (await registerSource(ctx, { kind: 'agent', name: 'Loose agent', parentId: loosePerson })).id;
    return { personId, agentId, looseAgentId };
  });
  return { t, owner, ...sources };
}

let n = 0;
/** An account sent by `sourceId`, with two people; returns its id and the people's ids. */
export async function accountFrom(t: Tenant, sourceId: string): Promise<{ accountId: string; personIds: string[] }> {
  const d = `enr${Date.now().toString(36)}${++n}-example.com`;
  const sent = await asSource(t, sourceId, (ctx) =>
    submitArrival(
      ctx,
      {
        account: { name: `Enrich ${n}`, domain: d },
        people: [
          { name: 'Pat Lee', title: 'CTO', email: `pat@${d}` },
          { name: 'Sam Roe', title: 'CFO' },
        ],
      },
      { channel: 'api' },
    ),
  );
  await runOutbox(t.tenantId);
  const row = await asSource(t, sourceId, (ctx) => getArrivalWithStatus(ctx, sent.arrivalId, { ownerName: false }));
  const accountId = row!.accountId!;
  const people = await t.run((ctx) => listPeople(ctx, accountId));
  return { accountId, personIds: people.map((p) => p.id) };
}

type OutboxPayload = { type: string; id: string; data: Record<string, unknown> };

/** The tenant's outbox messages of `type` (an event type or `jobs.<name>`), oldest first. */
export const messages = (t: Tenant, type: string) =>
  t.run(async (ctx) =>
    (await ctx.tx.select().from(outbox).where(and(eq(outbox.tenantId, ctx.tenantId))).orderBy(outbox.seq))
      .map((r) => r.payload as OutboxPayload)
      .filter((p) => p.type === type),
  );

/** Messages of `type` about one request. */
export const messagesFor = async (t: Tenant, type: string, requestId: string) => (await messages(t, type)).filter((p) => p.data.requestId === requestId);
