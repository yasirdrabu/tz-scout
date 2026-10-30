import { z } from 'zod';
import { defineJob } from '@/platform/events/registry';

/** Pushes one handoff to the CRM. Six runs at most (Ruling 4). */
export const handoffPushJob = defineJob('crm.handoff.push', z.object({ handoffId: z.string() }), { maxDeliver: 6 });

/** Undoes what a handoff wrote after a decline or withdrawal (Ruling 7). */
export const handoffUndoJob = defineJob('crm.handoff.undo', z.object({ handoffId: z.string() }), {});

/** Pushes a person added after the handoff (Ruling 22). */
export const personPushJob = defineJob('crm.person.push', z.object({ accountId: z.string(), personId: z.string() }), {});

/** Reads one account's follow-through, activities and deals now (Ruling 18). */
export const syncJob = defineJob('crm.sync', z.object({ accountId: z.string() }), {});

/** Every 15 minutes, one schedule per tenant (Ruling 17). */
export const activityPollJob = defineJob('crm.activity.poll', z.object({}), {});

/** Hourly, one schedule per tenant. */
export const dealsPollJob = defineJob('crm.deals.poll', z.object({}), {});

/** Daily at 05:00 UTC, one schedule per tenant. */
export const ownersSyncJob = defineJob('crm.owners.sync', z.object({}), {});

/** Checks one new account against the CRM (Ruling 11). */
export const companyCheckJob = defineJob('crm.company.check', z.object({ accountId: z.string() }), {});
