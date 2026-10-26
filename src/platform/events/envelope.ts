import { z } from 'zod';

export const ActorSchema = z.object({
  kind: z.enum(['user', 'agent', 'system']),
  id: z.string().min(1),
  sourceId: z.string().optional(),
  /** Set when a platform admin acts in a workspace under support access. Audit rows record it. */
  supportAccess: z.boolean().optional(),
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
  /** Set when a test API key started the work; handlers then only get mock adapters. */
  environment: z.enum(['live', 'test']).optional(),
  subject: z.object({ type: z.string().min(1), id: z.string().min(1) }).optional(),
  data: z.unknown(),
});

export type Envelope<D = unknown> = Omit<z.infer<typeof EnvelopeSchema>, 'data'> & { data: D };
