import { randomBytes } from 'node:crypto';
import { createTenant } from '@/modules/tenancy';
import { registerDemoAdapter } from '@/modules/integrations/adapters/demo/mock';
import { inTenant, seedUser, uniqueSlug } from '../tenancy/helpers';

export const newKey = () => randomBytes(32);

type Fn<T> = Parameters<typeof inTenant<T>>[2];

export async function freshTenant() {
  const admin = await seedUser({ admin: true });
  const owner = await seedUser({ signedIn: true });
  const t = await createTenant(admin.actor, {
    slug: uniqueSlug(),
    name: 'Int',
    currency: 'USD',
    timezone: 'UTC',
    ownerEmail: owner.email,
  });
  registerDemoAdapter();
  return {
    tenantId: t.tenantId,
    actor: owner.actor,
    run: <T>(fn: Fn<T>) => inTenant(t.tenantId, owner.actor, fn),
  };
}
