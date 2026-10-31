import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '../../../ui/Button';
import { Dialog } from '../../../ui/Dialog';
import { Field } from '../../../ui/Field';
import { useToast } from '../../../ui/Toast';
import { copyText, errorText } from '../shared';
import styles from '../Settings.module.css';
import { inviteMembers, membersQuery, rolesQuery, type InviteResult, type Practice } from './api';
import { PracticePicker } from './MemberAccess';
import { hasPracticeAccess, parseEmails, roleAbout, roleLabel } from './words';

type Props = { open: boolean; onOpenChange: (open: boolean) => void; tenant: string; practices: Practice[] };

type Failed = Extract<InviteResult, { ok: false }>;

/** §21a invite: addresses, a role card, practice access; then the sign-in link to send (Scout sends no email in R1). */
export function InviteDialog({ open, onOpenChange, tenant, practices }: Props) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const roles = useQuery({ ...rolesQuery(tenant), enabled: open });
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState('seller');
  const [limit, setLimit] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<Failed[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const radioId = useId();
  const list = parseEmails(emails);

  function close(o: boolean) {
    onOpenChange(o);
    if (o) return;
    setEmails('');
    setError(null);
    setFailed([]);
    setLink(null);
    setLimit(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (list.length === 0) return setError('Add at least one email address.');
    setError(null);
    setBusy(true);
    try {
      const narrowed = hasPracticeAccess(role) && limit ? { data_limit: { kind: 'practices' as const, ids: limit } } : {};
      const res = await inviteMembers(tenant, { emails: list, role, ...narrowed });
      const bad = res.results.filter((r): r is Failed => !r.ok);
      const good = res.results.length - bad.length;
      setFailed(bad);
      setEmails(bad.map((r) => r.email).join('\n'));
      if (good > 0) {
        setLink(res.sign_in_url);
        toast.show(good === 1 ? `Invited ${res.results.find((r) => r.ok)?.email}.` : `Invited ${good} people.`);
        await queryClient.invalidateQueries({ queryKey: membersQuery(tenant).queryKey });
      }
    } catch (err) {
      toast.show(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(url: string) {
    toast.show((await copyText(url)) ? 'Sign-in link copied.' : `Copy didn't work. The link is ${url}`);
  }

  const failures = failed.length > 0 && (
    <ul className={styles.note} aria-label="Not invited">
      {failed.map((r) => (
        <li key={r.email} className={styles.danger}>
          {r.email}: {r.error.title}
        </li>
      ))}
    </ul>
  );

  if (link) {
    return (
      <Dialog open={open} onOpenChange={close} title="Invite people" footer={<Button onClick={() => close(false)}>Done</Button>}>
        <div className={styles.section}>
          <p>Scout doesn't send invite emails yet. Send them this link to sign in: {link}</p>
          <div className={styles.row}>
            <Button size="sm" variant="secondary" onClick={() => void copyLink(link)}>
              Copy link
            </Button>
          </div>
          {failures}
        </div>
      </Dialog>
    );
  }

  const roleKeys = roles.data?.roles.map((r) => r.role) ?? ['seller'];
  return (
    <Dialog open={open} onOpenChange={close} title="Invite people" width={560}>
      <form className={styles.section} onSubmit={(e) => void submit(e)} noValidate>
        <Field label="Email addresses" hint="Separate with commas or new lines." error={error}>
          {(control) => (
            <textarea {...control} className="input" value={emails} placeholder="ravi.menon@taazaa.com, j.cole@taazaa.com" onChange={(e) => setEmails(e.target.value)} />
          )}
        </Field>
        {failures}
        <fieldset className={styles.section}>
          <legend className={styles.sectionTitle}>Role</legend>
          {roleKeys.map((r) => (
            <div key={r} className={styles.row}>
              <input id={`${radioId}-${r}`} type="radio" name="invite-role" value={r} checked={role === r} onChange={() => setRole(r)} />
              <label htmlFor={`${radioId}-${r}`}>
                <strong>{roleLabel(r)}</strong> <span className={styles.note}>{roleAbout(r)}</span>
              </label>
            </div>
          ))}
        </fieldset>
        {hasPracticeAccess(role) && practices.length > 0 && (
          <div className={styles.section}>
            <span className={styles.sectionTitle}>Practice access</span>
            <PracticePicker practices={practices} value={limit} onChange={setLimit} />
          </div>
        )}
        <div className={styles.row}>
          <span className={styles.grow} />
          <Button variant="secondary" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {list.length > 1 ? `Invite ${list.length} people` : 'Invite'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
