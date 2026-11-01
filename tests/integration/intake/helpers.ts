import '@/entry/compose';
import { registerSource } from '@/modules/intake';
import { seedRoutingDefaults } from '@/modules/routing';
import type { Access } from '@/platform/access';
import type { ModuleContext } from '@/platform/context';
import { freshTenant as baseFreshTenant } from '../integrations/helpers';

export type Tenant = Awaited<ReturnType<typeof baseFreshTenant>>;

/** A fresh tenant with the routing defaults in place, so a source can name the default review statuses. */
export async function freshTenant(): Promise<Tenant> {
  const t = await baseFreshTenant();
  await t.run((ctx) => seedRoutingDefaults(ctx));
  return t;
}

/** Runs `fn` in the tenant as the given source, the way an API key with that source would. */
export function asSource<T>(t: Tenant, sourceId: string, fn: (ctx: ModuleContext) => Promise<T>): Promise<T> {
  const access: Access = { sourceId, dataLimit: { kind: 'own_source' } };
  return t.run((ctx) => fn({ ...ctx, access }));
}

const named = new Map<string, number>();

/** A person source and an agent it owns. Source names are unique per tenant, so a repeat call numbers the name ("Ash 2"). */
export async function personAndAgent(t: Tenant, base = 'Ash'): Promise<{ personId: string; agentId: string }> {
  const key = `${t.tenantId}\u0000${base}`;
  const n = (named.get(key) ?? 0) + 1;
  named.set(key, n);
  const name = n === 1 ? base : `${base} ${n}`;
  return t.run(async (ctx) => {
    const person = await registerSource(ctx, { kind: 'person', name });
    const agent = await registerSource(ctx, { kind: 'agent', name: `${name} agent`, parentId: person.id });
    return { personId: person.id, agentId: agent.id };
  });
}

let n = 0;
/** A valid strict arrival with a unique domain. */
export const validArrival = (over: Record<string, unknown> = {}) => {
  n++;
  return { account: { name: `Acme ${n}`, domain: `acme-${Date.now().toString(36)}-${n}.com`, ...over } };
};
