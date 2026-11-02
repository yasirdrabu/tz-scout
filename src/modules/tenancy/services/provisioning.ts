import { and, eq, sql } from 'drizzle-orm';
import { PLATFORM_TENANT, platformAudit } from '@/platform/audit';
import { config } from '@/platform/config';
import { adminTransaction, controlAdminDb } from '@/platform/db/client';
import { forgetWorkspace } from '@/platform/db/doors';
import { createDatabase, databaseExists, migrateWorkspaceDatabase } from '@/platform/db/migrate';
import { urlForDatabase } from '@/platform/db/workspace-pools';
import { ScoutError } from '@/platform/errors';
import type { Tx } from '@/platform/db/tenant';
import type { Actor, Envelope } from '@/platform/events/envelope';
import { enqueueJob } from '@/platform/events/outbox';
import { log } from '@/platform/log';
import { errorText } from '@/platform/scrub-error';
import { workspaceProvisionJob } from '../contracts/jobs';
import { workspaceSeeder } from '../contracts/workspace-seeder';
import { workspaceInfra } from '../db/schema';
import type { AdminActor } from './tenants';

/** The steps of provisioning, in order; a failed workspace records the one that failed. */
export type ProvisionStep = 'database' | 'migrate' | 'seed' | 'active';

/** The `tenancy.tenant.created` event published with the tenant, from the control-plane outbox. */
async function tenantCreatedEvent(tenantId: string): Promise<Envelope | null> {
  const rows = (await controlAdminDb.execute(
    sql`select payload from platform.outbox where tenant_id = ${tenantId} and payload->>'type' = 'tenancy.tenant.created' order by seq limit 1`,
  )) as unknown as { payload: Envelope }[];
  return rows[0]?.payload ?? null;
}

/**
 * Makes a `provisioning` workspace's database (D35): create it (copied from `scout_t_template` when that
 * exists), bootstrap and migrate it (recording `schema_versions`), seed its defaults (the
 * `tenancy.tenant.created` consumers, through the registered seeder), then mark it `active`. Every step
 * is safe to repeat, so a retry resumes where it stopped. A failure marks the workspace `failed` with
 * the step and error and returns (an admin retries it); a workspace not `provisioning` is left alone.
 */
export async function provisionWorkspace(tenantId: string): Promise<'active' | 'failed' | 'skipped'> {
  const [row] = await controlAdminDb.select().from(workspaceInfra).where(eq(workspaceInfra.tenantId, tenantId));
  if (!row || row.status !== 'provisioning') return 'skipped';
  const only = and(eq(workspaceInfra.tenantId, tenantId), eq(workspaceInfra.status, 'provisioning'));
  let step: ProvisionStep = 'database';
  try {
    const template = (await databaseExists(config.workspaceTemplateDatabase)) ? config.workspaceTemplateDatabase : undefined;
    await createDatabase(row.database, template);
    step = 'migrate';
    const { versions } = await migrateWorkspaceDatabase(urlForDatabase(config.databaseAdminUrl, row.database));
    await controlAdminDb.update(workspaceInfra).set({ schemaVersions: versions, updatedAt: new Date() }).where(only);
    step = 'seed';
    const created = await tenantCreatedEvent(tenantId);
    const seed = workspaceSeeder();
    if (created && seed) await seed(created);
    step = 'active';
    await controlAdminDb.update(workspaceInfra).set({ status: 'active', failedStep: null, failedError: null, updatedAt: new Date() }).where(only);
    forgetWorkspace(tenantId);
    return 'active';
  } catch (e) {
    const error = errorText(e).slice(0, 2000);
    await controlAdminDb.update(workspaceInfra).set({ status: 'failed', failedStep: step, failedError: error, updatedAt: new Date() }).where(only);
    forgetWorkspace(tenantId);
    log.error({ tenantId, step, err: error }, 'provisioning: workspace failed');
    return 'failed';
  }
}

/** Enqueues provisioning for `tenantId`, in `tx` (a control-plane transaction), under `t_platform`. */
export async function enqueueProvisioning(tx: Tx, by: { actor: Actor; correlationId: string }, tenantId: string): Promise<void> {
  await enqueueJob({ tenantId: PLATFORM_TENANT, actor: by.actor, correlationId: by.correlationId, tx }, workspaceProvisionJob, { tenantId });
}

/**
 * Sends a `failed` workspace through provisioning again (`POST /admin/tenants/{id}:retry-provisioning`):
 * back to `provisioning`, and the job enqueued in the same transaction. 404 for an unknown tenant, 409
 * unless it is `failed`. Written to the platform audit log.
 */
export async function retryProvisioning(by: AdminActor, tenantId: string): Promise<void> {
  await adminTransaction(by.tx, async (tx) => {
    const [row] = await tx.select().from(workspaceInfra).where(eq(workspaceInfra.tenantId, tenantId)).for('update');
    if (!row) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That tenant was not found.' });
    if (row.status !== 'failed') throw new ScoutError({ slug: 'not-failed', status: 409, title: 'Only a failed workspace can be retried.' });
    await tx
      .update(workspaceInfra)
      .set({ status: 'provisioning', failedStep: null, failedError: null, updatedAt: new Date() })
      .where(eq(workspaceInfra.tenantId, tenantId));
    await enqueueProvisioning(tx, by, tenantId);
    await platformAudit(
      {
        actor: by.actor,
        correlationId: by.correlationId,
        action: 'tenancy.workspace.provisioning_retried',
        subject: { type: 'tenant', id: tenantId },
        before: { status: 'failed', failedStep: row.failedStep, failedError: row.failedError },
        after: { status: 'provisioning' },
      },
      tx,
    );
  });
  forgetWorkspace(tenantId);
}
