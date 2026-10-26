import { TenantShell } from '@/components/shell';
import { ActionForm, SubmitButton } from '@/components/client';
import { Badge, Card, CardHeader, EmptyState, Field, Notice, PageHeader, Table, Td, Th } from '@/components/ui';
import { withTenant } from '@/platform/db/tenant';
import { newId } from '@/platform/ids';
import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  memberAccess,
  members,
  permissionLabel,
  type Member,
  type MemberAccess,
} from '@/modules/tenancy';
import { pageContext } from '@/server/page-context';
import { addMemberAction, changeMemberAction, removeMemberAction } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Members' };

const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function limitValue(a: MemberAccess | undefined): string {
  const k = a?.dataLimit?.kind;
  return k === 'all' || k === 'own_accounts' ? k : '';
}

function limitText(a: MemberAccess | undefined): string {
  const k = a?.dataLimit?.kind;
  if (!a?.dataLimit) return 'Role default';
  return k === 'all' ? 'Every account' : k === 'own_accounts' ? 'Own accounts' : 'Custom';
}

function EditMember({ tenant, m, access }: { tenant: string; m: Member; access: MemberAccess | undefined }) {
  const roleSet = new Set<string>(ROLE_PERMISSIONS[m.role]);
  const extras = new Set<string>(access?.extraPermissions ?? []);
  return (
    <details className="group">
      <summary className="cursor-pointer text-xs text-accent hover:underline">Edit</summary>
      <ActionForm action={changeMemberAction} className="mt-2 w-72 space-y-3 rounded border border-line bg-sunken p-3">
        <input type="hidden" name="tenant" value={tenant} />
        <input type="hidden" name="membershipId" value={m.membershipId} />
        <Field label="Role">
          <select name="role" defaultValue={m.role} className="input">
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {label(r)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Accounts they can see">
          <select name="dataLimit" defaultValue={limitValue(access)} className="input">
            <option value="">Role default</option>
            <option value="all">Every account</option>
            <option value="own_accounts">Own accounts</option>
          </select>
        </Field>
        <Field label="HubSpot user id">
          <input name="hubspotOwnerId" defaultValue={access?.crmOwnerIds.hubspot ?? ''} className="input" />
        </Field>
        <fieldset>
          <legend className="label">Extra permissions</legend>
          <div className="max-h-32 space-y-1 overflow-y-auto text-xs">
            {PERMISSIONS.filter((p) => !roleSet.has(p)).map((p) => (
              <label key={p} className="flex items-center gap-2">
                <input type="checkbox" name="extra" value={p} defaultChecked={extras.has(p)} />
                <span title={p}>{permissionLabel(p)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <SubmitButton size="sm">Save changes</SubmitButton>
      </ActionForm>
    </details>
  );
}

export default async function MembersPage({ params }: { params: Promise<{ tenant: string }> }) {
  const slug = (await params).tenant;
  const ctx = await pageContext(slug);
  const readable = ctx.can('members:read') || ctx.can('members:manage');
  if (!readable) {
    return (
      <TenantShell ctx={ctx} current="members">
        <PageHeader title="Members" />
        <Notice tone="bad">You don&apos;t have access to that.</Notice>
      </TenantShell>
    );
  }
  const canManage = ctx.can('members:manage');
  const { principal } = ctx;
  const { people, access } = await withTenant(principal.tenantId, async (tx) => {
    const c = { tenantId: principal.tenantId, actor: { kind: 'user' as const, id: principal.id }, correlationId: newId('cor'), tx };
    return { people: await members(c), access: await memberAccess(c) };
  });

  return (
    <TenantShell ctx={ctx} current="members">
      <PageHeader title="Members" description="Who can use this workspace, what they can do and which accounts they can see." />
      <Card className="mb-6">
        <CardHeader title={`People (${people.length})`} />
        {people.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No members yet" />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Person</Th>
                <Th>Role</Th>
                <Th>Status</Th>
                <Th>HubSpot user id</Th>
                <Th>Accounts</Th>
                {canManage && <Th>Actions</Th>}
              </tr>
            </thead>
            <tbody>
              {people.map((m) => {
                const a = access[m.membershipId];
                return (
                  <tr key={m.membershipId} data-testid={`member-${m.email}`}>
                    <Td>
                      <div className="font-medium">{m.name}</div>
                      <div className="text-xs text-ink-muted">{m.email}</div>
                    </Td>
                    <Td>{label(m.role)}</Td>
                    <Td>
                      <Badge tone={m.status === 'invited' ? 'near' : 'neutral'}>{m.status === 'invited' ? 'Invited' : 'Active'}</Badge>
                    </Td>
                    <Td className="font-mono text-xs">{a?.crmOwnerIds.hubspot ?? ''}</Td>
                    <Td>{limitText(a)}</Td>
                    {canManage && (
                      <Td>
                        <div className="flex flex-col gap-2">
                          <EditMember tenant={slug} m={m} access={a} />
                          <ActionForm action={removeMemberAction}>
                            <input type="hidden" name="tenant" value={slug} />
                            <input type="hidden" name="membershipId" value={m.membershipId} />
                            <SubmitButton variant="danger" size="sm" pendingText="Removing">
                              Remove
                            </SubmitButton>
                          </ActionForm>
                        </div>
                      </Td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {canManage ? (
        <Card>
          <CardHeader title="Add a member" description="They show as Invited until they sign in." />
          <ActionForm action={addMemberAction} resetOnSuccess className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <input type="hidden" name="tenant" value={slug} />
            <Field label="Email">
              <input name="email" type="email" required className="input" />
            </Field>
            <Field label="Role">
              <select name="role" defaultValue="seller" className="input">
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {label(r)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="HubSpot user id" hint="Optional. Links their accounts in HubSpot.">
              <input name="hubspotOwnerId" className="input" />
            </Field>
            <div className="flex items-end">
              <SubmitButton pendingText="Adding">Add member</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      ) : (
        <Notice>You can see who is here. Ask an owner to make changes.</Notice>
      )}
    </TenantShell>
  );
}
