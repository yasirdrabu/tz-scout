import { z } from 'zod';
import { OWNER_ROLES, STEP_CHANNELS, STOP_RULES, TEMPLATE_STATUSES, type StepInput, type TemplateDetail, type TemplateSummary } from '@/modules/playbooks';

const step = z.strictObject({
  order: z.number().int().optional(),
  day: z.number('Use a day from 0 to 365.').int('Use a day from 0 to 365.').min(0, 'Use a day from 0 to 365.').max(365, 'Use a day from 0 to 365.'),
  channel: z.enum(STEP_CHANNELS, 'Pick email, linkedin, call, meeting or task.'),
  owner_role: z.enum(OWNER_ROLES, 'Pick seller, leader or operator.'),
  title: z.string('Give every step a title.'),
  detail: z.string().nullable().optional(),
  target_buying_roles: z.array(z.string()).optional(),
  crm_task: z.boolean().optional(),
  subject: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
});

const editable = {
  name: z.string('Give the playbook a name.'),
  description: z.string().nullable(),
  when_to_use: z.string().nullable(),
  status: z.enum(TEMPLATE_STATUSES, 'Use draft, active or archived.'),
  stop_when: z.enum(STOP_RULES, 'Use reply_or_meeting, meeting or never.'),
  steps: z.array(step).max(60, 'Keep a playbook to 60 steps.'),
};

export const createTemplateBody = z.strictObject(editable).partial().required({ name: true });
export const patchTemplateBody = z.strictObject(editable).partial();

/** Step objects in snake_case, as sent, to the camelCase the service takes. */
export function stepInputs(steps: z.infer<typeof step>[] | undefined): StepInput[] | undefined {
  return steps?.map((s) => ({
    ...(s.order !== undefined ? { order: s.order } : {}),
    day: s.day,
    channel: s.channel,
    ownerRole: s.owner_role,
    title: s.title,
    detail: s.detail ?? null,
    targetBuyingRoles: s.target_buying_roles ?? [],
    crmTask: s.crm_task ?? true,
    subject: s.subject ?? null,
    body: s.body ?? null,
  }));
}

/** A template without its tenant id. */
export function templateOut<T extends TemplateSummary | TemplateDetail>(t: T): Omit<T, 'tenantId'> {
  const { tenantId: _tenant, ...rest } = t;
  return rest;
}

/** Parsed route body to what the service takes: the top-level keys are camel already (parseBody), `steps` is not. */
export function withSteps<T extends { steps?: unknown }>(body: T): Omit<T, 'steps'> & { steps?: StepInput[] } {
  const { steps, ...rest } = body;
  return { ...rest, ...(steps === undefined ? {} : { steps: stepInputs(steps as z.infer<typeof step>[]) }) };
}
