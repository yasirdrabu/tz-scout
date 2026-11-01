import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { hasScope, type Me } from '../../../api/me';
import { useFormat } from '../../../lib/useFormat';
import { Button, buttonClass } from '../../../ui/Button';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { Dialog } from '../../../ui/Dialog';
import { Field } from '../../../ui/Field';
import table from '../../../ui/Table.module.css';
import { LoadFailed, LoadingRows, useRun } from '../../settings/shared';
import {
  createSourceKey,
  directoryQuery,
  patchSource,
  removeSource,
  revokeKey,
  rotateKey,
  sourceKeysQuery,
  syncSource,
  type SourceDetail,
  type SourceKey,
} from '../api';
import { KeyReveal } from '../KeyReveal';
import { usePause, useRefreshSources } from '../hooks';
import styles from '../Sources.module.css';

type Props = { tenant: string; source: SourceDetail; me: Me | undefined };

/** §11 Settings: the owner, the connection by how it sends, and pause or remove. An archived source is read only. */
export function SettingsTab({ tenant, source: s, me }: Props) {
  const ownerId = useId();
  const connectionId = useId();
  const removeId = useId();
  const navigate = useNavigate();
  const refresh = useRefreshSources(tenant);
  const { run, busy } = useRun();
  const pause = usePause(tenant, s);
  const archived = s.status === 'archived';
  const directory = useQuery({ ...directoryQuery(tenant), enabled: !archived });
  const [confirm, setConfirm] = useState<'remove' | 'archive' | null>(null);

  async function changeOwner(userId: string) {
    const name = directory.data?.find((m) => m.user_id === userId)?.name;
    await run(async () => {
      await patchSource(tenant, s.id, { owner_user_id: userId || null });
      await refresh();
    }, name ? `${name} now owns ${s.name}.` : `${s.name} has no owner now.`);
  }

  async function remove() {
    const ok = await run(() => removeSource(tenant, s.id), `${s.name} removed.`);
    setConfirm(null);
    if (ok) {
      await refresh();
      void navigate({ to: '/t/$tenant/sources', params: { tenant } });
    }
  }

  async function archive() {
    const ok = await run(async () => {
      await patchSource(tenant, s.id, { status: 'archived' });
      await refresh();
    }, `${s.name} archived.`);
    if (ok) setConfirm(null);
  }

  return (
    <div className={styles.section}>
      <section className={styles.panel} aria-labelledby={ownerId}>
        <h2 id={ownerId} className={styles.panelTitle}>
          Owner
        </h2>
        {archived ? (
          <p>{s.owner?.name ?? 'No owner'}</p>
        ) : (
          <Field label="Owner" hint="Answers for what this source sends.">
            {(c) => (
              <select {...c} className="input" value={s.owner?.user_id ?? ''} disabled={busy} onChange={(e) => void changeOwner(e.target.value)}>
                <option value="">No owner</option>
                {s.owner && !directory.data?.some((m) => m.user_id === s.owner!.user_id) && <option value={s.owner.user_id}>{s.owner.name}</option>}
                {directory.data?.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
      </section>

      <section className={styles.panel} aria-labelledby={connectionId}>
        <h2 id={connectionId} className={styles.panelTitle}>
          Connection
        </h2>
        <Connection tenant={tenant} source={s} me={me} />
        {s.parent && (
          <div className={styles.row}>
            <Link to="/t/$tenant/sources/$id" params={{ tenant, id: s.parent.id }} className={buttonClass('secondary', 'sm')}>
              {`Open ${s.parent.name}`}
            </Link>
          </div>
        )}
      </section>

      {!archived && (
        <section className={styles.panel} aria-labelledby={removeId}>
          <h2 id={removeId} className={styles.panelTitle}>
            Pause or remove
          </h2>
          <div className={styles.row}>
            <Button size="sm" variant="secondary" disabled={pause.busy} onClick={() => void pause.toggle()}>
              {s.status === 'paused' ? 'Resume' : 'Pause'}
            </Button>
            {s.can_remove && (
              <Button size="sm" variant="secondary" onClick={() => setConfirm('remove')}>
                Remove source
              </Button>
            )}
            {s.can_archive && (
              <Button size="sm" variant="secondary" onClick={() => setConfirm('archive')}>
                Archive source
              </Button>
            )}
          </div>
          {s.children_count > 0 && <p className={styles.note}>{`Remove or archive the sources under ${s.name} first.`}</p>}
        </section>
      )}

      <ConfirmDialog
        open={confirm === 'remove'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Remove ${s.name}?`}
        description="It has sent nothing, so nothing else changes."
        confirmLabel="Remove"
        busy={busy}
        onConfirm={() => void remove()}
      />
      <ConfirmDialog
        open={confirm === 'archive'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Archive ${s.name}?`}
        description="It stops sending for good and its keys stop working. Its accounts and history stay."
        confirmLabel="Archive"
        busy={busy}
        onConfirm={() => void archive()}
      />
    </div>
  );
}

/** How the source connects: its keys (API), files (a list), or the HubSpot sync. */
function Connection({ tenant, source: s, me }: Props) {
  const f = useFormat();
  const { run, busy } = useRun();
  const archived = s.status === 'archived';
  if (s.kind === 'list') {
    return (
      <div className={styles.row}>
        <span className={styles.note}>Each upload becomes a batch credited to this source.</span>
        {!archived && (
          <Link to="/t/$tenant/batches/import" params={{ tenant }} search={{ source: s.id }} className={buttonClass('secondary', 'sm')}>
            Import a list
          </Link>
        )}
      </div>
    );
  }
  if (s.kind === 'crm') {
    const sync = s.sync;
    return (
      <div className={styles.section}>
        <p className={styles.note}>{sync?.last_polled_at ? `Last synced ${f.relative(sync.last_polled_at)}` : 'Not synced yet'}</p>
        {sync?.last_error && <p className={styles.error}>{sync.last_error}</p>}
        {sync && !sync.connected ? (
          me && hasScope(me, 'integrations:manage') ? (
            <Link to="/t/$tenant/settings/$tab" params={{ tenant, tab: 'integrations' }}>
              Connect HubSpot first
            </Link>
          ) : (
            <p className={styles.note}>Connect HubSpot first</p>
          )
        ) : (
          !archived && (
            <div className={styles.row}>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => syncSource(tenant, s.id), 'Sync started.')}>
                Sync now
              </Button>
            </div>
          )
        )}
      </div>
    );
  }
  return <Keys tenant={tenant} source={s} />;
}

/** This source's keys (Decision 14): masked, with Rotate and Revoke, and Create a key when there is none. */
function Keys({ tenant, source: s }: { tenant: string; source: SourceDetail }) {
  const f = useFormat();
  const keys = useQuery(sourceKeysQuery(tenant, s.id));
  const refresh = useRefreshSources(tenant);
  const { run, busy } = useRun();
  const [rotating, setRotating] = useState<SourceKey | null>(null);
  const [revoking, setRevoking] = useState<SourceKey | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; secret: string } | null>(null);
  const archived = s.status === 'archived';

  async function rotate(key: SourceKey) {
    let secret = '';
    const ok = await run(async () => {
      secret = (await rotateKey(tenant, s.id, key.id)).secret;
      await refresh();
    }, 'Key rotated. The old key stops working within a minute.');
    setRotating(null);
    if (ok) setRevealed({ name: key.name, secret });
  }

  async function revoke(key: SourceKey) {
    const ok = await run(async () => {
      await revokeKey(tenant, s.id, key.id);
      await refresh();
    }, `${key.name} revoked. Calls with it now fail.`);
    if (ok) setRevoking(null);
  }

  async function create() {
    let made: { name: string; secret: string } | null = null;
    const ok = await run(async () => {
      const k = await createSourceKey(tenant, s.id, `${s.name} key`);
      made = { name: k.name, secret: k.secret };
      await refresh();
    }, 'Key created.');
    if (ok && made) setRevealed(made);
  }

  if (keys.isPending) return <LoadingRows rows={1}>Loading keys</LoadingRows>;
  if (keys.isError) return <LoadFailed title="Keys didn't load" error={keys.error} onRetry={() => void keys.refetch()} />;
  return (
    <>
      {keys.data.length === 0 ? (
        <div className={styles.row}>
          <span className={styles.note}>No key yet. A key lets this source send accounts through the API.</span>
          {!archived && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void create()}>
              Create a key
            </Button>
          )}
        </div>
      ) : (
        <table className={table.table}>
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Created</th>
              <th scope="col">Last used</th>
              {!archived && <th scope="col" className={table.actions} />}
            </tr>
          </thead>
          <tbody>
            {keys.data.map((k) => (
              <tr key={k.id}>
                <td>
                  {k.name}
                  <div className={table.mono}>{k.mask}</div>
                </td>
                <td>{f.date(k.created_at)}</td>
                <td>{k.last_used_at ? f.relative(k.last_used_at) : 'Never'}</td>
                {!archived && (
                  <td className={table.actions}>
                    <Button size="sm" variant="secondary" onClick={() => setRotating(k)}>
                      Rotate key
                    </Button>{' '}
                    <Button size="sm" variant="ghost" onClick={() => setRevoking(k)}>
                      Revoke key
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ConfirmDialog
        open={!!rotating}
        onOpenChange={(o) => !o && setRotating(null)}
        title={`Rotate ${rotating?.name ?? 'key'}?`}
        description="The old key stops working within a minute."
        confirmLabel="Rotate key"
        busy={busy}
        onConfirm={() => rotating && void rotate(rotating)}
      />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? 'key'}?`}
        description="Calls with it fail from now on."
        confirmLabel="Revoke key"
        busy={busy}
        onConfirm={() => revoking && void revoke(revoking)}
      />
      <Dialog open={!!revealed} onOpenChange={(o) => !o && setRevealed(null)} title={`New key for ${revealed?.name ?? ''}`} footer={<Button onClick={() => setRevealed(null)}>Done</Button>}>
        {revealed && <KeyReveal secret={revealed.secret} />}
      </Dialog>
    </>
  );
}
