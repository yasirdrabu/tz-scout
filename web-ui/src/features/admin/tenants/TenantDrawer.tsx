import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useFormat } from '../../../lib/useFormat';
import { Button } from '../../../ui/Button';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { Drawer } from '../../../ui/Drawer';
import { useRun } from '../../settings/shared';
import styles from '../Admin.module.css';
import { setTenantStatus, tenantsQuery, workspaceHost, type AdminTenant } from './api';
import { initial, StatusPill } from './parts';

/** The tenant drawer: General, and Suspend (with a confirm) or Resume. */
export function TenantDrawer({ tenant, onClose }: { tenant: AdminTenant; onClose: () => void }) {
  const f = useFormat();
  const queryClient = useQueryClient();
  const { run, busy } = useRun();
  const [confirming, setConfirming] = useState(false);

  async function change(action: 'suspend' | 'resume') {
    const ok = await run(async () => {
      await setTenantStatus(tenant.id, action);
      await queryClient.invalidateQueries({ queryKey: tenantsQuery().queryKey });
    }, action === 'suspend' ? `${tenant.name} suspended.` : `${tenant.name} resumed.`);
    if (ok) setConfirming(false);
  }

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={tenant.name}
      subtitle={workspaceHost(tenant.slug)}
      lead={
        <span className={styles.initial} aria-hidden="true">
          {initial(tenant.name)}
        </span>
      }
      footer={
        tenant.status === 'active' ? (
          <Button variant="secondary" onClick={() => setConfirming(true)} disabled={busy}>
            Suspend tenant
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => void change('resume')} disabled={busy}>
            Resume tenant
          </Button>
        )
      }
    >
      <div className={styles.section}>
        <div>
          <StatusPill status={tenant.status} />
        </div>
        <h3 className={styles.sectionTitle}>General</h3>
        <dl className={styles.facts}>
          <dt>Owner</dt>
          <dd>{tenant.owner ? `${tenant.owner.name} · ${tenant.owner.email}` : 'No owner yet'}</dd>
          <dt>Created</dt>
          <dd>{f.date(tenant.created_at)}</dd>
          <dt>Members</dt>
          <dd>{f.number(tenant.member_count)}</dd>
          <dt>Currency</dt>
          <dd>{tenant.currency}</dd>
          <dt>Timezone</dt>
          <dd>{tenant.timezone}</dd>
        </dl>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Suspend ${tenant.name}?`}
        description="Nobody in it can sign in or use its API keys until you resume it."
        confirmLabel="Suspend"
        busy={busy}
        onConfirm={() => void change('suspend')}
      />
    </Drawer>
  );
}
