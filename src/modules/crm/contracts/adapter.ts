import { z } from 'zod';
import type { Adapter } from '@/modules/integrations';
import { activityKindSchema, dealStatusSchema } from './types';

// CRM-E1: one contract for every CRM connector. Dates are ISO strings, money is integer cents.
// A connector never decides ownership; the handoff service passes the result in.

const id = z.string().min(1);
const iso = z.string().min(1);

export const lifecycleStageSchema = z.string();

export const dealSchema = z.object({
  externalId: id,
  companyExternalId: id,
  name: z.string(),
  stage: z.string().nullable(),
  status: dealStatusSchema,
  amountCents: z.number().int().nullable(),
  currency: z.string().nullable(),
  openedAt: iso.nullable(),
  closedAt: iso.nullable(),
});
export type CrmDeal = z.infer<typeof dealSchema>;

export const findCompanyInput = z.object({ domain: z.string().min(1) });
export const findCompanyOutput = z
  .object({
    externalId: id,
    name: z.string(),
    ownerExternalId: id.nullable(),
    lifecycle: lifecycleStageSchema.nullable(),
    openDeals: z.number().int().min(0),
    deals: z.array(dealSchema),
  })
  .nullable();

export const upsertCompanyInput = z.object({
  externalId: id.optional(),
  domain: z.string().min(1),
  name: z.string().min(1),
  website: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  employees: z.number().int().nullable().optional(),
  description: z.string().nullable().optional(),
  ownerExternalId: id.nullable(),
  /** True when the handoff decided the current owner may be replaced. */
  replaceableOwner: z.boolean(),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
});
export const upsertCompanyOutput = z.object({ externalId: id, created: z.boolean(), ownerExternalId: id.nullable() });

export const findPersonInput = z.union([
  z.object({ email: z.string().min(1) }),
  z.object({ name: z.string().min(1), companyExternalId: id }),
]);
export const findPersonOutput = z.object({ externalId: id, ownerExternalId: id.nullable() }).nullable();

export const upsertPersonInput = z.object({
  externalId: id.optional(),
  name: z.string().min(1),
  title: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phones: z.array(z.string()).optional(),
  linkedin: z.string().nullable().optional(),
  ownerExternalId: id.nullable(),
  takeOverOwner: z.boolean(),
  companyExternalId: id,
});
export const upsertPersonOutput = z.object({ externalId: id, created: z.boolean() });

export const upsertNoteInput = z.object({
  externalId: id.optional(),
  /** The fingerprint of the note as Scout last wrote it. A different one in the CRM means a person edited it. */
  expectedFingerprint: z.string().nullable().optional(),
  companyExternalId: id,
  personExternalIds: z.array(id).optional(),
  html: z.string().min(1),
  ownerExternalId: id.nullable(),
});
export const upsertNoteOutput = z.object({
  externalId: id,
  fingerprint: z.string().min(1),
  /** True when the existing note was edited in the CRM, so a new note was added and the edited one kept. */
  kept: z.boolean(),
});

export const taskStatusSchema = z.enum(['open', 'completed']);
export const upsertTaskInput = z.object({
  externalId: id.optional(),
  companyExternalId: id,
  personExternalId: id.nullable().optional(),
  subject: z.string().min(1),
  body: z.string(),
  ownerExternalId: id.nullable(),
  dueAt: iso.nullable(),
});
export const upsertTaskOutput = z.object({ externalId: id, status: taskStatusSchema });

export const closeTaskInput = z.object({ externalId: id });
export const closeTaskOutput = z.object({ status: taskStatusSchema });

export const listOwnersInput = z.object({});
export const listOwnersOutput = z.array(z.object({ externalId: id, name: z.string(), email: z.string().nullable(), active: z.boolean() }));

export const readFollowThroughInput = z.object({ companyExternalId: id, taskExternalIds: z.array(id) });
export const readFollowThroughOutput = z.object({
  tasks: z.array(z.object({ externalId: id, status: taskStatusSchema, dueAt: iso.nullable() })),
  emails: z.number().int().min(0),
  calls: z.number().int().min(0),
  meetings: z.number().int().min(0),
  deals: z.number().int().min(0),
  openDeals: z.number().int().min(0),
  stage: z.string().nullable(),
  ownerExternalId: id.nullable(),
  lastActivityAt: iso.nullable(),
});

export const listActivitiesInput = z.object({ companyExternalId: id, since: iso });
export const listActivitiesOutput = z.array(
  z.object({
    externalId: id,
    kind: activityKindSchema,
    occurredAt: iso,
    /** The CRM owner who did it (CRM-E5-S2-AC3), so Scout can name the user. */
    actorOwnerExternalId: id.nullable(),
  }),
);

export const listDealsInput = z.union([z.object({ companyExternalId: id }), z.object({ changedSince: iso })]);
export const listDealsOutput = z.array(dealSchema);

