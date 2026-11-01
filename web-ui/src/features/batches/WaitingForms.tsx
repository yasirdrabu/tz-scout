import { useId, useState } from 'react';
import { ApiError } from '../../api/errors';
import { Button } from '../../ui/Button';
import { useToast } from '../../ui/Toast';
import { errorText } from '../settings/shared';
import { chooseDuplicate, supplyCompany, supplyWebsite, type BatchItem } from './api';
import styles from './Batches.module.css';

type Props = { tenant: string; item: BatchItem; onResolved: () => void };

/** "like {name}.org": the company's name as a web address, for the empty-website hint. */
const exampleHost = (name: string | null) => `${(name ?? 'example').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'example'}.org`;

/** Runs an answer: the toast on success, the API's words under the form on failure. */
function useAnswer(item: BatchItem, onResolved: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send(call: () => Promise<unknown>, name: string) {
    setBusy(true);
    setError(null);
    try {
      await call();
      toast.show(`${name} resolved.`);
      onResolved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, send, name: item.company_name ?? 'The row' };
}

function WebsiteForm({ tenant, item, onResolved }: Props) {
  const id = useId();
  const [website, setWebsite] = useState('');
  const a = useAnswer(item, onResolved);
  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        if (!website.trim()) return a.setError(`Add a website first, like ${exampleHost(item.company_name)}`);
        void a.send(() => supplyWebsite(tenant, item.id, website.trim()), a.name);
      }}
    >
      <label htmlFor={id} className="sr-only">{`Website for ${a.name}`}</label>
      <input id={id} type="text" className="input" placeholder="Add a website, like example.org" value={website} onChange={(e) => setWebsite(e.target.value)} {...(a.error ? { 'aria-invalid': true } : {})} />
      <Button size="sm" type="submit" disabled={a.busy}>
        Resolve
      </Button>
      {a.error && <p className={styles.error} role="alert">{a.error}</p>}
    </form>
  );
}

function CompanyForm({ tenant, item, onResolved }: Props) {
  const base = useId();
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [sole, setSole] = useState(false);
  const [person, setPerson] = useState('');
  const a = useAnswer(item, onResolved);
  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        const body = sole
          ? { sole_proprietor: true as const, ...(person.trim() ? { person_name: person.trim() } : {}) }
          : { name: name.trim(), ...(website.trim() ? { website: website.trim() } : {}) };
        void a.send(() => supplyCompany(tenant, item.id, body), sole ? person.trim() || a.name : name.trim() || a.name);
      }}
    >
      {sole ? (
        <>
          <label htmlFor={`${base}-person`} className="sr-only">
            Person's name
          </label>
          <input id={`${base}-person`} type="text" className="input" placeholder="Person's name" value={person} onChange={(e) => setPerson(e.target.value)} />
        </>
      ) : (
        <>
          <label htmlFor={`${base}-name`} className="sr-only">
            Company name
          </label>
          <input id={`${base}-name`} type="text" className="input" placeholder="Company name" value={name} onChange={(e) => setName(e.target.value)} />
          <label htmlFor={`${base}-site`} className="sr-only">
            Website (optional)
          </label>
          <input id={`${base}-site`} type="text" className="input" placeholder="Website (optional)" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </>
      )}
      <label className={styles.muted}>
        <input type="checkbox" checked={sole} onChange={(e) => setSole(e.target.checked)} /> This is a sole proprietor
      </label>
      <Button size="sm" type="submit" disabled={a.busy}>
        Resolve
      </Button>
      {a.error && <p className={styles.error} role="alert">{a.error}</p>}
    </form>
  );
}

function DuplicateForm({ tenant, item, onResolved }: Props) {
  const a = useAnswer(item, onResolved);
  return (
    <div className={styles.form}>
      {item.duplicate_candidates.map((c) => (
        <span key={c.account_id} className={styles.form}>
          <span>
            {c.name}
            {c.domain && <span className={styles.muted}> {c.domain}</span>}
          </span>
          <Button size="sm" variant="secondary" disabled={a.busy} aria-label={`Same company as ${c.name}`} onClick={() => void a.send(() => chooseDuplicate(tenant, item.id, { same_as: c.account_id }), a.name)}>
            Same company
          </Button>
        </span>
      ))}
      <Button size="sm" variant="ghost" disabled={a.busy} onClick={() => void a.send(() => chooseDuplicate(tenant, item.id, { new_company: true }), a.name)}>
        It's a new company
      </Button>
      {a.error && <p className={styles.error} role="alert">{a.error}</p>}
    </div>
  );
}

/** §14: the form a waiting row needs, by what it waits on. */
export function WaitingForm(props: Props) {
  if (props.item.waiting_on === 'needs_website') return <WebsiteForm {...props} />;
  if (props.item.waiting_on === 'needs_company') return <CompanyForm {...props} />;
  if (props.item.waiting_on === 'possible_duplicate') return <DuplicateForm {...props} />;
  return null;
}
