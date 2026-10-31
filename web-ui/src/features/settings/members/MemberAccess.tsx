import { useState } from 'react';
import { Button } from '../../../ui/Button';
import { Field } from '../../../ui/Field';
import { useRun } from '../shared';
import styles from '../Settings.module.css';
import { updateMember, type Member, type Practice } from './api';
import { practiceIds, practiceText } from './words';

type Props = { member: Member; tenant: string; canManage: boolean; onSaved: () => Promise<unknown> };

/** Practice chips: "All practices" or some of them (leaders and AEs). */
export function PracticePicker({ practices, value, onChange, disabled }: { practices: Practice[]; value: string[] | null; onChange: (ids: string[] | null) => void; disabled?: boolean }) {
  const toggle = (id: string) => {
    const now = value ?? [];
    const next = now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
    onChange(next.length ? next : null);
  };
  return (
    <div className={styles.chips} role="group" aria-label="Practice access">
      <button type="button" className={styles.choice} aria-pressed={value === null} disabled={disabled} onClick={() => onChange(null)}>
        All practices
      </button>
      {practices.map((p) => (
        <button key={p.id} type="button" className={styles.choice} aria-pressed={!!value?.includes(p.id)} disabled={disabled} onClick={() => toggle(p.id)}>
          {p.name}
        </button>
      ))}
    </div>
  );
}

export function PracticeAccess({ member, tenant, practices, canManage, onSaved }: Props & { practices: Practice[] }) {
  const saved = practiceIds(member.data_limit);
  const [value, setValue] = useState<string[] | null>(saved);
  const { run, busy } = useRun();
  const changed = JSON.stringify(value) !== JSON.stringify(saved);

  function save() {
    void run(async () => {
      await updateMember(tenant, member.id, { data_limit: value ? { kind: 'practices', ids: value } : null });
      await onSaved();
    }, `Practice access saved for ${member.name}.`);
  }

  return (
    <section className={styles.section} aria-labelledby="member-practices">
      <h3 id="member-practices" className={styles.sectionTitle}>
        Practice access
      </h3>
      {canManage && practices.length > 0 ? (
        <PracticePicker practices={practices} value={value} onChange={setValue} disabled={busy} />
      ) : (
        <p>{practiceText(member.data_limit, practices)}</p>
      )}
      <p className={styles.note}>They only see accounts, offers and pipeline for these practices.</p>
      {canManage && changed && (
        <div className={styles.row}>
          <Button size="sm" onClick={save} disabled={busy}>
            Save practice access
          </Button>
        </div>
      )}
    </section>
  );
}

export function HubSpotUser({ member, tenant, canManage, onSaved }: Props) {
  const saved = member.crm_owner_ids.hubspot ?? '';
  const [value, setValue] = useState(saved);
  const { run, busy } = useRun();

  function save() {
    const ids = { ...member.crm_owner_ids };
    if (value.trim()) ids.hubspot = value.trim();
    else delete ids.hubspot;
    void run(async () => {
      await updateMember(tenant, member.id, { crm_owner_ids: ids });
      await onSaved();
    }, `HubSpot user saved for ${member.name}.`);
  }

  const hint = 'Scout makes this person the HubSpot owner of accounts assigned to them.';
  if (!canManage) {
    return (
      <dl className={styles.facts}>
        <dt>HubSpot user</dt>
        <dd>{saved || 'Not set'}</dd>
      </dl>
    );
  }
  return (
    <div className={styles.section}>
      <Field label="HubSpot user" hint={hint}>
        {(control) => <input {...control} className="input" value={value} placeholder="HubSpot owner id" onChange={(e) => setValue(e.target.value)} />}
      </Field>
      {value.trim() !== saved && (
        <div className={styles.row}>
          <Button size="sm" onClick={save} disabled={busy}>
            Save HubSpot user
          </Button>
        </div>
      )}
    </div>
  );
}
