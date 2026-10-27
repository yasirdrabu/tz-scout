import '@/entry/compose';
import { registerSource } from '@/modules/intake';
import type { Access } from '@/platform/access';
import type { ModuleContext } from '@/platform/context';
import { freshTenant } from '../integrations/helpers';

export type Tenant = Awaited<ReturnType<typeof freshTenant>>;
export { freshTenant };

/** Runs `fn` in the tenant as the given source, the way an API key with that source would. */
export function asSource<T>(t: Tenant, sourceId: string, fn: (ctx: ModuleContext) => Promise<T>): Promise<T> {
  const access: Access = { sourceId, dataLimit: { kind: 'own_source' } };
  return t.run((ctx) => fn({ ...ctx, access }));
}

/** A person source and an agent it owns. */
export async function personAndAgent(t: Tenant, name = 'Ash'): Promise<{ personId: string; agentId: string }> {
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
