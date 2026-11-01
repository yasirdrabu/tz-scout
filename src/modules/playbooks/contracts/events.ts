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
