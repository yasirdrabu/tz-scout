import { z } from 'zod';
import { defineJob } from '@/platform/events/registry';

/**
 * Writes the `tenancy.member.activated` audit row in the membership's workspace. Enqueued on the
 * control plane in the sign-in's transaction (D35), so it is not lost when a workspace is down, and
 * written once per job (`processed_event`) however often it is retried.
 */
export const memberActivatedAuditJob = defineJob(
  'tenancy.member_activated_audit',
  z.object({ membershipId: z.string(), role: z.string() }),
);
