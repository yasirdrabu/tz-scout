import { audit } from '@/platform/audit';
import { defineJobHandler } from '@/platform/runtime/jobs';
import { memberActivatedAuditJob, workspaceProvisionJob } from './contracts/jobs';
import { provisionWorkspace } from './services/provisioning';

export const memberActivatedAuditHandler = defineJobHandler(memberActivatedAuditJob, (e, ctx) =>
  audit(ctx, {
    action: 'tenancy.member.activated',
    subject: { type: 'membership', id: e.data.membershipId },
    before: { status: 'invited' },
    after: { status: 'active', role: e.data.role },
  }),
);

export const workspaceProvisionHandler = defineJobHandler(workspaceProvisionJob, async (e, ctx) => {
  await provisionWorkspace(e.data.tenantId, ctx.signal);
});
