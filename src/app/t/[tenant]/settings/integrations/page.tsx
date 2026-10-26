import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/client';
import { TenantShell } from '@/components/shell';
import { Badge, Card, CardHeader, EmptyState, Field, Notice, PageHeader, Table, Td, Th, type Tone } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import {
  CREDENTIAL_KINDS,
  PROVIDERS,
  listConnections,
  recentCalls,
  type CallView,
  type ConnectionView,
} from '@/modules/integrations';
import { withTenant } from '@/platform/db/tenant';
import { newId } from '@/platform/ids';
import { pageContext } from '@/server/page-context';
import { saveCredentialAction, setDisabledAction, setModeAction, testConnectionAction } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Integrations' };

const KIND_LABEL: Record<(typeof CREDENTIAL_KINDS)[number], string> = {
  api_key: 'Key',
  private_app_token: 'Private app token',
  oauth_tokens: 'Sign-in tokens',
  client_secret: 'Client secret',
};

function statusChip(c: ConnectionView): { tone: Tone; text: string } {
  switch (c.status) {
    case 'failing':
      return { tone: 'bad', text: `Failing: ${c.lastError ?? 'the last call failed'}` };
    case 'connected':
      return { tone: 'good', text: 'Connected' };
    case 'disabled':
      return { tone: 'muted', text: 'Turned off' };
    default:
      return { tone: 'neutral', text: 'Not set up' };
  }
}

const OUTCOME: Record<string, { tone: Tone; text: string }> = {
  ok: { tone: 'good', text: 'Worked' },
  error: { tone: 'bad', text: 'Failed' },
  rate_limited: { tone: 'near', text: 'Slowed down' },
  blocked_by_cap: { tone: 'near', text: 'Blocked by limit' },
};

