import Link from 'next/link';
import { ActionForm, SignOutButton, SubmitButton } from '@/components/client';
import { Badge, Card, CardHeader, Field, PageHeader, Table, Td, Th } from '@/components/ui';
import { listTenants } from '@/modules/tenancy';
import { adminContext } from '@/server/page-context';
import { createTenantAction } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Workspaces' };

export default async function AdminTenantsPage() {
  const admin = await adminContext();
  const tenants = await listTenants();
  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="flex h-6 w-6 items-center justify-center rounded bg-accent text-xs font-bold text-white">S</span>
          Scout
          <Badge tone="near">Support access</Badge>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-muted">{admin.email}</span>
          <SignOutButton />
        </div>
      </div>
      <PageHeader title="Workspaces" description="Every workspace on this Scout. Only platform admins see this page." />
      <Card className="mb-6">
        <CardHeader title={`Workspaces (${tenants.length})`} />
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Short name</Th>
              <Th>Currency</Th>
              <Th>Timezone</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => (
              <tr key={t.id}>
                <Td>
                  <Link href={`/t/${t.slug}`} className="link font-medium">
                    {t.name}
                  </Link>
                </Td>
                <Td className="font-mono text-xs">{t.slug}</Td>
                <Td>{t.currency}</Td>
                <Td>{t.timezone}</Td>
                <Td>
                  <Badge tone={t.status === 'active' ? 'neutral' : 'bad'}>{t.status === 'active' ? 'Active' : 'Suspended'}</Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card>
        <CardHeader title="Create a workspace" description="The owner is invited by email and shows as Invited until they sign in." />
        <ActionForm action={createTenantAction} resetOnSuccess className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Name">
            <input name="name" required className="input" />
          </Field>
          <Field label="Short name" hint="Lower case letters, numbers and dashes.">
            <input name="slug" required className="input" />
          </Field>
          <Field label="Owner email">
            <input name="ownerEmail" type="email" required className="input" />
          </Field>
          <Field label="Currency">
            <input name="currency" defaultValue="USD" required className="input" />
          </Field>
          <Field label="Timezone">
            <input name="timezone" defaultValue="America/New_York" required className="input" />
          </Field>
          <div className="flex items-end">
            <SubmitButton pendingText="Creating">Create workspace</SubmitButton>
          </div>
        </ActionForm>
      </Card>
    </main>
  );
}
