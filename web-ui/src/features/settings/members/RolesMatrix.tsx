import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { Fragment } from 'react';
import table from '../../../ui/Table.module.css';
import { LoadFailed, LoadingRows } from '../shared';
import styles from '../Settings.module.css';
import { rolesQuery } from './api';
import { roleLabel } from './words';

/** §21a Roles and permissions: read only until the roles plan (Decision 17). Labels and groups come from the API. */
export function RolesMatrix({ tenant }: { tenant: string }) {
  const roles = useQuery(rolesQuery(tenant));
  if (roles.isPending) return <LoadingRows>Loading roles and permissions</LoadingRows>;
  if (roles.isError) return <LoadFailed title="Roles and permissions didn't load" error={roles.error} onRetry={() => void roles.refetch()} />;

  const { roles: columns, permissions } = roles.data;
  const groups = [...new Set(permissions.map((p) => p.group))];
  const holds = new Map(columns.map((c) => [c.role, new Set(c.permissions)]));

  return (
    <>
      <p className={styles.intro}>
        What each role can do in this workspace. Taazaa platform admins can act in every workspace. They aren't a role here.
      </p>
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th scope="col">Permission</th>
              {columns.map((c) => (
                <th key={c.role} scope="col" className={table.num}>
                  {roleLabel(c.role)}
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
                      {columns.map((c) => (
                        <td key={c.role} className={table.num}>
                          {holds.get(c.role)?.has(p.key) ? (
                            <>
                              <Check aria-hidden="true" size={15} />
                              <span className="sr-only">Yes</span>
                            </>
                          ) : (
                            <span className="sr-only">No</span>
                          )}
                        </td>
                      ))}
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
