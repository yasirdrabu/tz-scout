import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { Fragment, useId, useState } from 'react';
import { hasScope, isPlatformAdmin, profileOf, type Me } from '../../../api/me';
import { Button } from '../../../ui/Button';
import { Chip } from '../../../ui/Chip';
import table from '../../../ui/Table.module.css';
import { useToast } from '../../../ui/Toast';
import { errorText, LoadFailed, LoadingRows } from '../shared';
import styles from '../Settings.module.css';
import { membersQuery, rolesQuery, saveRole } from './api';
import { roleLabel } from './words';

const same = (a: string[], b: string[]) => a.length === b.length && a.every((p) => b.includes(p));

/**
 * §21a Roles and permissions (Decision 17). Labels and groups come from the API. With members:manage
 * the cells are checkboxes over a draft; the API refuses what the editor may not give (403).
 */
export function RolesMatrix({ me, tenant }: { me: Me; tenant: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const ownerNoteId = useId();
  const roles = useQuery(rolesQuery(tenant));
  // Roles with unsaved edits, by role key.
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  if (roles.isPending) return <LoadingRows>Loading roles and permissions</LoadingRows>;
  if (roles.isError) return <LoadFailed title="Roles and permissions didn't load" error={roles.error} onRetry={() => void roles.refetch()} />;

  const { roles: columns, permissions } = roles.data;
  const groups = [...new Set(permissions.map((p) => p.group))];
  const canEdit = hasScope(me, 'members:manage');
  // Owners and platform admins may give any permission; everyone else only what they hold.
  const givesAny = isPlatformAdmin(me) || profileOf(me).role === 'owner';
  const held = (c: (typeof columns)[number]) => draft[c.role] ?? c.permissions;
  const changed = columns.filter((c) => !c.locked && draft[c.role] && !same(draft[c.role]!, c.permissions));

  function toggle(role: string, current: string[], key: string, on: boolean) {
    const next = new Set(current);
    if (on) next.add(key);
    else next.delete(key);
    setDraft((d) => ({ ...d, [role]: permissions.map((p) => p.key).filter((k) => next.has(k)) }));
  }

  function restoreDefaults() {
    setDraft(Object.fromEntries(columns.filter((c) => !c.locked).map((c) => [c.role, c.default_permissions])));
  }

  async function save() {
    setSaving(true);
    try {
      for (const c of changed) {
        await saveRole(tenant, c.role, draft[c.role]!);
        // Saved roles leave the draft, so a later failure keeps only what is still unsaved.
        setDraft(({ [c.role]: _saved, ...rest }) => rest);
      }
      toast.show('Permissions saved. They apply the next time each member loads a page.');
    } catch (e) {
      toast.show(errorText(e));
    } finally {
      setSaving(false);
      await Promise.all([rolesQuery(tenant), membersQuery(tenant)].map((q) => queryClient.invalidateQueries({ queryKey: q.queryKey })));
    }
  }

  return (
    <>
      <p className={styles.intro}>
        What each role can do in this workspace. Taazaa platform admins can act in every workspace. They aren't a role here.
      </p>
      {canEdit && (
        <div className={styles.toolbar}>
          <Button variant="secondary" onClick={restoreDefaults} disabled={saving}>
            Restore defaults
          </Button>
          <span className={styles.grow} />
          <Button variant="ghost" onClick={() => setDraft({})} disabled={saving || changed.length === 0}>
            Discard
          </Button>
          <Button onClick={() => void save()} disabled={saving || changed.length === 0}>
            Save permissions
          </Button>
        </div>
      )}
      <span id={ownerNoteId} hidden>
        Owner always has every permission.
      </span>
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th scope="col">Permission</th>
              {columns.map((c) => (
                <th key={c.role} scope="col" className={table.num}>
                  {roleLabel(c.role)}
                  {/* Under the role name, so the chip doesn't widen its column. */}
                  {c.customised && (
                    <div>
                      <Chip>Customised</Chip>
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g}>
                <tr>
                  <th scope="colgroup" colSpan={columns.length + 1} className={styles.group}>
                    {g}
                  </th>
                </tr>
                {permissions
                  .filter((p) => p.group === g)
                  .map((p) => (
                    <tr key={p.key}>
                      <th scope="row" className={styles.rowHead}>
                        {p.label}
                      </th>
                      {columns.map((c) => {
                        const on = held(c).includes(p.key);
                        return (
                          <td key={c.role} className={table.num}>
                            {canEdit ? (
                              <input
                                type="checkbox"
                                aria-label={`${p.label} for ${roleLabel(c.role)}`}
                                {...(c.locked ? { 'aria-describedby': ownerNoteId } : {})}
                                checked={c.locked || on}
                                disabled={c.locked || saving || (!givesAny && !hasScope(me, p.key))}
                                onChange={(e) => toggle(c.role, held(c), p.key, e.target.checked)}
                              />
                            ) : on ? (
                              <>
                                <Check aria-hidden="true" size={15} />
                                <span className="sr-only">Yes</span>
                              </>
                            ) : (
                              <span className="sr-only">No</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