export const qualifiedRuleSchema = z.object({ property: z.string().min(1), value: z.string().min(1) });

export const qualifiedLeadSchema = z.object({
  contact: z.object({
    externalId: id,
    name: z.string().nullable(),
    email: z.string().nullable(),
    title: z.string().nullable(),
    phone: z.string().nullable(),
    linkedin: z.string().nullable(),
  }),
  company: z
    .object({
      externalId: id,
      name: z.string(),
      domain: z.string().nullable(),
      website: z.string().nullable(),
      location: z.string().nullable(),
      employees: z.number().int().nullable(),
      description: z.string().nullable(),
    })
    .nullable(),
  lifecycleStage: z.string(),
  qualifiedAt: iso,
  raw: z.record(z.string(), z.unknown()),
});
export type QualifiedLead = z.infer<typeof qualifiedLeadSchema>;

export const listQualifiedLeadsInput = z.object({ changedSince: iso, rule: qualifiedRuleSchema });
export const listQualifiedLeadsOutput = z.array(qualifiedLeadSchema);

/** One contact, with the same shape as a list entry, or null when it no longer matches the rule. */
export const readQualifiedLeadInput = z.object({ contactId: id, rule: qualifiedRuleSchema });
export const readQualifiedLeadOutput = qualifiedLeadSchema.nullable();

export const existingPropertiesInput = z.object({});
export const existingPropertiesOutput = z.array(z.string());

export const setUpPropertiesInput = z.object({
  groupName: z.string().min(1),
  groupLabel: z.string().min(1).optional(),
  properties: z.array(
    z.object({
      name: z.string().min(1),
      label: z.string().min(1),
      type: z.enum(['string', 'number', 'date', 'enumeration']),
      fieldType: z.enum(['text', 'textarea', 'number', 'select', 'date']).optional(),
      options: z.array(z.string()).optional(),
      description: z.string().optional(),
    }),
  ),
});
export const setUpPropertiesOutput = z.object({ created: z.array(z.string()) });

export const verifyWebhookInput = z.object({
  method: z.string().min(1),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  rawBody: z.string(),
});
export const verifyWebhookOutput = z.boolean();

export const webhookEventSchema = z.object({ kind: z.enum(['deal', 'activity', 'lifecycle']), externalIds: z.array(id) });
export const parseWebhookInput = z.object({ rawBody: z.string() });
export const parseWebhookOutput = z.array(webhookEventSchema);

/** What a connector can do (CRM-E1-S2). When one is false, the module falls back to polling. */
export const capabilitiesSchema = z.object({
  webhooks: z.object({ deals: z.boolean(), activities: z.boolean(), lifecycle: z.boolean() }),
  customProperties: z.boolean(),
  taskDueDates: z.boolean(),
  noteFingerprint: z.boolean(),
  ownerRoster: z.boolean(),
});
export type CrmCapabilities = z.infer<typeof capabilitiesSchema>;

/** Every operation's input and output schema, by operation name. */
export const crmOperations = {
  findCompany: { input: findCompanyInput, output: findCompanyOutput },
  upsertCompany: { input: upsertCompanyInput, output: upsertCompanyOutput },
  findPerson: { input: findPersonInput, output: findPersonOutput },
  upsertPerson: { input: upsertPersonInput, output: upsertPersonOutput },
  upsertNote: { input: upsertNoteInput, output: upsertNoteOutput },
  upsertTask: { input: upsertTaskInput, output: upsertTaskOutput },
  closeTask: { input: closeTaskInput, output: closeTaskOutput },
  listOwners: { input: listOwnersInput, output: listOwnersOutput },
  readFollowThrough: { input: readFollowThroughInput, output: readFollowThroughOutput },
  listActivities: { input: listActivitiesInput, output: listActivitiesOutput },
  listDeals: { input: listDealsInput, output: listDealsOutput },
  listQualifiedLeads: { input: listQualifiedLeadsInput, output: listQualifiedLeadsOutput },
  readQualifiedLead: { input: readQualifiedLeadInput, output: readQualifiedLeadOutput },
  existingProperties: { input: existingPropertiesInput, output: existingPropertiesOutput },
  setUpProperties: { input: setUpPropertiesInput, output: setUpPropertiesOutput },
  verifyWebhook: { input: verifyWebhookInput, output: verifyWebhookOutput },
  parseWebhook: { input: parseWebhookInput, output: parseWebhookOutput },
} as const;

type Ops = typeof crmOperations;
type Method<K extends keyof Ops> = (input: z.infer<Ops[K]['input']>) => Promise<z.infer<Ops[K]['output']>>;

/** The adapter the handoff services call. Test (from Integrations) is part of it; Task 3 adds `facts` to its result. */
export type CrmAdapter = Adapter & { capabilities: CrmCapabilities } & { [K in keyof Ops]: Method<K> };
