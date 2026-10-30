import { z } from 'zod';

export const STAGES = ['arrived', 'reviewed', 'assigned', 'engaged', 'opportunity', 'won', 'lost', 'declined'] as const;
export const stageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof stageSchema>;

export const ASSIGNMENT_STATUSES = ['pending', 'accepted', 'declined', 'withdrawn', 'replaced'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/** The `review_flags` strings that go to the account summary. */
export const REVIEW_FLAGS = ['declined_by_seller', 'new_from', 'handoff_needs_decision', 'handoff_failed'] as const;
export type ReviewFlag = (typeof REVIEW_FLAGS)[number];

export const HANDOFF_STATES = ['sending', 'in_crm', 'needs_decision', 'failed', 'cancelled'] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

/** The CRM handoff as the review sees it; the event with the later `at` wins (Ruling 19). `handoffId` is null until an event names it. */
export type HandoffFlag = { handoffId: string | null; state: HandoffState; reason?: string; currentOwnerName?: string | null; at: string };

/** `account_review.flags`. */
export type ReviewFlags = {
  newFrom?: { sourceId: string; at: string };
  declinedBySeller?: { assignmentId: string; sellerUserId: string; sellerName: string; reasonKey: string; reasonLabel: string; at: string };
  handoff?: HandoffFlag;
};

/** Everything Accounts needs to know about an account's review, sent whole on every write (Ruling 1). */
export const reviewSnapshotSchema = z.object({
  reviewStatusKey: z.string(),
  ownerUserId: z.string().nullable(),
  ownerHistoryUserIds: z.array(z.string()),
  hasOpenAssignment: z.boolean(),
  stage: stageSchema,
  reviewFlags: z.array(z.enum(REVIEW_FLAGS)),
});
export type ReviewSnapshot = z.infer<typeof reviewSnapshotSchema>;
