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
  at: string;
};

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
