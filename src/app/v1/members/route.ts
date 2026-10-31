import { z } from 'zod';
import { openAssignmentCounts } from '@/modules/routing';
import { DataLimitSchema, ROLES, inviteMembers, memberCounts, memberList, type DataLimit, type Role } from '@/modules/tenancy';
import { config } from '@/platform/config';
import { parseBody } from '../_lib/body';
import { requireMembersRead } from '../_lib/members';
import { v1Route } from '../_lib/v1-route';

export const dynamic = 'force-dynamic';

// Invited, active and suspended members with sign-in facts, practice access, their open accounts and
// what the caller may do to each; `counts` per status and active members per sign-in method.
export const GET = v1Route({}, async (_req, principal, ctx) => {
  requireMembersRead(principal);
  const open = await openAssignmentCounts(ctx);
  const rows = await memberList(ctx);
  return { data: rows.map((m) => ({ ...m, openAccountCount: open[m.userId] ?? 0 })), counts: memberCounts(rows) };
});

const inviteBody = z.strictObject({
  emails: z.array(z.string()).min(1).max(100),
  role: z.enum(ROLES),
  data_limit: DataLimitSchema.nullable().optional(),
});

/**
 * Invites people (Decision 18): one membership per address, no email sent. They get in the first
 * time they sign in at `sign_in_url`. Results are per address, in the order sent.
 */
export const POST = v1Route({ permission: 'members:manage', peopleOnly: true }, async (req, _principal, ctx) => {
  const body = await parseBody<{ emails: string[]; role: Role; dataLimit?: DataLimit | null }>(req, inviteBody);
  return { results: await inviteMembers(ctx, body), signInUrl: `${config.publicUrl}/signin` };
});
