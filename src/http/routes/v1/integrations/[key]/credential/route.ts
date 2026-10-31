import { z } from 'zod';
import { CREDENTIAL_KINDS, integration, saveCredential, type CredentialKind } from '@/modules/integrations';
import { parseBody } from '../../../_lib/body';
import { v1Route } from '../../../_lib/v1-route';
import { MANAGE, integrationKey } from '../../key';

const body = z.strictObject({ kind: z.enum(CREDENTIAL_KINDS as [CredentialKind, ...CredentialKind[]]), value: z.string() });

/** Stores the credential sealed and answers with the service row, which shows only its last 4 characters. */
// The body carries the secret: never keep it under an Idempotency-Key (only POSTs are kept, this says so anyway).
export const PUT = v1Route({ ...MANAGE, idempotent: false }, async (req, _principal, ctx) => {
  const key = integrationKey(req);
  const input = await parseBody<{ kind: CredentialKind; value: string }>(req, body);
  await saveCredential(ctx, key, input);
  return integration(ctx, key);
});
