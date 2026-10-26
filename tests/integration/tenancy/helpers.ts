import { adminDb } from '@/platform/db/client';
import { withTenant } from '@/platform/db/tenant';
import type { ModuleContext } from '@/platform/context';
import type { Actor } from '@/platform/events/envelope';
import { newId } from '@/platform/ids';
import { user } from '@/modules/tenancy/db/schema';

export async function seedUser(opts: { email?: string; admin?: boolean; signedIn?: boolean } = {}) {
  const id = newId('usr');
  const email = opts.email ?? `${id.toLowerCase()}@example.com`;
  await adminDb.insert(user).values({
    id,
    name: email.split('@')[0]!,
    email,
    platformAdmin: opts.admin ?? false,
    lastSignInAt: opts.signedIn ? new Date() : null,
  });
  return { id, email, actor: { kind: 'user', id } as Actor };
}

export function inTenant<T>(tenantId: string, actor: Actor, fn: (ctx: ModuleContext) => Promise<T>): Promise<T> {
  return withTenant(tenantId, (tx) => fn({ tenantId, actor, correlationId: newId('cor'), tx }));
}

export const uniqueSlug = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
