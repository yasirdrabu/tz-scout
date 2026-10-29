import { z } from 'zod';
import { defineJob } from '@/platform/events/registry';

/** Hourly, one schedule per tenant: accepts pending assignments that waited out the tenant's working days. */
export const autoAcceptJob = defineJob('routing.assignments.auto_accept', z.object({}), {});
