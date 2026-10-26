'use server';

import {
  CREDENTIAL_KINDS,
  saveCredential,
  setDisabled,
  setMode,
  testConnection,
  type ConnectionMode,
  type CredentialKind,
} from '@/modules/integrations';
import { act, str, type ActionResult } from '@/server/action';
import { tenantAction } from '@/server/page-context';

const path = (fd: FormData) => `/t/${str(fd, 'tenant')}/settings/integrations`;

export async function saveCredentialAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const kind = str(fd, 'kind') as CredentialKind;
  return act(
    () =>
      tenantAction(str(fd, 'tenant'), 'integrations:manage', (ctx) =>
        saveCredential(ctx, str(fd, 'provider'), {
          kind: CREDENTIAL_KINDS.includes(kind) ? kind : 'api_key',
          value: str(fd, 'value'),
        }),
      ),
    { revalidate: path(fd), message: 'Credential stored. Test the connection next.' },
  );
}

export async function testConnectionAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let result: { ok: boolean; message: string } | undefined;
  const r = await act(
    async () => {
      result = await tenantAction(str(fd, 'tenant'), 'integrations:manage', (ctx) => testConnection(ctx, str(fd, 'provider')));
    },
    { revalidate: path(fd) },
  );
  if (!r.ok || !result) return r;
  return result.ok ? { ok: true, message: result.message } : { ok: false, error: result.message };
}

export async function setModeAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const mode: ConnectionMode = str(fd, 'mode') === 'live' ? 'live' : 'mock';
  return act(
    () => tenantAction(str(fd, 'tenant'), 'integrations:manage', (ctx) => setMode(ctx, str(fd, 'provider'), mode)),
    { revalidate: path(fd), message: mode === 'live' ? 'Now live.' : 'Now using sample data.' },
  );
}

export async function setDisabledAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const disabled = str(fd, 'disabled') === 'true';
  return act(
    () => tenantAction(str(fd, 'tenant'), 'integrations:manage', (ctx) => setDisabled(ctx, str(fd, 'provider'), disabled)),
    { revalidate: path(fd), message: disabled ? 'Turned off.' : 'Turned on.' },
  );
}
