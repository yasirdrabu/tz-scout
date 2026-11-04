import { z } from 'zod';
import { defineEvent } from '@/platform/events/registry';

/** After a draft or an edit wrote sections. `mode` is null for a person's edit. */
export const briefUpdated = defineEvent(
  'playbooks.brief.updated',
  1,
  z.object({
    accountId: z.string(),
    sectionKeys: z.array(z.string()),
    origin: z.enum(['ai', 'rules', 'human']),
    mode: z.enum(['live', 'mock', 'rules']).nullable(),
  }),
);

const tier = z.enum(['act_now', 'good_fit', 'watch']);
const planStatus = z.enum(['active', 'paused', 'completed', 'stopped', 'abandoned']);

/** A plan started on an accepted assignment (Ruling 12). `offerId` and `tier` are null when the assigner picked a playbook for an account with no lead offer or no mappable tier. */
export const planCreated = defineEvent(
  'playbooks.plan.created',
  1,
  z.object({
    planId: z.string(),
    accountId: z.string(),
    offerId: z.string().nullable(),
    tier: tier.nullable(),
    templateId: z.string(),
    templateVersion: z.number().int(),
    assignmentId: z.string(),
    sellerUserId: z.string().nullable(),
    stopWhen: z.enum(['reply_or_meeting', 'meeting', 'never']),
    steps: z.array(
      z.object({
        id: z.string(),
        order: z.number().int(),
        day: z.number().int(),
        channel: z.enum(['email', 'linkedin', 'call', 'meeting', 'task']),
        title: z.string(),
        ownerUserId: z.string().nullable(),
        dueDate: z.string(),
        crmTask: z.boolean(),
        subject: z.string().nullable(),
        body: z.string().nullable(),
      }),
    ),
  }),
);

/** Any change to a plan after it started: status, steps or owners. */
export const planChanged = defineEvent(
  'playbooks.plan.changed',
  1,
  z.object({
    planId: z.string(),
    accountId: z.string(),
    status: planStatus,
    changed: z.array(z.enum(['status', 'steps', 'owners'])),
    reason: z.string().optional(),
  }),
);

export const stepCompleted = defineEvent(
  'playbooks.step.completed',
  1,
  z.object({
    planId: z.string(),
    stepId: z.string(),
    accountId: z.string(),
    channel: z.enum(['email', 'linkedin', 'call', 'meeting', 'task']),
    doneBy: z.string().nullable(),
    doneAt: z.string(),
  }),
);

/** An accepted assignment started no plan, so a screen can say why the plan is empty. */
export const planNotStarted = defineEvent(
  'playbooks.plan.not_started',
  1,
  z.object({
    accountId: z.string(),
    assignmentId: z.string(),
    reason: z.enum(['no_playbook_chosen', 'no_offer_playbook', 'template_archived', 'plan_open']),
  }),
);
