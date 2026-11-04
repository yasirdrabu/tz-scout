import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { hasScope, type Me } from '../../api/me';
import { formatMoney } from '../../lib/format';
import { useFormat } from '../../lib/useFormat';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { addNote, notesQuery, type AccountReview } from '../review/api';
import { NOTE_MAX } from '../review/ReasonPicker';
import { errorText, useRun } from '../settings/shared';
import { accountQuery, addPerson, buyingRolesQuery, checkCrm, committeeQuery, crmCheckQuery, editPerson, listWithAnd, personName, type AccountDetail, type CrmCheck, type Person } from './api';
import { EditPersonDialog } from './EditPersonDialog';
import styles from './Account.module.css';

/** §4a 8. Buying committee: people with their role labels and notes; `Add a person` with `people:write`. */
export function BuyingCommittee({ tenant, me, account, canAdd = true, onFind }: { tenant: string; me: Me; account: AccountDetail; canAdd?: boolean; onFind: (roles: string[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Person | null>(null);
  const queryClient = useQueryClient();
  const f = useFormat();
  const { run, busy } = useRun();
  const write = hasScope(me, 'people:write');
  const add = canAdd && write;
  const find = hasScope(me, 'enrichment:request');
  // Loading or failed: the rail is today's, with no coverage.
  const committee = useQuery(committeeQuery(tenant, account.id)).data;
  const required = committee?.roles.filter((r) => r.required) ?? [];
  const gapRows = committee?.roles.filter((r) => r.status === 'gap') ?? [];
  const saveRoles = (p: Person, body: { role_keys: string[]; confirm_role_keys?: string[] }, done: string) =>
    run(async () => {
      await editPerson(tenant, p.id, body);
      await queryClient.invalidateQueries({ queryKey: ['account', tenant, account.id] });
    }, done);
  return (
    <Card
      title="Buying committee"
      actions={
        add ? (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            Add a person
          </Button>
        ) : undefined
      }
    >
      {committee && <p className={styles.muted}>{`${committee.offer?.name ?? 'Core roles'}: ${committee.summary.text}`}</p>}
      {account.people.length === 0 ? (
        <>
          <p className={styles.note}>
            {committee
              ? `No people yet. Add someone you know, or Enrich will look for ${listWithAnd(required.map((r) => r.label))}.`
              : 'No people yet. Add someone you know, or Enrich will look for a business owner, commercial buyer and technical buyer.'}
          </p>
          {committee && find && required.length > 0 && (
            <Button size="sm" variant="secondary" onClick={() => onFind(required.map((r) => r.key))}>
              Find with Enrich
            </Button>
          )}
        </>
      ) : (
        <ul className={styles.rows}>
          {account.people.map((p) => (
            <li key={p.id} className={styles.person}>
              <Avatar name={personName(p)} size="sm" decorative />
              <span className={styles.stack}>
                <strong>{personName(p)}</strong>
                {p.title && <span className={styles.muted}>{p.title}</span>}
                {p.roles.map((r) => {
                  const keys = p.roles.map((x) => x.key);
                  const name = personName(p);
                  return (
                    <span key={r.key} className={styles.roleLine}>
                      <span>{r.label}</span>
                      {r.origin === 'guessed_from_title' && (
                        <>
                          <span className={styles.chip}>Guessed from title</span>
                          {write && (
                            <>
                              <button type="button" className={styles.textButton} disabled={busy} aria-label={`Confirm ${r.label} for ${name}`} onClick={() => void saveRoles(p, { role_keys: keys, confirm_role_keys: [r.key] }, `${r.label} confirmed for ${name}.`)}>
                                Confirm
                              </button>
                              <button type="button" className={styles.textButton} disabled={busy} aria-label={`Remove ${r.label} from ${name}`} onClick={() => void saveRoles(p, { role_keys: keys.filter((k) => k !== r.key) }, `${r.label} removed from ${name}.`)}>
                                Remove
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </span>
                  );
                })}
                {p.decision_note && (
                  <span className={styles.muted}>{p.decision_note_by && p.decision_note_at ? `${p.decision_note} · ${p.decision_note_by.name ?? 'Someone'}, ${f.monthDay(p.decision_note_at)}` : p.decision_note}</span>
                )}
                {write && (
                  <span>
                    <button type="button" className={styles.textButton} aria-label={`Edit ${personName(p)}`} onClick={() => setEditing(p)}>
                      Edit
                    </button>
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {account.people.length > 0 && gapRows.length > 0 && (
        <ul className={styles.rows}>
          {gapRows.map((r) => (
            <li key={r.key} className={styles.dotRow}>
              <span>{`No ${r.label.toLowerCase()} yet${r.required ? '' : ' · Optional'}`}</span>
              {find && (
                <button type="button" className={styles.textButton} onClick={() => onFind([r.key])} aria-label={`Find ${r.label.toLowerCase()}`}>
                  Find
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <EditPersonDialog tenant={tenant} accountId={account.id} person={editing} onClose={() => setEditing(null)} />}
      {adding && <AddPersonDialog tenant={tenant} id={account.id} onClose={() => setAdding(false)} />}
    </Card>
  );
}

function AddPersonDialog({ tenant, id, onClose }: { tenant: string; id: string; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const roles = useQuery(buyingRolesQuery(tenant));
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) {
      setError("Add the person's name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addPerson(tenant, id, {
        name: name.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(role ? { buying_role: role } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: accountQuery(tenant, id).queryKey });
      toast.show(`Added ${name.trim()} to the buying committee.`);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a person"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            Add person
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
        <Field label="Name">{(c) => <input {...c} className="input" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Title">{(c) => <input {...c} className="input" value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label="Email">{(c) => <input {...c} type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Role">
          {(c) => (
            <select {...c} className="input" value={role} disabled={roles.isPending} onChange={(e) => setRole(e.target.value)}>
              <option value="">No role yet</option>
              {(roles.data?.data ?? []).map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          )}
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

/** §4a 8. Notes ("Scout uses these in the brief"): the peek drawer's list and an add box. */
export function Notes({ tenant, id }: { tenant: string; id: string }) {
  const f = useFormat();
  const queryClient = useQueryClient();
  const notes = useQuery(notesQuery(tenant, id));
  const { run, busy } = useRun();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  function add() {
    if (!draft.trim()) {
      setError('Write the note first, then add it.');
      return;
    }
    setError(null);
    void run(async () => {
      await addNote(tenant, id, draft.trim());
      setDraft('');
      await queryClient.invalidateQueries({ queryKey: notesQuery(tenant, id).queryKey });
    }, 'Note added. Everyone reviewing this account can see it.');
  }

  return (
    <Card title="Notes" actions={<span className={styles.note}>Scout uses these in the brief</span>}>
      <div className={styles.form}>
        {notes.isError && <p className={styles.error}>{`Notes didn't load. ${errorText(notes.error)}`}</p>}
        {(notes.data?.data ?? []).map((n) => (
          <div key={n.id} className={styles.stack}>
            <span className={styles.muted}>{`${n.by_name ?? 'Someone'} · ${f.date(n.at)}`}</span>
            <span className={styles.text}>{n.body}</span>
          </div>
        ))}
        <label className="sr-only" htmlFor="acct-note">
          Add a note
        </label>
        <textarea
          id="acct-note"
          className="input"
          placeholder="Add context Scout can't find. Relationships, past deals, timing."
          value={draft}
          maxLength={NOTE_MAX}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'acct-note-error' : undefined}
          onChange={(e) => setDraft(e.target.value)}
        />
        {error && (
          <p id="acct-note-error" className={styles.error}>
            {error}
          </p>
        )}
        <div>
          <Button size="sm" onClick={add} disabled={busy}>
            Add note
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** §4a 8. Where it came from: each source with its owner. Batch and Source record tiles are R3. */
export function WhereFrom({ review }: { review: AccountReview }) {
  return (
    <Card title="Where it came from">
      {review.sources.length === 0 ? (
        <p className={styles.note}>No source is recorded for this account.</p>
      ) : (
        <ul className={styles.rows}>
          {review.sources.map((s) => (
            <li key={s.source_id}>
              <span className={styles.stack}>
                <strong>{s.name}</strong>
                {s.via && <span className={styles.muted}>{s.via}</span>}
                {s.owner_name && <span className={styles.muted}>{`Owner: ${s.owner_name}`}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The In HubSpot sentence for the stored CRM check. */
export function crmSentence(c: CrmCheck, money: (minor: number, currency: string | null) => string, date: (when: string) => string): string {
  if (c.exists === null) return "Scout hasn't checked HubSpot for this company yet.";
  if (!c.exists) return 'Not in HubSpot yet.';
  if (c.open_deal) {
    const parts = [c.open_deal.name, c.open_deal.amount_cents !== null ? money(c.open_deal.amount_cents, c.open_deal.currency) : null, c.open_deal.last_activity_at ? `last activity ${date(c.open_deal.last_activity_at)}` : null];
    return `Company exists. Open deal owned by ${c.owner_name ?? 'someone'}: ${parts.filter(Boolean).join(', ')}.`;
  }
  if (!c.owner_name && c.open_deals === 0) return 'Company exists with no owner and no open deal. Scout can set the owner.';
  if (c.owner_name) return `Company exists, owned by ${c.owner_name}.`;
  return 'Company exists.';
}

/** §4a 8. In HubSpot: the CRM check card; a person can ask HubSpot again. */
export function InHubSpot({ tenant, me, id }: { tenant: string; me: Me; id: string }) {
  const f = useFormat();
  const queryClient = useQueryClient();
  const check = useQuery(crmCheckQuery(tenant, id));
  const { run, busy } = useRun();
  const money = (minor: number, currency: string | null) => (currency ? formatMoney(minor, currency) : f.money(minor));
  return (
    <Card
      title="In HubSpot"
      actions={
        me.kind === 'user' ? (
          <button
            type="button"
            className={styles.textButton}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                queryClient.setQueryData(crmCheckQuery(tenant, id).queryKey, await checkCrm(tenant, id));
              }, 'Checked HubSpot.')
            }
          >
            Check again
          </button>
        ) : undefined
      }
    >
      {check.isPending ? (
        <p className={styles.note}>Loading the HubSpot check</p>
      ) : check.isError ? (
        <p className={styles.error} role="alert">{`The HubSpot check didn't load. ${errorText(check.error)}`}</p>
      ) : (
        <p className={styles.text}>{crmSentence(check.data, money, f.date)}</p>
      )}
    </Card>
  );
}
