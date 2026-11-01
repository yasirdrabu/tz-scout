import { z } from 'zod';
import type { ReasonEdit, StatusEdit } from '@/modules/routing';

// The service checks colors, names, hours and lists, so a person gets the plain-words messages.
export const statusItem = z.strictObject({
  key: z.string().nullish(),
  label: z.string(),
  color: z.string(),
  description: z.string().nullish(),
  set_by: z.string(),
  flag_after_hours: z.number().nullable(),
  archived: z.boolean().optional(),
});

export const reasonItem = z.strictObject({
  key: z.string().nullish(),
  label: z.string(),
  applies_to: z.string(),
  note_required: z.boolean(),
  archived: z.boolean().optional(),
});

// `parseBody` camelCases only the top-level keys, so the items arrive in snake_case.
export const toStatusEdits = (items: z.infer<typeof statusItem>[]): StatusEdit[] =>
  items.map((s) => ({ key: s.key, label: s.label, color: s.color, description: s.description, setBy: s.set_by, flagAfterHours: s.flag_after_hours, archived: s.archived }));

export const toReasonEdits = (items: z.infer<typeof reasonItem>[]): ReasonEdit[] =>
  items.map((r) => ({ key: r.key, label: r.label, appliesTo: r.applies_to, noteRequired: r.note_required, archived: r.archived }));
