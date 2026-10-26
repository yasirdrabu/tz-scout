import { unscopedDb } from "@/lib/db";
import { ActionButton, ActionForm, SubmitButton } from "@/components/client";
import { Badge, Card, CardHeader, PageHeader, Table, Td, Th } from "@/components/ui";
import { requireAdminPage } from "../guard";
import { ROLE_NAME, ROLES } from "../roles";
import { AddMembershipForm, NewUserDialog } from "../forms";
import { changeRoleAction, removeMembershipAction } from "../actions";

export const metadata = { title: "People" };

export default async function AdminUsersPage() {
  const me = await requireAdminPage();
  const [users, companies] = await Promise.all([
    unscopedDb.user.findMany({ orderBy: { name: "asc" }, include: { memberships: { include: { company: { select: { name: true, slug: true } } }, orderBy: { createdAt: "asc" } } } }),
    unscopedDb.company.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  return (
    <>
      <PageHeader title="People" description="Who can sign in, and what they can do in each company." actions={<NewUserDialog companies={companies} />} />

      <Card className="mb-5">
        <CardHeader title="Give someone access to a company" />
        <AddMembershipForm users={users.map((u) => ({ id: u.id, name: `${u.name} (${u.email})` }))} companies={companies} />
      </Card>

      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Person</Th>
              <Th>Access</Th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <Td className="w-72">
                  <div className="flex items-center gap-2 font-medium">
                    {u.name}
                    {u.isAdmin && <Badge tone="accent">Admin</Badge>}
                    {u.id === me.id && <span className="text-2xs font-normal text-ink-muted">You</span>}
                  </div>
                  <div className="text-xs text-ink-muted">{u.email}</div>
                </Td>
                <Td>
                  {u.memberships.length === 0 ? (
                    <span className="text-xs text-ink-muted">{u.isAdmin ? "Admins can open every company." : "No company yet."}</span>
                  ) : (
                    <div className="space-y-1.5">
                      {u.memberships.map((m) => (
                        <div key={m.id} className="flex flex-wrap items-center gap-2">
                          <span className="w-48 truncate text-sm">{m.company.name}</span>
                          <ActionForm action={changeRoleAction.bind(null, m.id)} className="flex items-center gap-1.5">
                            <select name="role" aria-label={`Role for ${u.name} in ${m.company.name}`} className="input h-7 w-32 py-0 text-xs" defaultValue={m.role}>
                              {ROLES.map((r) => (
                                <option key={r} value={r}>
                                  {ROLE_NAME[r]}
                                </option>
                              ))}
                            </select>
                            <SubmitButton variant="secondary" size="sm" pendingText="Saving...">
                              Change
                            </SubmitButton>
                          </ActionForm>
                          <ActionButton action={removeMembershipAction.bind(null, m.id)} variant="ghost" size="sm" confirm={`Remove ${u.name}'s access to ${m.company.name}?`}>
                            Remove
                          </ActionButton>
                        </div>
                      ))}
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
