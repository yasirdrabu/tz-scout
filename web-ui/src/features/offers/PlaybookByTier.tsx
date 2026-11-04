import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '../../ui/Button';
import { LoadingLine } from '../../ui/LoadingLine';
import { useToast } from '../../ui/Toast';
import { TIER_WORD, playbooksQuery, span } from '../playbooks/api';
import { TierChip } from '../review/parts';
import { LoadFailed, LoadingRows, copyText, errorText, useRun } from '../settings/shared';
import { offerPlaybooksQuery, setOfferPlaybook, type OfferPlaybook } from './api';
import styles from './Offers.module.css';

const EMPTY_NOTE: Record<OfferPlaybook['tier'], string> = {
  act_now: 'AE works it with no set steps.',
  good_fit: 'AE works it with no set steps.',
  watch: 'Stays in the queue as Watch. Scout re-scores it weekly.',
};

type Props = {
  tenant: string;
  offerId: string;
  /** offers:manage or playbooks:manage (Ruling 10): the selects. Otherwise the names show as text. */
  canPick: boolean;
  /** playbooks:read: the Open links. */
  canOpen: boolean;
};

/** §19 "Playbook by tier": what each tier of the offer runs, with a select for those who may change it. */
export function PlaybookByTier({ tenant, offerId, canPick, canOpen }: Props) {
  const queryClient = useQueryClient();
  const tiers = useQuery(offerPlaybooksQuery(tenant, offerId));
  const playbooks = useQuery({ ...playbooksQuery(tenant), enabled: canPick });
  const act = useRun();

  if (tiers.isPending) return <LoadingRows rows={3}>Loading the playbooks</LoadingRows>;
  if (tiers.isError) return <LoadFailed title="The playbooks didn't load" error={tiers.error} onRetry={() => void tiers.refetch()} />;
  // A viewer cannot list playbooks: they get the current names read-only. A person who can pick waits for the list.
  const options = canPick ? playbooks.data?.filter((p) => p.status === 'active') : undefined;
  const loading = canPick && playbooks.isPending;
  const failed = canPick && playbooks.isError;

  async function pick(row: OfferPlaybook, id: string) {
    const chosen = options?.find((p) => p.id === id);
    const word = TIER_WORD[row.tier];
    const ok = await act.run(() => setOfferPlaybook(tenant, offerId, row.tier, id || null), chosen ? `${word} now uses ${chosen.name}.` : `${word} has no playbook now.`);
    if (ok) await queryClient.invalidateQueries({ queryKey: ['offers', tenant] });
  }

  return (
    <section className={styles.section} aria-label="Playbook by tier">
      <h3 className={styles.sectionTitle}>Playbook by tier</h3>
      <p className={styles.note}>Starts when an AE accepts an account matched to this offer</p>
      <ul className={styles.tierRows}>
        {tiers.data.map((row) => {
          const word = TIER_WORD[row.tier];
          const current = row.playbook;
          return (
            <li key={row.tier} className={styles.tierRow}>
              <div className={styles.tierLine}>
                <span className={styles.tierChip}>
                  <TierChip tier={row.tier} label={word} />
                </span>
                {loading ? (
                  <LoadingLine>Loading playbooks</LoadingLine>
                ) : failed ? (
                  <p role="alert" className={styles.formError}>
                    {errorText(playbooks.error)}
                  </p>
                ) : options ? (
                  <select className="input" aria-label={`${word} playbook`} value={current?.id ?? ''} disabled={act.busy} onChange={(e) => void pick(row, e.target.value)}>
                    <option value="">No playbook</option>
                    {current && !options.some((p) => p.id === current.id) && <option value={current.id}>{current.name}</option>}
                    {options.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className={styles.tierName}>{current?.name ?? 'No playbook'}</span>
                )}
                {current && canOpen && (
                  <Link to="/t/$tenant/playbooks/$id" params={{ tenant, id: current.id }} className={styles.link} aria-label={`Open ${current.name}`}>
                    Open
                  </Link>
                )}
              </div>
              <p className={styles.note}>{current ? span(current.steps, current.days) : EMPTY_NOTE[row.tier]}</p>
            </li>
          );
        })}
      </ul>
      <p className={styles.note}>Changing a playbook affects accounts accepted from now on. Accounts already running keep the playbook they started with.</p>
    </section>
  );
}

/** §19 "Initial message": the first email of each tier's playbook, raw template text, one block per tier. */
export function InitialMessage({ tenant, offerId }: { tenant: string; offerId: string }) {
  const toast = useToast();
  const tiers = useQuery(offerPlaybooksQuery(tenant, offerId));
  const withEmail = (tiers.data ?? []).filter((t) => t.first_email);
  if (!withEmail.length) return null;

  async function copy(subject: string, body: string) {
    if (await copyText(`Subject: ${subject}\n\n${body}`)) toast.show('Initial message copied.');
    else toast.show("Couldn't copy. Select the text and copy it instead.");
  }

  return (
    <section className={styles.section} aria-label="Initial message">
      <h3 className={styles.sectionTitle}>Initial message</h3>
      <p className={styles.note}>Scout fills in {'{account.name}'}, {'{person.first_name}'} and the other placeholders when the plan starts.</p>
      {withEmail.map((t) => (
        <div key={t.tier} className={styles.message} role="group" aria-label={`${TIER_WORD[t.tier]} initial message`}>
          <div className={styles.tierLine}>
            <TierChip tier={t.tier} label={TIER_WORD[t.tier]} />
            <span className={styles.grow} />
            <Button size="sm" variant="ghost" onClick={() => void copy(t.first_email!.subject, t.first_email!.body)}>
              Copy
            </Button>
          </div>
          <p className={styles.messageSubject}>{t.first_email!.subject}</p>
          <p className={styles.messageBody}>{t.first_email!.body}</p>
        </div>
      ))}
    </section>
  );
}
