import { z } from 'zod';

const editable = {
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  keywords: z.array(z.string()),
  default_playbook_id: z.string().nullable(),
  brief_template_key: z.string().nullable(),
  sort: z.number().int(),
};

export const createPracticeBody = z.strictObject(editable).partial().required({ name: true });
export const patchPracticeBody = z.strictObject(editable).partial();
