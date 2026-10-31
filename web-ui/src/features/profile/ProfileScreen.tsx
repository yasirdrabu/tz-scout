import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { signOut } from '../../api/auth';
import { isPlatformAdmin, personOf, profileOf, type Me } from '../../api/me';
import page from '../../routes/Page.module.css';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { errorText } from '../settings/shared';
import styles from '../settings/Settings.module.css';
import { roleLabel } from '../settings/members/words';
import { signOutEverywhere } from './api';
import { Sessions } from './Sessions';

const METHOD: Record<string, string> = { microsoft: 'Microsoft', dev: 'Developer sign-in' };

/** §25 Profile: who you are here, what you can see, your sessions, and signing out. */
export function ProfileScreen({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const { name, email } = personOf(me);
  const { role, signInMethod, access } = profileOf(me);
  const roleText = role ? roleLabel(role) : isPlatformAdmin(me) ? 'Platform admin' : 'No role';

  async function leave(action: () => Promise<void>, done: string | null) {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      toast.show(errorText(e));
      setBusy(false);
      return;
    }
    if (done) toast.show(done);
    queryClient.clear();
    await navigate({ to: '/signin', search: {} });
  }

  return (
    <div className={page.page}>
      <div>
        <h1 className={page.title}>Profile</h1>
        <p className={page.sub}>{`${name ?? email ?? 'You'} in ${me.tenant.name}`}</p>
      </div>
      <Card title="You">
        <dl className={styles.facts}>
          <dt>Name</dt>
          <dd>{name ?? 'Not set'}</dd>
          <dt>Email</dt>
          <dd>{email ?? 'Not set'}</dd>
          <dt>Role</dt>
          <dd>{roleText}</dd>
          <dt>Practice access</dt>
          <dd>
            <ul aria-label="What you can see">
              {access.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </dd>
          <dt>Signs in with</dt>
          <dd>{signInMethod ? (METHOD[signInMethod] ?? signInMethod) : 'Not recorded'}</dd>
        </dl>
      </Card>
      <Card
        title="Active sessions"
        actions={
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirm(true)}>
            Sign out of every device
          </Button>
        }
      >
        <Sessions />
      </Card>
      <div className={styles.row}>
        <Button variant="secondary" disabled={busy} onClick={() => void leave(signOut, null)}>
          Sign out
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Sign out of every device?"
        description="This signs you out of every workspace on every device, this one included."
        confirmLabel="Sign out everywhere"
        busy={busy}
        onConfirm={() => void leave(signOutEverywhere, "You're signed out of every device.")}
      />
    </div>
  );
}
