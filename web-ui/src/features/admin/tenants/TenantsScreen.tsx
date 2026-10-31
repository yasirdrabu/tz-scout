import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Building2, Plus } from 'lucide-react';
import { useState } from 'react';
import { useFormat } from '../../../lib/useFormat';
import page from '../../../routes/Page.module.css';
import { Button } from '../../../ui/Button';
import { EmptyState } from '../../../ui/EmptyState';
import table from '../../../ui/Table.module.css';
import { LoadFailed, LoadingRows } from '../../settings/shared';
import styles from '../Admin.module.css';
import { tenantsQuery, workspaceHost } from './api';
import { NewTenantPanel } from './NewTenantPanel';
import { initial, StatusPill } from './parts';
import { PlatformAdmins } from './PlatformAdmins';
import { TenantDrawer } from './TenantDrawer';

const route = getRouteApi('/admin/tenants');
const layout = getRouteApi('/admin');

/** §22 Tenants, the R1 part: the list, the Tenants tile, the drawer, new tenant and platform admins. */
export function TenantsScreen() {
  const { open } = route.useSearch();
  const { me } = layout.useRouteContext();
  const navigate = useNavigate();
  const f = useFormat();
  const tenants = useQuery(tenantsQuery());
  const [creating, setCreating] = useState(false);
  const setOpen = (id: string | undefined) => void navigate({ to: '/admin/tenants', search: id ? { open: id } : {} });
  const selected = open ? tenants.data?.data.find((t) => t.id === open) : undefined;

  const newTenant = (
    <Button icon={<Plus />} onClick={() => setCreating(true)}>
      New tenant
    </Button>
  );

  return (
    <div className={page.page}>
      <div className={styles.head}>
        <div>
          <h1 className={page.title}>Tenants</h1>
          <p className={page.sub}>Each tenant is a separate company on Scout. Nothing is shared between tenants.</p>
        </div>
        <span className={styles.grow} />
        {newTenant}
      </div>
      {tenants.isPending ? (
        <LoadingRows>Loading tenants</LoadingRows>
      ) : tenants.isError ? (
        <LoadFailed title="Tenants didn't load" error={tenants.error} onRetry={() => void tenants.refetch()} />
      ) : (
        <>
          <div className={styles.tiles}>
            <div className={styles.tile}>
              <div className={styles.tileLabel}>Tenants</div>
              <div className={styles.tileValue}>{f.number(tenants.data.data.length)}</div>
              <div className={styles.tileNote}>
                {f.number(tenants.data.summary.active)} active · {f.number(tenants.data.summary.suspended)} suspended
              </div>
            </div>
          </div>
          {tenants.data.data.length === 0 ? (
            <EmptyState title="No tenants yet" icon={<Building2 />} actions={newTenant}>
              Create a tenant to give a company its own workspace.
            </EmptyState>
          ) : (
            <section className={styles.section} aria-labelledby="all-tenants">
              <h2 id="all-tenants" className={styles.sectionTitle}>
                All tenants
              </h2>
              <div className={table.wrap}>
                <table className={table.table}>
                  <thead>
                    <tr>
                      <th scope="col">Tenant</th>
                      <th scope="col">Status</th>
                      <th scope="col" className={table.num}>
                        Members
                      </th>
                      <th scope="col">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tenants.data.data.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <div className={styles.row}>
                            <span className={styles.initial} aria-hidden="true">
                              {initial(t.name)}
                            </span>
                            <div className={styles.stack}>
                              <button type="button" className={table.open} onClick={() => setOpen(t.id)}>
                                {t.name}
                              </button>
                              <span className={table.mono}>{workspaceHost(t.slug)}</span>
                            </div>
                          </div>
                        </td>
                        <td>
                          <StatusPill status={t.status} />
                        </td>
                        <td className={table.num}>{f.number(t.member_count)}</td>
                        <td className={table.muted}>{f.date(t.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className={table.foot}>
                  <span>
                    Showing {tenants.data.data.length} of {tenants.data.data.length}
                  </span>
                  <span>Newest first</span>
                </div>
              </div>
            </section>
          )}
        </>
      )}
      <PlatformAdmins me={me} />
      {selected && <TenantDrawer tenant={selected} onClose={() => setOpen(undefined)} />}
      <NewTenantPanel open={creating} onOpenChange={setCreating} />
    </div>
  );
}
