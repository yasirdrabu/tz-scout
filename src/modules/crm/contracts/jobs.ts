import { z } from 'zod';
import { defineJob } from '@/platform/events/registry';

/** Runs of a push that may do CRM work (Ruling 4). */
export const PUSH_MAX_ATTEMPTS = 6;

/**
 * Retries of a push wait 30 s, 2, 10 and 30 minutes, then an hour: a create that timed out may still land in HubSpot,
 * and its search index lags, so a retry seconds later could miss it and create a second company (final review I7).
 */
export const PUSH_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000, 3_600_000];

/**
 * Pushes one handoff to the CRM. One delivery more than PUSH_MAX_ATTEMPTS is kept for giving up, so a handoff
 * whose last run died (time limit, lock wait, aborted transaction) is still marked failed. A live push makes about
 * 20 HubSpot calls and may sleep on 429s, hence the longer time limit.
 */
export const handoffPushJob = defineJob('crm.handoff.push', z.object({ handoffId: z.string() }), {
  maxDeliver: PUSH_MAX_ATTEMPTS + 1,
  backoffMs: PUSH_BACKOFF_MS,
  timeoutMs: 120_000,
});

/** Runs of an undo that may do CRM work; one delivery more is kept for giving up, as for the push. */
export const UNDO_MAX_ATTEMPTS = 6;

/** Undoes what a handoff wrote after a decline or withdrawal (Ruling 7). */
export const handoffUndoJob = defineJob(
  'crm.handoff.undo',
  z.object({ handoffId: z.string(), kind: z.enum(['declined', 'withdrawn']), reasonLabel: z.string().nullable(), by: z.string().nullable() }),
  { maxDeliver: UNDO_MAX_ATTEMPTS + 1, timeoutMs: 120_000 },
);

/** Pushes a person added after the handoff (Ruling 22). */
export const personPushJob = defineJob('crm.person.push', z.object({ accountId: z.string(), personId: z.string() }), { backoffMs: PUSH_BACKOFF_MS });

/** Reads one account's follow-through, activities and deals now (Ruling 18); the activity poll queues one per account. A live sync makes about 6 HubSpot calls. */
export const syncJob = defineJob('crm.sync', z.object({ accountId: z.string() }), { timeoutMs: 120_000 });

/** Every 15 minutes, one schedule per tenant (Ruling 17): queues a `crm.sync` per due account. */
export const activityPollJob = defineJob('crm.activity.poll', z.object({}), {});

/** Hourly, one schedule per tenant. */
export const dealsPollJob = defineJob('crm.deals.poll', z.object({}), {});

/** Daily at 05:00 UTC, one schedule per tenant. */
export const ownersSyncJob = defineJob('crm.owners.sync', z.object({}), {});

/** Checks one new account against the CRM (Ruling 11). */
export const companyCheckJob = defineJob('crm.company.check', z.object({ accountId: z.string() }), {});
