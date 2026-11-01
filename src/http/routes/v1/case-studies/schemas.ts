import { z } from 'zod';

const editable = {
  title: z.string(),
  client_name: z.string().nullable(),
  industry: z.string().nullable(),
  result: z.string().nullable(),
  link_url: z.string().nullable(),
  public: z.boolean(),
};

export const createCaseStudyBody = z.strictObject(editable).partial().required({ title: true });
export const patchCaseStudyBody = z.strictObject(editable).partial();
