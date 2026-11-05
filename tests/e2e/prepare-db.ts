// Run with tsx (it resolves the `@/` alias): `tsx tests/e2e/prepare-db.ts [create|drop|dead-job|mock-activity <accountId> <personId> <personId> <personId>]`.
import { E2E_DB } from './env';

/** One sample AI run for the taazaa workspace, so the AI page has something to list. */
async function seedAiRun() {
  const { z } = await import('zod');
  const { defineTask, runTask } = await import('@/modules/ai-tasks');
  const { listTenants } = await import('@/modules/tenancy');
  const { withTenant } = await import('@/platform/db/tenant');
  const { newId } = await import('@/platform/ids');
  const tenant = (await listTenants()).find((t) => t.slug === 'taazaa')!;
  const echo = defineTask({
    name: 'echo_test',
    promptVersion: 'v1.0',
    model: 'claude-haiku-5-5',
    system: 'Echo the text.',
    buildUser: (i: { text: string }) => `Text: ${i.text}`,
    input: z.object({ text: z.string() }),
    output: z.object({ echoed: z.string() }),
    rules: (i) => ({ echoed: i.text }),
    mock: (i) => ({ echoed: `sample ${i.text}` }),
    maxTokens: 200,
  });
  await withTenant(tenant.id, (tx) =>
    runTask(
      { tenantId: tenant.id, actor: { kind: 'system', id: 'e2e' }, correlationId: newId('cor'), tx },
      echo,
      { text: 'Reach jane@acme.com or +1 415 555 0132' },
      { subject: { type: 'test', id: 'jane@acme.com' } },
    ),
  );
}

/** A dead job for the platform, so the System page has one to retry. */
async function seedDeadJob() {
  await import('@/entry/registry');
  const { recordDeadJob } = await import('@/platform/dead-jobs');
  const { newId } = await import('@/platform/ids');
  await recordDeadJob({
    name: 'platform.ping',
    error: 'e2e: forced failure',
    attempts: 3,
    envelope: {
      id: newId('job'),
      type: 'jobs.platform.ping',
      schemaVersion: 1,
      tenantId: 't_platform',
      occurredAt: new Date().toISOString(),
      actor: { kind: 'system', id: 'system' },
      correlationId: newId('cor'),
      data: { sentAt: new Date().toISOString() },
    },
  });
}

/**
 * Mock HubSpot activity for an account the e2e run handed off (R2d): a held meeting with the first two people, a
 * reply from the third and a meeting still to come. `argv`: accountId, then three person ids.
 */
async function seedMockActivity(accountId: string, [met1, met2, replier]: string[]) {
  await import('@/entry/registry');
  const { and, eq, inArray } = await import('drizzle-orm');
  const { listTenants } = await import('@/modules/tenancy');
  const { withTenant } = await import('@/platform/db/tenant');
  const { newId } = await import('@/platform/ids');
  const { handoff, link } = await import('@/modules/crm/db/schema');
  const { mockAddActivity } = await import('@/modules/crm/fixtures');
  const { runPersonPush } = await import('@/modules/crm');
  const tenant = (await listTenants()).find((t) => t.slug === 'taazaa')!;
  await withTenant(tenant.id, async (tx) => {
    const ctx = { tenantId: tenant.id, actor: { kind: 'system' as const, id: 'e2e' }, correlationId: newId('cor'), tx };
    const [h] = await tx.select().from(handoff).where(and(eq(handoff.accountId, accountId), eq(handoff.status, 'completed')));
    // The worker pushes added people as contacts on its own schedule; push any it has not reached yet.
    for (const personId of [met1!, met2!, replier!]) await runPersonPush(ctx, accountId, personId);
    const links = await tx.select().from(link).where(and(eq(link.scoutType, 'person'), inArray(link.scoutId, [met1!, met2!, replier!])));
    const [c1, c2, c3] = [met1!, met2!, replier!].map((personId) => links.find((l) => l.scoutId === personId)!.externalId);
    const company = h!.companyExternalId!;
    const now = Date.now();
    await mockAddActivity(ctx, { companyExternalId: company, kind: 'meeting', occurredAt: new Date(now), subject: 'Scoping call', startAt: new Date(now - 35 * 60_000), endAt: new Date(now - 5 * 60_000), status: 'held', contactExternalIds: [c1!, c2!] });
    await mockAddActivity(ctx, { companyExternalId: company, kind: 'meeting', occurredAt: new Date(now), subject: 'Roadmap review', startAt: new Date(now + 7 * 86_400_000), endAt: new Date(now + 7 * 86_400_000 + 1_800_000), status: 'scheduled', contactExternalIds: [c1!] });
    await mockAddActivity(ctx, { companyExternalId: company, kind: 'reply', occurredAt: new Date(now), subject: 'Re: Hello from Taazaa', contactExternalIds: [c3!] });
  });
}

async function main() {
  const { freshDatabase, dropScratchDatabase, POSTGRES_DOWN_MESSAGE, superuserSql } = await import(
    '../integration/helpers/db'
  );
  if (process.argv[2] === 'drop') {
    // The workspace databases the run made (D35), then its template and control plane.
    const su = superuserSql();
    try {
      const [found] = await su`select 1 from pg_database where datname = ${E2E_DB}`;
      if (found) {
        const control = superuserSql(E2E_DB);
        try {
          const rows = await control<{ d: string }[]>`select distinct database as d from tenancy.workspace_infra where database <> ${E2E_DB}`.catch(() => []);
          for (const r of rows) await dropScratchDatabase(r.d);
        } finally {
          await control.end({ timeout: 1 });
        }
      }
    } finally {
      await su.end({ timeout: 1 });
    }
    await dropScratchDatabase(`${E2E_DB}_template`);
    await dropScratchDatabase(E2E_DB);
    return;
  }
  if (process.argv[2] === 'mock-activity') {
    await seedMockActivity(process.argv[3]!, process.argv.slice(4));
    const { closeDbs } = await import('@/platform/db/client');
    await closeDbs();
    return;
  }
  if (process.argv[2] === 'dead-job') {
    await seedDeadJob();
    const { closeDbs } = await import('@/platform/db/client');
    await closeDbs();
    return;
  }
  const probe = superuserSql();
  try {
    await probe`select 1`;
  } catch (e) {
    throw new Error(`${POSTGRES_DOWN_MESSAGE} (${(e as Error).message})`);
  } finally {
    await probe.end({ timeout: 1 });
  }
  const db = await freshDatabase(E2E_DB);
  // The control plane, and the template every workspace database is copied from (D35).
  const { createDatabase, migrateControlPlane, migrateWorkspaceDatabase } = await import('@/platform/db/migrate');
  const { urlForDatabase } = await import('@/platform/db/workspace-pools');
  await migrateControlPlane({ adminUrl: db.adminUrl });
  const template = `${E2E_DB}_template`;
  await dropScratchDatabase(template);
  await createDatabase(template, undefined, db.adminUrl);
  await migrateWorkspaceDatabase(urlForDatabase(db.adminUrl, template));

  const { seed } = await import('@/entry/seed');
  await seed();
  await seedAiRun();
  const { closeDbs } = await import('@/platform/db/client');
  await closeDbs();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
