import { z } from 'zod';

export const STAGES = ['arrived', 'reviewed', 'assigned', 'engaged', 'opportunity', 'won', 'lost', 'declined'] as const;
export const stageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof stageSchema>;

export const ASSIGNMENT_STATUSES = ['pending', 'accepted', 'declined', 'withdrawn', 'replaced'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/** The `review_flags` strings that go to the account summary. */
export const REVIEW_FLAGS = ['declined_by_seller', 'new_from'] as const;
export type ReviewFlag = (typeof REVIEW_FLAGS)[number];

/** `account_review.flags`. */
export type ReviewFlags = {
  newFrom?: { sourceId: string; at: string };
  declinedBySeller?: { assignmentId: string; sellerUserId: string; sellerName: string; reasonKey: string; reasonLabel: string; at: string };
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