function Manage({ tenant, c, calls }: { tenant: string; c: ConnectionView; calls: CallView[] }) {
  const hidden = (
    <>
      <input type="hidden" name="tenant" value={tenant} />
      <input type="hidden" name="provider" value={c.provider} />
    </>
  );
  return (
    <Card className="mb-6" data-testid="manage-panel">
      <CardHeader
        title={`Manage ${c.name}`}
        actions={
          <Link href={`/t/${tenant}/settings/integrations`} className="link text-xs">
            Close
          </Link>
        }
      />
      <div className="grid gap-6 p-4 lg:grid-cols-2">
        <section aria-label="Credential" className="space-y-3">
          <h3 className="text-sm font-medium">Credential</h3>
          {c.hint ? (
            <p className="text-sm text-ink-soft" data-testid="credential-hint">
              Saved. Ends in {c.hint}.
            </p>
          ) : (
            <p className="text-sm text-ink-muted">Nothing saved yet.</p>
          )}
          <ActionForm action={saveCredentialAction} resetOnSuccess className="space-y-3">
            {hidden}
            <Field label="Type">
              <select name="kind" defaultValue="api_key" className="input">
                {CREDENTIAL_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="New key or token" hint="Stored sealed. Only the last 4 characters are ever shown again.">
              <input name="value" type="password" autoComplete="off" required className="input" />
            </Field>
            <SubmitButton size="sm" pendingText="Saving">
              Save credential
            </SubmitButton>
          </ActionForm>
        </section>
        <section aria-label="Connection" className="space-y-4">
          <h3 className="text-sm font-medium">Connection</h3>
          <ActionForm action={testConnectionAction}>
            {hidden}
            <SubmitButton variant="secondary" size="sm" pendingText="Testing">
              Test connection
            </SubmitButton>
          </ActionForm>
          <div className="flex flex-wrap gap-2">
            <ActionForm action={setModeAction}>
              {hidden}
              <input type="hidden" name="mode" value={c.mode === 'live' ? 'mock' : 'live'} />
              <SubmitButton variant="secondary" size="sm">
                {c.mode === 'live' ? 'Switch to sample data' : 'Switch to live'}
              </SubmitButton>
            </ActionForm>
            <ActionForm action={setDisabledAction}>
              {hidden}
              <input type="hidden" name="disabled" value={c.status === 'disabled' ? 'false' : 'true'} />
              <SubmitButton variant={c.status === 'disabled' ? 'secondary' : 'danger'} size="sm">
                {c.status === 'disabled' ? 'Turn on' : 'Turn off'}
              </SubmitButton>
            </ActionForm>
          </div>
          <p className="text-2xs text-ink-muted">
            Going live needs a saved credential and a passing test in the last 10 minutes.
          </p>
        </section>
      </div>
      <div className="border-t border-line">
        <div className="px-4 py-2 text-xs font-medium text-ink-muted">Last {calls.length === 0 ? '' : `${calls.length} `}calls</div>
        {calls.length === 0 ? (
          <div className="p-4 pt-0">
            <EmptyState title="No calls yet">Calls to {c.name} show up here.</EmptyState>
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>What</Th>
                <Th>Result</Th>
                <Th numeric>Status</Th>
                <Th numeric>Time</Th>
                <Th>Error</Th>
              </tr>
            </thead>
            <tbody>
              {calls.map((k) => {
                const o = OUTCOME[k.outcome] ?? { tone: 'neutral' as Tone, text: k.outcome };
                return (
                  <tr key={k.id}>
                    <Td className="whitespace-nowrap text-xs">{formatDateTime(k.at)}</Td>
                    <Td className="font-mono text-xs">{k.operation}</Td>
                    <Td>
                      <Badge tone={o.tone}>{o.text}</Badge>
                    </Td>
                    <Td numeric>{k.statusCode ?? ''}</Td>
                    <Td numeric>{k.durationMs.toLocaleString('en-US')} ms</Td>
                    <Td className="max-w-xs break-words text-xs">{k.errorMessage ?? ''}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>
    </Card>
  );
}

export default async function IntegrationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{ provider?: string }>;
}) {
  const slug = (await params).tenant;
  const ctx = await pageContext(slug);
  if (!ctx.can('integrations:manage')) {
    return (
      <TenantShell ctx={ctx} current="integrations">
        <PageHeader title="Integrations" />
        <Notice tone="bad">You don&apos;t have access to that.</Notice>
      </TenantShell>
    );
  }
  const selected = (await searchParams).provider;
  const { principal } = ctx;
  const { rows, calls } = await withTenant(principal.tenantId, async (tx) => {
    const c = { tenantId: principal.tenantId, actor: { kind: 'user' as const, id: principal.id }, correlationId: newId('cor'), tx };
    const rows = await listConnections(c);
    const known = rows.some((r) => r.provider === selected);
    return { rows, calls: known && selected ? await recentCalls(c, selected, 50) : [] };
  });
  const open = rows.find((r) => r.provider === selected);
  const usedFor = new Map(PROVIDERS.map((p) => [p.key, p.usedFor]));

  return (
    <TenantShell ctx={ctx} current="integrations">
      <PageHeader title="Integrations" description="The outside services Scout works with. Each one runs on sample data until you connect it." />
      {open && <Manage tenant={slug} c={open} calls={calls} />}
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Service</Th>
              <Th>Data</Th>
              <Th>Status</Th>
              <Th>Last call</Th>
              <Th numeric>Calls today</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const chip = statusChip(c);
              return (
                <tr key={c.provider} data-testid={`provider-${c.provider}`}>
                  <Td>
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-ink-muted">{usedFor.get(c.provider)}</div>
                  </Td>
                  <Td>{c.mode === 'mock' ? <Badge tone="neutral">Using sample data</Badge> : <Badge tone="accent">Live</Badge>}</Td>
                  <Td>
                    <Badge tone={chip.tone}>{chip.text}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-xs">{formatDateTime(c.lastCallAt)}</Td>
                  <Td numeric>{c.callsToday.toLocaleString('en-US')}</Td>
                  <Td>
                    <Link href={`/t/${slug}/settings/integrations?provider=${c.provider}`} className="link text-xs">
                      Manage
                    </Link>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </TenantShell>
  );
}
