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
  provisionWorkspace,
  ensurePlatformAdmin,
  listTenants,
  members,
  renameHandleUsers,
  revokeActiveKeysNamed,
  userIdForEmail,
} from '@/modules/tenancy';
import { seedAccountDefaults } from '@/modules/accounts';
import { backfillJourneys } from '@/modules/analytics';
import { backfillCrm, seedCrmDefaults, seedMockCrm } from '@/modules/crm';
import { listConnections } from '@/modules/integrations';
import { computeTrust, listSources, personSourceFor, registerSource, renamePersonSources, seedIntakeDefaults } from '@/modules/intake';
import { seedMissingSignalRules, seedOffers } from '@/modules/offers';
import { backfillBriefs, seedPlaybooksDefaults } from '@/modules/playbooks';
import { backfillLeadOffers, backfillReviews, seedRoutingDefaults } from '@/modules/routing';
import { requestRescore, seedScoringDefaults } from '@/modules/scoring';

export const ADMIN_EMAIL = 'yasir@taazaa.com';
const ADMIN_NAME = 'Yasir Drabu';
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
  'enrichment:request',
] as const;

const TENANTS = [
  {
    slug: 'taazaa',
    name: 'Taazaa',
    currency: 'USD',
    timezone: 'America/New_York',
    ownerEmail: 'zach.wiant@taazaa.com',
    ownerName: 'Zach Wiant',
    // Placeholder CRM owner ids until the real ones are linked.
    sellers: [
      { email: 'ash@taazaa.com', name: 'Ash', hubspotOwnerId: 'placeholder-owner-ash' },
      { email: 'mike@taazaa.com', name: 'Mike', hubspotOwnerId: 'placeholder-owner-mike' },
      { email: 'andy@taazaa.com', name: 'Andy', hubspotOwnerId: 'placeholder-owner-andy' },
    ],
    operators: [{ email: 'riley@taazaa.com', name: 'Riley' }],
  },
  {
    slug: 'northwind',
    name: 'Northwind',
    currency: 'USD',
    timezone: 'America/Chicago',
    ownerEmail: 'owner@northwind.example',
    ownerName: 'Northwind Owner',
    sellers: [],
    operators: [],
  },
] as const;

/** The seeded people's display names, by email. */
const NAMES: Readonly<Record<string, string>> = Object.fromEntries([
  [ADMIN_EMAIL, ADMIN_NAME],
  ...TENANTS.flatMap((t) => [[t.ownerEmail, t.ownerName], ...[...t.sellers, ...t.operators].map((p) => [p.email, p.name])]),
]);

/**
 * People are named, not handled: the seeded people take their names, any other user named by their email's local part
 * gets a name from the email, and person sources still named by a handle take their person's name. Safe to run again.
 */
export async function backfillDisplayNames(): Promise<void> {
  const people = await renameHandleUsers(NAMES);
  for (const t of await listTenants()) {
    await withTenant(t.id, (tx) =>
      renamePersonSources({ tenantId: t.id, actor: { kind: 'system', id: 'seed' }, correlationId: newId('cor'), tx }, people),
    );
  }
}

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
 * Brings a tenant built before R1c up to date: the CRM defaults (settings, field mappings and polling schedules), the
 * qualified-lead poll schedule, a company check for each account with a domain and none yet, and links from the HubSpot
 * ids accounts already carry. Safe to run again. Background context only.
 */
export async function backfillR1c(ctx: ModuleContext): Promise<void> {
  await seedCrmDefaults(ctx);
  await seedIntakeDefaults(ctx);
  await backfillCrm(ctx);
}

/**
 * Brings a workspace from before the review flow up to date: lead offers picked earlier reach the account summary,
 * so the offer filter and facets find them. Safe to run again. Background context only.
 */
export async function backfillReviewFlow(ctx: ModuleContext): Promise<void> {
  await backfillLeadOffers(ctx);
}

/**
 * Brings a workspace from before R3b-2 up to date: the nightly trust schedule, and every source's trust computed now
 * (until then each reads 0.60). Safe to run again. Background context only.
 */
export async function backfillTrust(ctx: ModuleContext): Promise<void> {
  await seedIntakeDefaults(ctx);
  await computeTrust(ctx, { cause: 'outcomes' });
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
      const made = await createTenant(actor, {
        slug: t.slug,
        name: t.name,
        currency: t.currency,
        timezone: t.timezone,
        ownerEmail: t.ownerEmail,
      });
      // A database of its own (D35): made here, not left to the worker, so the rest of the seed can use it.
      if (made.status === 'provisioning' && (await provisionWorkspace(made.tenantId)) !== 'active') {
        throw new Error(`Could not make the workspace database for ${t.slug}; see the log.`);
      }
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
      for (const o of t.operators) {
        if (!have.has(o.email)) await addMember(ctx(tx), { email: o.email, role: 'operator' });
      }
      await seedAccountDefaults(ctx(tx));
      // Taazaa's own catalogue; other tenants start with no offers.
      if (t.slug === 'taazaa') await seedOffers(ctx(tx));
      // Existing tenants never got the tenant.created event, so call the intake defaults directly.
      await seedIntakeDefaults(ctx(tx));
      await backfillR1b(ctx(tx));
      await backfillR1c(ctx(tx));
      await backfillReviewFlow(ctx(tx));
      // Every scored account gets a brief, as the first score would have given it.
      await seedPlaybooksDefaults(ctx(tx));
      await backfillBriefs(ctx(tx));
      // The funnel's journeys, for accounts that arrived before R3b-1 (the consumers fill them from then on).
      await backfillJourneys(ctx(tx));
      // Learned source trust, for sources whose accounts already have outcomes.
      await backfillTrust(ctx(tx));
    });
    // Sources come after the first transaction commits, so the people's users exist, named.
    await renameHandleUsers(NAMES);
    const emails = [ADMIN_EMAIL, t.ownerEmail, ...[...t.sellers, ...t.operators].map((s) => s.email)];
    await withTenant(row.id, async (tx) => {
      const c = ctx(tx);
      let adminSourceId = '';
      for (const email of emails) {
        const userId = await userIdForEmail(email);
        if (!userId) continue;
        const id = (await personSourceFor(c, userId)) ?? (await registerSource(c, { kind: 'person', name: NAMES[email]!, userId }, { namedAfterPerson: true })).id;
        if (email === ADMIN_EMAIL) adminSourceId = id;
      }
      const have = (await listSources(c)).find((s) => s.kind === 'agent' && s.name === DEV_AGENT_NAME);
      if (!have) await registerSource(c, { kind: 'agent', name: DEV_AGENT_NAME, parentId: adminSourceId });
      // Sample HubSpot data for a workspace on the mock connection (the default).
      const hubspot = (await listConnections(c)).find((x) => x.provider === 'hubspot');
      if (!hubspot || hubspot.mode === 'mock') await seedMockCrm(c);
    });
    if (t.slug === 'taazaa') taazaaId = row.id;
  }

  await backfillDisplayNames();

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
