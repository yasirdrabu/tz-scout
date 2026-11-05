import { z } from 'zod';

export const CRM_SYSTEMS = ['hubspot', 'salesforce', 'dynamics', 'dayko_kindle'] as const;
export type CrmSystem = (typeof CRM_SYSTEMS)[number];

export const HANDOFF_STATUSES = ['queued', 'running', 'completed', 'needs_decision', 'failed', 'cancelled'] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const ownershipActionSchema = z.enum(['assign', 'keep']);
export type OwnershipAction = z.infer<typeof ownershipActionSchema>;

/** What the CRM says about a company (Ruling 12). */
export const companyLifecycleSchema = z.enum(['none', 'open_deal', 'customer']);
export type CompanyLifecycle = z.infer<typeof companyLifecycleSchema>;

export const dealStatusSchema = z.enum(['open', 'won', 'lost']);
export type DealStatus = z.infer<typeof dealStatusSchema>;

export const activityKindSchema = z.enum(['email', 'reply', 'call', 'meeting', 'task_done']);
export type ActivityKind = z.infer<typeof activityKindSchema>;

/** `handoff.undone` (Ruling 7). */
export type HandoffUndone = {
  tasksClosed: string[];
  tasksLeftDone: string[];
  ownerReturnedTo: string | null;
  noteExternalId: string | null;
  /** `Owner left as is: <assigner> has no HubSpot owner` when the owner could not go back; else null. */
  ownerNote: string | null;
  /** Set when the undo job gave up; the other fields say what it had done by then. */
  failed?: boolean;
  reason?: string;
  /** Why Scout took it back: who declined it and why, or who withdrew it (Ruling 18). Undo records stored before this have none. */
  cause?: UndoCause;
  at: string;
};

export type UndoCause = { kind: 'declined' | 'withdrawn'; reasonLabel: string | null; byName: string | null };

/** Default follow-up days after the handoff. A tenant's list holds 1 to 5 unique ascending integers, each 1 to 60. */
export const DEFAULT_FOLLOW_UP_DAYS = [3, 7, 14];

/** The parts of the note and tasks that come from scoring, offers and playbooks (inverted dependency). */
export type HandoffPackage = {
  sections: { key: string; label: string; html: string }[];
  properties: Record<string, string | number | null>;
  firstTouch: { subject: string; body: string } | null;
  followUps: { day: number; subject: string; body: string }[];
  planSteps: { stepId: string; subject: string; body: string; dueAt: string }[];
};

/**
 * The account's plan as CRM's plan task sync reads it (R2c-3b Ruling 1): the open plan, else the most recent. `personIds`
 * are the step's people as the plan shows them (target buying roles, read live).
 */
export type PlanTasks = {
  planId: string;
  assignmentId: string;
  playbookName: string;
  status: 'active' | 'paused' | 'completed' | 'stopped' | 'abandoned';
  statusReason: string | null;
  sellerUserId: string | null;
  steps: {
    id: string;
    channel: 'email' | 'linkedin' | 'call' | 'meeting' | 'task';
    title: string;
    detail: string | null;
    subject: string | null;
    body: string | null;
    status: 'todo' | 'in_progress' | 'done' | 'skipped';
    ownerUserId: string | null;
    dueDate: string;
    crmTask: boolean;
    personIds: string[];
  }[];
  /** The account's other plans, for the close note of a task an earlier plan left open. */
  otherPlans: { planId: string; playbookName: string; status: PlanTasks['status']; statusReason: string | null }[];
};
