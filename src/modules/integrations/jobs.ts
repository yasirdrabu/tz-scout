import { and, isNotNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { defineJob } from '@/platform/events/registry';
import { defineJobHandler } from '@/platform/runtime/jobs';
import { credential } from './db/schema';

/** Hourly. Deletes credentials that were replaced more than an hour ago (in-flight jobs have finished). */
export const credentialsCleanupJob = defineJob('integrations.credentials.cleanup', z.object({}).passthrough());

export const credentialsCleanupHandler = defineJobHandler(credentialsCleanupJob, async (_e, ctx) => {
  await ctx.tx
    .delete(credential)
    .where(and(isNotNull(credential.replacedAt), lt(credential.replacedAt, sql`now() - interval '1 hour'`)));
});
