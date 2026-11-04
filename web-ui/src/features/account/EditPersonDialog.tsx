import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../../api/errors';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { errorText } from '../settings/shared';
import { buyingRolesQuery, editPerson, personName, type Person, type PersonPatch } from './api';
import styles from './Account.module.css';

/** Edit a person's buying roles and decision note. Saving here never confirms a guessed role. */
export function EditPersonDialog({ tenant, accountId, person, onClose }: { tenant: string; accountId: string; person: Person; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const roles = useQuery(buyingRolesQuery(tenant));
  const name = personName(person);
  const heldKeys = person.roles.map((r) => r.key);
  const [picked, setPicked] = useState(heldKeys);
  const [note, setNote] = useState(person.decision_note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);

  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));

  async function submit() {
    const body: PersonPatch = {};
    const rolesChanged = picked.length !== heldKeys.length || picked.some((k) => !heldKeys.includes(k));
    // Held roles keep their order, then the newly ticked ones.
    if (rolesChanged) body.role_keys = [...heldKeys.filter((k) => picked.includes(k)), ...picked.filter((k) => !heldKeys.includes(k))];
    if (note !== (person.decision_note ?? '')) body.decision_note = note;
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    setNoteError(null);
    try {
      await editPerson(tenant, person.id, body);
      await queryClient.invalidateQueries({ queryKey: ['account', tenant, accountId] });
      toast.show(`Saved ${name}.`);
      onClose();
    } catch (e) {
      const field = e instanceof ApiError ? e.errors.find((x) => x.path === 'decision_note') : undefined;
      if (field) setNoteError(field.message);
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Edit ${name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            Save
          </Button>
        </>
      }
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className={styles.group}>
          <legend className={styles.legend}>Buying roles</legend>
          {roles.isPending ? (
            <p className={styles.note}>Loading buying roles</p>
          ) : roles.isError ? (
            <p className={styles.error}>{`Buying roles didn't load. ${errorText(roles.error)}`}</p>
          ) : (
            roles.data.data.map((r) => (
              <label key={r.key} className={styles.check}>
                <input type="checkbox" checked={picked.includes(r.key)} onChange={() => toggle(r.key)} />
                {r.label}
              </label>
            ))
          )}
        </fieldset>
        <Field label="Decision note" hint="Where they stand. Up to 1,000 characters." error={noteError}>
          {(c) => <textarea {...c} className="input" value={note} onChange={(e) => {
            setNote(e.target.value);
            setNoteError(null);
          }} />}
        </Field>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
