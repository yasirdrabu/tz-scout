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

/**
 * Makes a new workspace's own database (`per_workspace` mode, D35): create, migrate, seed, active. Runs
 * under `t_platform` (the workspace is not open yet). Each step is safe to run again, so a retry resumes.
 */
export const workspaceProvisionJob = defineJob('tenancy.workspace_provision', z.object({ tenantId: z.string() }), {
  timeoutMs: 300_000,
});
