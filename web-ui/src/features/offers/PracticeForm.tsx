import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/errors';
import { Button } from '../../ui/Button';
import { Drawer } from '../../ui/Drawer';
import { Field } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { errorText } from '../settings/shared';
import { directoryQuery } from '../sources/api';
import { createPractice, patchPractice, type Practice } from './api';
import styles from './Offers.module.css';

const NAME_NEEDED = 'Give the practice a name.';

type Props = { tenant: string; open: boolean; practice: Practice | undefined; onClose: () => void };

/** §19 Practice form: Name, Practice lead (from the member directory) and Positioning. */
export function PracticeForm({ tenant, open, practice, onClose }: Props) {
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()} title={practice ? 'Edit practice' : 'New practice'} width={480}>
      {open && <Fields key={practice?.id ?? 'new'} tenant={tenant} practice={practice} onClose={onClose} />}
    </Drawer>
  );
}

function Fields({ tenant, practice, onClose }: Omit<Props, 'open'>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const directory = useQuery(directoryQuery(tenant));
  const [name, setName] = useState(practice?.name ?? '');
  const [lead, setLead] = useState(practice?.lead_user_id ?? '');
  const [positioning, setPositioning] = useState(practice?.description ?? '');
  const [errors, setErrors] = useState<{ name?: string; lead?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setErrors({ name: NAME_NEEDED });
      return;
    }
    setErrors({});
    setBusy(true);
    const body = { name: name.trim(), lead_user_id: lead || null, description: positioning.trim() || null };
    try {
      if (practice) {
        const saved = await patchPractice(tenant, practice.id, body);
        toast.show(`Changes to ${saved.name} saved.`);
        await queryClient.invalidateQueries({ queryKey: ['offers', tenant] });
        onClose();
      } else {
        const made = await createPractice(tenant, body);
        toast.show(`${made.name} created. Add its first offer.`);
        await queryClient.invalidateQueries({ queryKey: ['offers', tenant] });
        void navigate({ to: '/t/$tenant/offers/$practiceId', params: { tenant, practiceId: made.id }, search: {} });
      }
    } catch (err) {
      const at = (path: string) => (err instanceof ApiError ? err.errors.find((x) => x.path === path)?.message : undefined);
      const nameError = at('name') ?? (err instanceof ApiError && err.code === 'slug-taken' ? err.message : undefined);
      const leadError = at('lead_user_id');
      setErrors({ ...(nameError ? { name: nameError } : {}), ...(leadError ? { lead: leadError } : {}), ...(!nameError && !leadError ? { form: errorText(err) } : {}) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={(e) => void submit(e)} noValidate>
      {errors.form && (
        <p role="alert" className={styles.formError}>
          {errors.form}
        </p>
      )}
      <Field label="Name" error={errors.name ?? null}>
        {(c) => <input {...c} className="input" value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="Practice lead" error={errors.lead ?? null}>
        {(c) => (
          <select {...c} className="input" value={lead} onChange={(e) => setLead(e.target.value)}>
            <option value="">No lead yet</option>
            {directory.data?.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Positioning">
        {(c) => <textarea {...c} className="input" rows={4} value={positioning} onChange={(e) => setPositioning(e.target.value)} />}
      </Field>
      <div className={styles.formFooter}>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {practice ? 'Save changes' : 'Create practice'}
        </Button>
      </div>
    </form>
  );
}
