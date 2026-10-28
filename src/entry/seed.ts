import './registry';
import { config } from '@/platform/config';
import { withTenant } from '@/platform/db/tenant';
import type { ModuleContext } from '@/platform/context';
import { newId } from '@/platform/ids';
import { upsertSchedule } from '@/platform/scheduler';
import {
  SYSTEM_GRANTOR,
  addMember,
  completeSignIn,
  createApiKey,
  createTenant,
  ensurePlatformAdmin,
  listTenants,
  members,
  revokeActiveKeysNamed,
  userIdForEmail,
} from '@/modules/tenancy';
import { seedAccountDefaults } from '@/modules/accounts';
import { listSources, personSourceFor, registerSource, seedIntakeDefaults } from '@/modules/intake';
import { seedMissingSignalRules, seedOffers } from '@/modules/offers';
import { backfillReviews, seedRoutingDefaults } from '@/modules/routing';
import { requestRescore, seedScoringDefaults } from '@/modules/scoring';

export const ADMIN_EMAIL = 'yasir@taazaa.com';
const PLATFORM_TENANT = 't_platform';
const DEV_KEY_NAME = 'Local development key';
const DEV_AGENT_NAME = 'Local development agent';
const DEV_KEY_SCOPES = [
  'arrivals:write',
  'arrivals:read',
  'accounts:read',
  'accounts:write',
  'people:write',
  'signals:write',
  'imports:run',
  'offers:read',
  'status:read',
] as const;

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
 * Brings a tenant built before R1b up to date: the scoring and routing defaults (with their schedules), default signal rules for each offer that has none, a review row and
 * snapshot for each account that has none, and a rescore of every account. Safe to run again: the defaults and reviews
 * are added only when missing, and a repeat rescore changes no score. Background context only.
 */
export async function backfillR1b(ctx: ModuleContext): Promise<void> {
  await seedScoringDefaults(ctx);
  await seedRoutingDefaults(ctx);
  await seedMissingSignalRules(ctx);
  await backfillReviews(ctx);
  await requestRescore(ctx);
}

/**
 * Local development data: one platform admin, two tenants, a few people, a person source for each, a development agent and a dev API key bound to it. Safe to
 * run again. Also schedules the hourly credential cleanup. Returns a fresh key for `taazaa` on each run, because
 * a key's secret is only shown once.
 */
export async function seed(): Promise<{ devApiKey: string }> {
  if (config.isProduction) throw new Error('Seed data is for local use only.');

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
      await seedAccountDefaults(ctx(tx));
      // Taazaa's own catalogue; other tenants start with no offers.
      if (t.slug === 'taazaa') await seedOffers(ctx(tx));
      // Existing tenants never got the tenant.created event, so call the intake defaults directly.
      await seedIntakeDefaults(ctx(tx));
      await backfillR1b(ctx(tx));
    });
    // Sources come after the first transaction commits, so the sellers' users exist.
    const emails = [ADMIN_EMAIL, t.ownerEmail, ...t.sellers.map((s) => s.email)];
    await withTenant(row.id, async (tx) => {
      const c = ctx(tx);
      let adminSourceId = '';
      for (const email of emails) {
        const userId = await userIdForEmail(email);
        if (!userId) continue;
        const id = (await personSourceFor(c, userId)) ?? (await registerSource(c, { kind: 'person', name: email.split('@')[0]!, userId })).id;
        if (email === ADMIN_EMAIL) adminSourceId = id;
      }
      const have = (await listSources(c)).find((s) => s.kind === 'agent' && s.name === DEV_AGENT_NAME);
      if (!have) await registerSource(c, { kind: 'agent', name: DEV_AGENT_NAME, parentId: adminSourceId });
    });
    if (t.slug === 'taazaa') taazaaId = row.id;
  }

  await upsertSchedule(
    { actor },
    {
      tenantId: PLATFORM_TENANT,
      jobName: 'integrations.credentials.cleanup',
      cron: '0 * * * *',
      timezone: 'UTC',
      payload: {},
    },
  );

  // A rerun replaces the dev key instead of piling up live ones.
  const { secret } = await withTenant(taazaaId, async (tx) => {
    const ctx: ModuleContext = { tenantId: taazaaId, actor, correlationId: newId('cor'), tx };
    await revokeActiveKeysNamed(ctx, DEV_KEY_NAME, 'Replaced by a newer development key');
    const agent = (await listSources(ctx)).find((s) => s.kind === 'agent' && s.name === DEV_AGENT_NAME)!;
    return createApiKey(
      ctx,
      { name: DEV_KEY_NAME, environment: 'test', scopes: [...DEV_KEY_SCOPES], sourceId: agent.id },
      SYSTEM_GRANTOR,
    );
  });
  return { devApiKey: secret };
}
