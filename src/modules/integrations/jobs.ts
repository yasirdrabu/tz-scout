import { and, isNotNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { listWorkspaceDatabases } from '@/platform/db/doors';
import { defineJob } from '@/platform/events/registry';
import { defineJobHandler } from '@/platform/runtime/jobs';
import { credential } from './db/schema';

/** Hourly. Deletes credentials that were replaced more than an hour ago (in-flight jobs have finished). */
export const credentialsCleanupJob = defineJob('integrations.credentials.cleanup', z.object({}).passthrough());

/**
 * A platform-wide system job, not a per-tenant one: one scheduled run cleans every tenant, so it
 * deletes in each workspace database as scout_admin (which bypasses row level security) instead of
 * the single tenant that the message happens to carry. It only removes rows that were replaced over
 * an hour ago. A database that fails fails the run, which is retried; the deletes are safe to repeat.
 */
export const credentialsCleanupHandler = defineJobHandler(credentialsCleanupJob, async () => {
  for (const { admin } of await listWorkspaceDatabases()) {
    await admin
      .delete(credential)
      .where(and(isNotNull(credential.replacedAt), lt(credential.replacedAt, sql`now() - interval '1 hour'`)));
  }
});
