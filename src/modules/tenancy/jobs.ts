import { audit } from '@/platform/audit';
import { defineJobHandler } from '@/platform/runtime/jobs';
import { memberActivatedAuditJob } from './contracts/jobs';

export const memberActivatedAuditHandler = defineJobHandler(memberActivatedAuditJob, (e, ctx) =>
  audit(ctx, {
    action: 'tenancy.member.activated',
    subject: { type: 'membership', id: e.data.membershipId },
    before: { status: 'invited' },
    after: { status: 'active', role: e.data.role },
  }),
);
