import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../../api/errors';
import { hasScope, type Me } from '../../api/me';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { accountQuery, buyingRolesQuery, personName } from '../account/api';
import { errorText } from '../settings/shared';
import { createRequest, estimateQuery, type EnrichmentKind, type NewRequest } from './api';
import styles from './Enrichment.module.css';
import { CORE_ROLES, EVERYONE_EMAILED, FLAGGED_TEXT, JOINED_TEXT, KINDS, PEOPLE_MAX, providersFor, REASON_NEEDED, ROLE_NEEDED, startedText, TOO_MANY_PEOPLE } from './words';

export type EnrichDialogProps = {
  tenant: string;
  me: Me;
  accountId: string;
  name: string;
  onClose: () => void;
  /** After a request was created or joined. */
  onDone?: () => void;
};

const REASON_MAX = 500;

/**
 * §4c Enrich dialog: what to find, the provider, the buying roles or people, the API's estimate. An
 * approver runs it; anyone else says why it is worth the spend and asks for approval (Ruling 1).
 */
export function EnrichDialog({ tenant, me, accountId, name, onClose, onDone }: EnrichDialogProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const account = useQuery(accountQuery(tenant, accountId));
  const buying = useQuery(buyingRolesQuery(tenant));
  const approver = me.kind === 'user' && hasScope(me, 'enrichment:approve');

  const [kind, setKind] = useState<EnrichmentKind>('people_for_roles');
  const [provider, setProvider] = useState(providersFor('people_for_roles')[0]!.key);
  // null until the person changes them: the core roles with no person yet, and the first 25 people without an email.
  const [roles, setRoles] = useState<string[] | null>(null);
  const [people, setPeople] = useState<string[] | null>(null);
  const [reason, setReason] = useState('');
  const [roleError, setRoleError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const allRoles = buying.data?.data ?? [];
  const persons = account.data?.people ?? [];
  const covered = new Set(persons.flatMap((p) => p.roles.map((r) => r.key)));
  const pickedRoles = roles ?? allRoles.filter((r) => CORE_ROLES.includes(r.key) && !covered.has(r.key)).map((r) => r.key);
  const noEmail = persons.filter((p) => !p.email);
  const pickedPeople = people ?? noEmail.slice(0, PEOPLE_MAX).map((p) => p.id);
  const tooMany = kind === 'email_reveal' && pickedPeople.length > PEOPLE_MAX;

  const choice: Omit<NewRequest, 'reason'> = {
    kind,
    provider_key: provider,
    ...(kind === 'people_for_roles' ? { roles: pickedRoles } : {}),
    ...(kind === 'email_reveal' ? { person_ids: pickedPeople } : {}),
  };
  const ready = kind === 'people_for_roles' ? pickedRoles.length > 0 : kind === 'email_reveal' ? pickedPeople.length > 0 && !tooMany : true;
  const estimate = useQuery({ ...estimateQuery(tenant, accountId, choice), enabled: ready });
  const nobody = kind === 'email_reveal' && account.isSuccess && noEmail.length === 0;

  function pickKind(next: EnrichmentKind) {
    setKind(next);
    const options = providersFor(next);
    if (!options.some((o) => o.key === provider)) setProvider(options[0]!.key);
    setError(null);
  }

  // Kept in the buying roles' own order, so the same picks ask for the same estimate.
  function toggleRole(key: string) {
    const set = new Set(pickedRoles);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    setRoles(allRoles.filter((r) => set.has(r.key)).map((r) => r.key));
    setRoleError(null);
  }

  function togglePerson(id: string) {
    setPeople(pickedPeople.includes(id) ? pickedPeople.filter((x) => x !== id) : persons.filter((p) => p.id === id || pickedPeople.includes(p.id)).map((p) => p.id));
  }

  async function submit() {
    const why = reason.trim();
    const noRole = kind === 'people_for_roles' && pickedRoles.length === 0;
    const noReason = !approver && !why;
    setRoleError(noRole ? ROLE_NEEDED : null);
    setReasonError(noReason ? REASON_NEEDED : null);
    if (noRole || noReason || nobody || tooMany) return;
    setBusy(true);
    setError(null);
    try {
      const r = await createRequest(tenant, accountId, { ...choice, ...(approver ? {} : { reason: why }) });
      await queryClient.invalidateQueries({ queryKey: ['account', tenant, accountId] });
      toast.show(r.joined ? JOINED_TEXT : r.status === 'flagged' ? FLAGGED_TEXT : startedText(name));
      onDone?.();
      onClose();
    } catch (e) {
      const field = e instanceof ApiError ? e.errors.find((x) => x.path === 'reason') : undefined;
      if (field && !approver) setReasonError(field.message);
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Enrich ${name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || nobody || tooMany}>
            {approver ? 'Run enrichment' : 'Ask for approval'}
          </Button>
        </>
      }
    >
      <form
        className={styles.form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="What to find">
          {(c) => (
            <select {...c} className="input" value={kind} onChange={(e) => pickKind(e.target.value as EnrichmentKind)}>
              {KINDS.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Provider">
          {(c) => (
            <select {...c} className="input" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {providersFor(kind).map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
        </Field>

        {kind === 'people_for_roles' && (
          <fieldset className={styles.group} aria-describedby={roleError ? 'enrich-roles-error' : undefined}>
            <legend className={styles.legend}>Buying roles</legend>
            {buying.isPending ? (
              <p className={styles.note}>Loading buying roles</p>
            ) : buying.isError ? (
              <p className={styles.error}>{`Buying roles didn't load. ${errorText(buying.error)}`}</p>
            ) : (
              allRoles.map((r) => (
                <label key={r.key} className={styles.check}>
                  <input type="checkbox" checked={pickedRoles.includes(r.key)} onChange={() => toggleRole(r.key)} />
                  {r.label}
                </label>
              ))
            )}
            {roleError && (
              <p id="enrich-roles-error" className={styles.error}>
                {roleError}
              </p>
            )}
          </fieldset>
        )}

        {kind === 'email_reveal' && (
          <fieldset className={styles.group} aria-describedby={tooMany ? 'enrich-people-error' : undefined}>
            <legend className={styles.legend}>People</legend>
            {account.isPending ? (
              <p className={styles.note}>Loading people</p>
            ) : nobody ? (
              <p className={styles.note}>{EVERYONE_EMAILED}</p>
            ) : (
              noEmail.map((p) => (
                <label key={p.id} className={styles.check}>
                  <input type="checkbox" checked={pickedPeople.includes(p.id)} onChange={() => togglePerson(p.id)} />
                  {personName(p)}
                </label>
              ))
            )}
            {tooMany && (
              <p id="enrich-people-error" className={styles.error}>
                {TOO_MANY_PEOPLE}
              </p>
            )}
          </fieldset>
        )}

        {ready && (
          <p className={styles.estimate} aria-live="polite">
            {estimate.isPending ? 'Working out the cost' : estimate.isError ? `The estimate didn't load. ${errorText(estimate.error)}` : estimate.data.text}
          </p>
        )}

        {!approver && (
          <Field label="Why is this worth it?" error={reasonError}>
            {(c) => (
              <textarea
                {...c}
                className="input"
                rows={3}
                maxLength={REASON_MAX}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setReasonError(null);
                }}
              />
            )}
          </Field>
        )}

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
