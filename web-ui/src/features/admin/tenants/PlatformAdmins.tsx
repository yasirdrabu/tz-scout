import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/errors';
import { userIdOf, type Me } from '../../../api/me';
import { useFormat } from '../../../lib/useFormat';
import { Button } from '../../../ui/Button';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { Dialog } from '../../../ui/Dialog';
import { EmptyState } from '../../../ui/EmptyState';
import { Field } from '../../../ui/Field';
import table from '../../../ui/Table.module.css';
import { useToast } from '../../../ui/Toast';
import { errorText, LoadFailed, LoadingRows, useRun } from '../../settings/shared';
import styles from '../Admin.module.css';
import { addPlatformAdmin, platformAdminsQuery, removePlatformAdmin, type PlatformAdmin } from './api';

/** Platform admins: Taazaa staff with the platform-admin flag. Add by @taazaa.com email; remove anyone but yourself. */
export function PlatformAdmins({ me }: { me: Me }) {
  const f = useFormat();
  const queryClient = useQueryClient();
  const admins = useQuery(platformAdminsQuery());
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<PlatformAdmin | null>(null);
  const { run, busy } = useRun();
  const self = userIdOf(me);

  async function remove(a: PlatformAdmin) {
    const ok = await run(async () => {
      await removePlatformAdmin(a.user_id);
      await queryClient.invalidateQueries({ queryKey: platformAdminsQuery().queryKey });
    }, `${a.name} is no longer a platform admin.`);
    if (ok) setRemoving(null);
  }

  const add = (
    <Button variant="secondary" icon={<Plus />} onClick={() => setAdding(true)}>
      Add platform admin
    </Button>
  );

  return (
    <section className={styles.section} aria-labelledby="platform-admins">
      <div className={styles.sectionHead}>
        <div>
          <h2 id="platform-admins" className={styles.sectionTitle}>
            Platform admins
          </h2>
          <p className={styles.note}>Taazaa staff who can open every tenant and these admin pages. They sign in with Microsoft.</p>
        </div>
        <span className={styles.grow} />
        {add}
      </div>
      {admins.isPending ? (
        <LoadingRows rows={2}>Loading platform admins</LoadingRows>
      ) : admins.isError ? (
        <LoadFailed title="Platform admins didn't load" error={admins.error} onRetry={() => void admins.refetch()} />
      ) : admins.data.length === 0 ? (
        <EmptyState title="No platform admins" icon={<ShieldCheck />} actions={add}>
          Add a Taazaa staff member by their @taazaa.com email.
        </EmptyState>
      ) : (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Last signed in</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {admins.data.map((a) => (
                <tr key={a.user_id}>
                  <td>
                    <div className={styles.stack}>
                      <span className={styles.row}>
                        <strong>{a.name}</strong>
                        {a.user_id === self && <span className={styles.tag}>You</span>}
                      </span>
                      <span className={table.muted}>{a.email}</span>
                    </div>
                  </td>
                  <td className={table.muted}>{a.last_sign_in_at ? f.dateTime(a.last_sign_in_at) : 'Never'}</td>
                  <td>
                    <div className={table.actions}>
                      {a.user_id !== self && (
                        <Button size="sm" variant="secondary" aria-label={`Remove ${a.name}`} onClick={() => setRemoving(a)}>
                          Remove
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AddAdminDialog open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name ?? 'this platform admin'}?`}
        description="They lose these admin pages, and every tenant they are not a member of, right away."
        confirmLabel="Remove"
        busy={busy}
        onConfirm={() => removing && void remove(removing)}
      />
    </section>
  );
}

function AddAdminDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function close(o: boolean) {
    onOpenChange(o);
    if (!o) {
      setEmail('');
      setError(null);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return setError('Add their work email.');
    setBusy(true);
    try {
      const added = await addPlatformAdmin(email.trim());
      await queryClient.invalidateQueries({ queryKey: platformAdminsQuery().queryKey });
      toast.show(`${added.name || added.email} is now a platform admin.`);
      close(false);
    } catch (err) {
      // Refusals about the address (not staff, already an admin, turned off) show under the field.
      if (err instanceof ApiError && (err.status === 400 || err.status === 409)) setError(err.message);
      else toast.show(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close} title="Add platform admin" width={480}>
      <form className={styles.section} onSubmit={(e) => void submit(e)} noValidate>
        <Field label="Work email" hint="Use an @taazaa.com email. They sign in with Microsoft." error={error}>
          {(c) => <input {...c} type="email" className="input" value={email} placeholder="name@taazaa.com" onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <div className={styles.row}>
          <span className={styles.grow} />
          <Button variant="secondary" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            Add platform admin
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
