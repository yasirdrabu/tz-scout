import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';
import { useFormat } from '../../../lib/useFormat';
import { Button } from '../../../ui/Button';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { EmptyState } from '../../../ui/EmptyState';
import table from '../../../ui/Table.module.css';
import type { TabProps } from '../SettingsScreen';
import { LoadFailed, LoadingRows, useRun } from '../shared';
import styles from '../Settings.module.css';
import { AccessLogDrawer } from './AccessLogDrawer';
import { canDo, keysQuery, revokeKey, type ApiKey } from './api';
import { CreateKeyDialog } from './CreateKeyDialog';

/** §21c API keys: the workspace's live keys, create (key shown once), revoke with a confirm, access log. */
export function ApiKeysTab({ tenant, open, setOpen }: TabProps) {
  const f = useFormat();
  const queryClient = useQueryClient();
  const keys = useQuery(keysQuery(tenant));
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const { run, busy } = useRun();

  async function revoke(key: ApiKey) {
    const ok = await run(async () => {
      await revokeKey(tenant, key.id);
      await queryClient.invalidateQueries({ queryKey: keysQuery(tenant).queryKey });
    }, `${key.name} revoked. Calls with it now fail.`);
    if (ok) setRevoking(null);
  }

  const create = (
    <Button icon={<Plus />} onClick={() => setCreating(true)}>
      Create a key
    </Button>
  );
  const live = keys.data?.filter((k) => !k.revoked_at) ?? [];
  const selected = open ? live.find((k) => k.id === open) : undefined;

  return (
    <>
      <div className={styles.toolbar}>
        <p className={styles.intro}>Keys let agents and partners send accounts to Scout. Each key belongs to one source.</p>
        <span className={styles.grow} />
        {create}
      </div>
      {keys.isPending ? (
        <LoadingRows>Loading API keys</LoadingRows>
      ) : keys.isError ? (
        <LoadFailed title="API keys didn't load" error={keys.error} onRetry={() => void keys.refetch()} />
      ) : live.length === 0 ? (
        <EmptyState title="No API keys yet" icon={<KeyRound />} actions={create}>
          Create a key so an agent or partner can send accounts to Scout.
        </EmptyState>
      ) : (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Source</th>
                <th scope="col">Can do</th>
                <th scope="col">Key</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {live.map((k) => (
                <tr key={k.id}>
                  <td>
                    <div className={styles.personText}>
                      <strong>{k.name}</strong>
                      <span className={table.muted}>
                        {k.created_by_name ? `Created ${f.date(k.created_at)} by ${k.created_by_name}` : `Created ${f.date(k.created_at)}`}
                      </span>
                    </div>
                  </td>
                  <td>{k.source_name ?? 'None'}</td>
                  <td>{canDo(k.scopes)}</td>
                  <td className={table.mono}>{k.mask}</td>
                  <td className={table.muted}>{k.last_used_at ? f.dateTime(k.last_used_at) : 'Never'}</td>
                  <td>
                    <div className={table.actions}>
                      <Button size="sm" variant="ghost" aria-label={`Access log for ${k.name}`} onClick={() => setOpen(k.id)}>
                        Access log
                      </Button>
                      <Button size="sm" variant="secondary" aria-label={`Revoke ${k.name}`} onClick={() => setRevoking(k)}>
                        Revoke
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={table.foot}>
            <span>
              Showing {live.length} of {live.length}
            </span>
            <span>Newest first</span>
          </div>
        </div>
      )}
      <CreateKeyDialog open={creating} onOpenChange={setCreating} tenant={tenant} />
      {selected && <AccessLogDrawer apiKey={selected} onClose={() => setOpen(undefined)} />}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? 'this key'}?`}
        description="Calls with it fail from now on. This can't be undone."
        confirmLabel="Revoke"
        busy={busy}
        onConfirm={() => revoking && void revoke(revoking)}
      />
    </>
  );
}
