import { useState } from 'react';
import { Button } from '../../../ui/Button';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { useToast } from '../../../ui/Toast';
import { copyText, useRun } from '../shared';
import styles from '../Settings.module.css';
import { memberAction, removeMember, type Member } from './api';

type Props = { member: Member; youId: string | null; tenant: string; onChanged: () => Promise<unknown>; onRemoved: () => void };

type Confirm = 'sign-out' | 'remove' | null;

/** The plain Scout sign-in address: invited people get in the first time they sign in with Microsoft (Decision 18). */
export const signInAddress = () => `${window.location.origin}/signin`;

/** Why a member can't be suspended or removed, or null. */
function protectedBecause(member: Member, youId: string | null): string | null {
  if (member.user_id === youId) return "You can't suspend or remove yourself.";
  if (member.role === 'owner' && member.status === 'active') return "Owners can't be suspended or removed. Change their role first.";
  return null;
}

/** Sign out everywhere; for invites Copy sign-in link and Revoke invite; Suspend or Reactivate; Remove. */
export function MemberActions({ member, youId, tenant, onChanged, onRemoved }: Props) {
  const toast = useToast();
  const { run, busy } = useRun();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const lock = protectedBecause(member, youId);
  const name = member.name;

  const act = async (action: 'suspend' | 'reactivate', done: string) => {
    await run(async () => {
      await memberAction(tenant, member.id, action);
      await onChanged();
    }, done);
  };

  async function signOut() {
    const ok = await run(() => memberAction(tenant, member.id, 'sign-out-everywhere'), `${name} is signed out of every device.`);
    if (ok) setConfirm(null);
  }

  async function remove(done: string) {
    const ok = await run(() => removeMember(tenant, member.id), done);
    if (!ok) return;
    setConfirm(null);
    onRemoved();
    await onChanged();
  }

  async function copyLink() {
    toast.show((await copyText(signInAddress())) ? 'Sign-in link copied.' : `Copy didn't work. The link is ${signInAddress()}`);
  }

  return (
    <section className={styles.section} aria-label="Member actions">
      {member.status === 'invited' ? (
        <div className={styles.row}>
          <Button size="sm" variant="secondary" onClick={() => void copyLink()}>
            Copy sign-in link
          </Button>
          <Button size="sm" variant="secondary" disabled={busy || member.user_id === youId} onClick={() => void remove(`Invite to ${member.email} revoked.`)}>
            Revoke invite
          </Button>
        </div>
      ) : (
        <>
          <div className={styles.row}>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirm('sign-out')}>
              Sign out of every device
            </Button>
            {member.status === 'active' ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || !!lock}
                onClick={() => void act('suspend', `${name} suspended. They can't use this workspace until you reactivate them.`)}
              >
                Suspend
              </Button>
            ) : (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act('reactivate', `${name} reactivated.`)}>
                Reactivate
              </Button>
            )}
            <Button size="sm" variant="secondary" disabled={busy || !!lock} onClick={() => setConfirm('remove')}>
              <span className={styles.danger}>Remove from workspace</span>
            </Button>
          </div>
          {lock && <p className={styles.note}>{lock}</p>}
        </>
      )}
      <ConfirmDialog
        open={confirm === 'sign-out'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Sign ${name} out everywhere?`}
        description="This signs them out of every workspace on every device."
        confirmLabel="Sign out everywhere"
        busy={busy}
        onConfirm={() => void signOut()}
      />
      <ConfirmDialog
        open={confirm === 'remove'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Remove ${name}?`}
        description={`Their ${member.open_account_count} open accounts go back to the review queue to be reassigned. Their sign-in history is kept.`}
        confirmLabel="Remove"
        busy={busy}
        onConfirm={() => void remove(`${name} removed from the workspace.`)}
      />
    </section>
  );
}
