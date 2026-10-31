import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '../../../ui/Button';
import { Dialog } from '../../../ui/Dialog';
import { Field } from '../../../ui/Field';
import { useToast } from '../../../ui/Toast';
import { copyText, errorText } from '../shared';
import styles from '../Settings.module.css';
import { ACCESS, createKey, keysQuery, sourcesQuery, type Access } from './api';

type Props = { open: boolean; onOpenChange: (open: boolean) => void; tenant: string };

type Errors = { name?: string; source?: string };

/** Two steps: name, source and what it can do; then the key, shown once, with Copy. */
export function CreateKeyDialog({ open, onOpenChange, tenant }: Props) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const radio = useId();
  const sources = useQuery({ ...sourcesQuery(tenant), enabled: open });
  const [name, setName] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [access, setAccess] = useState<Access>('send_and_status');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);

  function close(o: boolean) {
    onOpenChange(o);
    if (o) return;
    setName('');
    setSourceId('');
    setAccess('send_and_status');
    setErrors({});
    setCreated(null);
    setCopied(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found: Errors = {
      ...(name.trim() ? {} : { name: 'Give the key a name.' }),
      ...(sourceId ? {} : { source: 'Pick the source this key sends accounts for.' }),
    };
    setErrors(found);
    if (found.name || found.source) return;
    setBusy(true);
    try {
      const key = await createKey(tenant, { name: name.trim(), source_id: sourceId, access });
      setCreated({ name: key.name, secret: key.secret });
      await queryClient.invalidateQueries({ queryKey: keysQuery(tenant).queryKey });
    } catch (err) {
      toast.show(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy(secret: string) {
    const ok = await copyText(secret);
    setCopied(ok);
    if (!ok) toast.show("Copy didn't work. Select the key and copy it.");
  }

  if (created) {
    return (
      <Dialog open={open} onOpenChange={close} title={`Key created for ${created.name}`} footer={<Button onClick={() => close(false)}>Done</Button>}>
        <div className={styles.section}>
          <code className={styles.secret} aria-label="New API key">
            {created.secret}
          </code>
          <div className={styles.row}>
            <Button size="sm" variant="secondary" onClick={() => void copy(created.secret)}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className={styles.note}>Copy this now. You won't see it again.</p>
        </div>
      </Dialog>
    );
  }

  const list = sources.data ?? [];
  return (
    <Dialog open={open} onOpenChange={close} title="Create an API key" width={540}>
      <form className={styles.section} onSubmit={(e) => void submit(e)} noValidate>
        <Field label="Name" error={errors.name ?? null}>
          {(c) => <input {...c} className="input" value={name} placeholder="Who or what will use this key" onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Source" error={errors.source ?? null} hint={sources.isSuccess && list.length === 0 ? 'Add a source first. Each key belongs to one source.' : null}>
          {(c) => (
            <select {...c} className="input" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              <option value="">Pick a source</option>
              {list.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <fieldset className={styles.section}>
          <legend className={styles.sectionTitle}>What it can do</legend>
          {ACCESS.map((a) => (
            <div key={a.access} className={styles.row}>
              <input id={`${radio}-${a.access}`} type="radio" name={`${radio}-access`} checked={access === a.access} onChange={() => setAccess(a.access)} />
              <label htmlFor={`${radio}-${a.access}`}>
                <strong>{a.label}</strong> <span className={styles.note}>{a.about}</span>
              </label>
            </div>
          ))}
        </fieldset>
        <div className={styles.row}>
          <span className={styles.grow} />
          <Button variant="secondary" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            Create key
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
