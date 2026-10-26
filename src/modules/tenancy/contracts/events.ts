import { z } from 'zod';
import { defineEvent } from '@/platform/events/registry';

export const tenantCreated = defineEvent(
  'tenancy.tenant.created',
  1,
  z.object({ tenantId: z.string(), slug: z.string(), createdBy: z.string() }),
);

export const memberAdded = defineEvent(
  'tenancy.member.added',
  1,
  z.object({ userId: z.string(), role: z.string(), invitedBy: z.string() }),
);

export const memberRemoved = defineEvent(
  'tenancy.member.removed',
  1,
  z.object({ userId: z.string(), removedBy: z.string() }),
);

export const memberRoleChanged = defineEvent(
  'tenancy.member.role_changed',
  1,
  z.object({ userId: z.string(), from: z.string(), to: z.string() }),
);

export const apiKeyCreated = defineEvent(
  'tenancy.api_key.created',
  1,
  z.object({
    keyId: z.string(),
    name: z.string(),
    prefix: z.string(),
    environment: z.enum(['live', 'test']),
    scopes: z.array(z.string()),
    sourceId: z.string().nullable(),
    createdBy: z.string(),
  }),
);

export const apiKeyRevoked = defineEvent(
  'tenancy.api_key.revoked',
  1,
  z.object({ keyId: z.string(), reason: z.string(), revokedBy: z.string() }),
);
