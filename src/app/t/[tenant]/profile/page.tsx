import { TenantShell } from '@/components/shell';
import { Badge, Card, CardHeader, PageHeader } from '@/components/ui';
import { withTenant } from '@/platform/db/tenant';
import { newId } from '@/platform/ids';
import { describeAccess, members, permissionLabel } from '@/modules/tenancy';
import { pageContext } from '@/server/page-context';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Profile' };

const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default async function ProfilePage({ params }: { params: Promise<{ tenant: string }> }) {
  const ctx = await pageContext((await params).tenant);
  const { principal, user } = ctx;
  const everyone = await withTenant(principal.tenantId, (tx) =>
    members({ tenantId: principal.tenantId, actor: { kind: 'user', id: principal.id }, correlationId: newId('cor'), tx }),
  );
  const me = everyone.find((m) => m.userId === user.userId);
  const role = me ? label(me.role) : user.platformAdmin ? 'Platform admin' : 'No role';
  const lines = describeAccess(principal);
  return (
    <TenantShell ctx={ctx} current="profile">
      <PageHeader title="Profile" description={`${user.name} in ${ctx.tenant.name}`} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="You" />
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 p-4 text-sm">
            <dt className="text-ink-muted">Name</dt>
            <dd>{user.name}</dd>
            <dt className="text-ink-muted">Email</dt>
            <dd>{user.email}</dd>
            <dt className="text-ink-muted">Role</dt>
            <dd>
              <Badge tone="accent">{role}</Badge>
              {principal.supportAccess && (
                <span className="ml-2">
                  <Badge tone="near">Support access</Badge>
                </span>
              )}
            </dd>
          </dl>
        </Card>
        <Card>
          <CardHeader title="What you can see" description="Which accounts are open to you here." />
          <ul className="space-y-1 p-4 text-sm" aria-label="Access">
            {lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </Card>
        <Card className="md:col-span-2">
          <CardHeader title="What you can do" description={`${principal.permissions.length} permissions`} />
          <ul className="flex flex-wrap gap-1.5 p-4">
            {principal.permissions.map((p) => (
              <li key={p}>
                <Badge>
                  <span title={p}>{permissionLabel(p)}</span>
                </Badge>
              </li>
            ))}
            {principal.permissions.length === 0 && <li className="text-sm text-ink-muted">Nothing yet.</li>}
          </ul>
        </Card>
      </div>
    </TenantShell>
  );
}
