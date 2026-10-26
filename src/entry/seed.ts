import { config } from '@/platform/config';
import { withTenant } from '@/platform/db/tenant';
import type { ModuleContext } from '@/platform/context';
import { newId } from '@/platform/ids';
import {
  SYSTEM_GRANTOR,
  addMember,
  completeSignIn,
  createApiKey,
  createTenant,
  ensurePlatformAdmin,
  listTenants,
  members,
  userIdForEmail,
} from '@/modules/tenancy';

const ADMIN_EMAIL = 'yasir@taazaa.com';

const TENANTS = [
  {
    slug: 'taazaa',
    name: 'Taazaa',
    currency: 'USD',
    timezone: 'America/New_York',
    ownerEmail: 'zach.wiant@taazaa.com',
    // Placeholder CRM owner ids until the real ones are linked.
    sellers: [
      { email: 'ash@taazaa.com', hubspotOwnerId: 'placeholder-owner-ash' },
      { email: 'mike@taazaa.com', hubspotOwnerId: 'placeholder-owner-mike' },
      { email: 'andy@taazaa.com', hubspotOwnerId: 'placeholder-owner-andy' },
    ],
  },
  {
    slug: 'northwind',
    name: 'Northwind',
    currency: 'USD',
    timezone: 'America/Chicago',
    ownerEmail: 'owner@northwind.example',
    sellers: [],
  },
] as const;

/**
 * Local development data: one platform admin, two tenants, a few people and a dev API key. Safe to
 * run again. Schedules are seeded elsewhere. Returns a fresh key for `taazaa` on each run, because
 * a key's secret is only shown once.
 */
export async function seed(): Promise<{ devApiKey: string }> {
  if (config.nodeEnv === 'production') throw new Error('Seed data is for local use only.');

  const adminId = await ensurePlatformAdmin(ADMIN_EMAIL);
  const actor = { kind: 'user' as const, id: adminId };

  let taazaaId = '';
  for (const t of TENANTS) {
    let row = (await listTenants()).find((x) => x.slug === t.slug);
    if (!row) {
      await createTenant(actor, {
        slug: t.slug,
        name: t.name,
        currency: t.currency,
        timezone: t.timezone,
        ownerEmail: t.ownerEmail,
      });
      row = (await listTenants()).find((x) => x.slug === t.slug)!;
    }
    // The owner has signed in before, so their membership is active.
    const ownerId = await userIdForEmail(t.ownerEmail);
    if (ownerId) await completeSignIn(ownerId);

    const ctx = (tx: ModuleContext['tx']): ModuleContext => ({
      tenantId: row.id,
      actor,
      correlationId: newId('cor'),
      tx,
    });
    await withTenant(row.id, async (tx) => {
      const have = new Set((await members(ctx(tx))).map((m) => m.email));
      for (const s of t.sellers) {
        if (have.has(s.email)) continue;
        await addMember(ctx(tx), { email: s.email, role: 'seller', crmOwnerIds: { hubspot: s.hubspotOwnerId } });
      }
    });
    if (t.slug === 'taazaa') taazaaId = row.id;
  }

  const { secret } = await withTenant(taazaaId, (tx) =>
    createApiKey(
      { tenantId: taazaaId, actor, correlationId: newId('cor'), tx },
      { name: 'Local development key', environment: 'test', scopes: ['status:read', 'members:read'] },
      SYSTEM_GRANTOR,
    ),
  );
  return { devApiKey: secret };
}
