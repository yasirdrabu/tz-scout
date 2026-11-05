import { z } from 'zod';

/** A manual cost line's fields. The service checks the values and words the errors. */
const lineFields = {
  occurred_on: z.string(),
  category: z.string(),
  amount_cents: z.number().int(),
  note: z.string().nullable().optional(),
};

export const addLineBody = z.strictObject(lineFields);
export const editLineBody = z.strictObject(lineFields).partial();
export const voidLineBody = z.strictObject({ reason: z.string().optional() });
