import { z } from 'zod';

export const ActorSchema = z.object({
  kind: z.enum(['user', 'agent', 'system']),
  id: z.string().min(1),
  sourceId: z.string().optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const EnvelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  tenantId: z.string().min(1),
  occurredAt: z.string().datetime(),
  actor: ActorSchema,
  correlationId: z.string().min(1),
  causationId: z.string().optional(),
  subject: z.object({ type: z.string().min(1), id: z.string().min(1) }).optional(),
  data: z.unknown(),
});

export type Envelope<D = unknown> = Omit<z.infer<typeof EnvelopeSchema>, 'data'> & { data: D };
