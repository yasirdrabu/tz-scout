import { and, isNotNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { adminDb } from '@/platform/db/client';
import { defineJob } from '@/platform/events/registry';
import { defineJobHandler } from '@/platform/runtime/jobs';
import { credential } from './db/schema';

/** Hourly. Deletes credentials that were replaced more than an hour ago (in-flight jobs have finished). */
export const credentialsCleanupJob = defineJob('integrations.credentials.cleanup', z.object({}).passthrough());

/**
 * A platform-wide system job, not a per-tenant one: one scheduled run cleans every tenant, so it
 * deletes through adminDb (which bypasses row level security) instead of the single tenant that
 * the message happens to carry. It only removes rows that were replaced over an hour ago.
 */
export const credentialsCleanupHandler = defineJobHandler(credentialsCleanupJob, async () => {
  await adminDb
    .delete(credential)
    .where(and(isNotNull(credential.replacedAt), lt(credential.replacedAt, sql`now() - interval '1 hour'`)));
});
