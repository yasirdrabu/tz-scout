import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useFormat } from '../../lib/useFormat';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { EmptyState } from '../../ui/EmptyState';
import { Pill } from '../../ui/Pill';
import { LoadFailed, LoadingRows, useRun } from '../settings/shared';
import { archivePractice, offerStatsQuery, practiceQuery, statusTone, type Offer, type OfferStat, type Practice } from './api';
import styles from './Offers.module.css';

type Props = {
  tenant: string;
  practiceId: string;
  /** The practice as the list has it, shown while its own request loads. */
  listed: Practice | undefined;
  offers: Offer[];
  canManage: boolean;
  onEdit: () => void;
  onAddOffer: () => void;
};

/** "{n} accounts matched · {n} won", or "No accounts matched yet" (the counts are the API's, C8). */
export function matchedLine(stat: OfferStat | undefined, n: (x: number) => string): string {
  if (!stat || stat.matched === 0) return 'No accounts matched yet';
  return `${n(stat.matched)} ${stat.matched === 1 ? 'account' : 'accounts'} matched · ${n(stat.won)} won`;
}

/** §19 Practice view: name, lead and offer count, positioning, a card per offer, and the practice actions. */
export function PracticeView({ tenant, practiceId, listed, offers, canManage, onEdit, onAddOffer }: Props) {
  const f = useFormat();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const practice = useQuery({ ...practiceQuery(tenant, practiceId), placeholderData: listed });
  const stats = useQuery(offerStatsQuery(tenant));
  const [confirming, setConfirming] = useState(false);
  const del = useRun();

  if (practice.isPending) return <LoadingRows>Loading the practice</LoadingRows>;
  if (practice.isError) return <LoadFailed title="This practice didn't load" error={practice.error} onRetry={() => void practice.refetch()} />;
  const p = practice.data;
  const count = `${f.number(p.offer_count)} ${p.offer_count === 1 ? 'offer' : 'offers'}`;

  async function remove() {
    const ok = await del.run(() => archivePractice(tenant, p.id), `${p.name} deleted.`);
    setConfirming(false);
    if (!ok) return;
    await queryClient.invalidateQueries({ queryKey: ['offers', tenant] });
    void navigate({ to: '/t/$tenant/offers', params: { tenant } });
  }

  return (
    <section aria-labelledby="practice-name" className={styles.view}>
      <div className={styles.viewHead}>
        <div className={styles.grow}>
          <span className={styles.eyebrow}>Practice</span>
          <h2 id="practice-name" className={styles.viewTitle}>
            {p.name}
          </h2>
          <p className={styles.meta}>{p.lead_name ? `Led by ${p.lead_name} · ${count}` : `No lead yet · ${count}`}</p>
        </div>
        {canManage && p.status === 'active' && (
          <div className={styles.actions}>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              Delete practice
            </Button>
            <Button size="sm" variant="secondary" onClick={onEdit}>
              Edit practice
            </Button>
            <Button size="sm" onClick={onAddOffer}>
              Add an offer to this practice
            </Button>
          </div>
        )}
      </div>
      {p.description && <p className={styles.prose}>{p.description}</p>}

      {offers.length === 0 ? (
        <EmptyState title="No offers yet">{canManage ? 'Add the first offer this practice sells.' : 'Offers show here once they are active.'}</EmptyState>
      ) : (
        <ul className={styles.cards}>
          {offers.map((o) => (
            <li key={o.id} className={styles.card}>
              <div className={styles.cardHead}>
                <Link to="/t/$tenant/offers/$practiceId/$offerId" params={{ tenant, practiceId: p.id, offerId: o.id }} className={styles.cardTitle}>
                  {o.name}
                </Link>
                <Pill tone={statusTone(o.status)}>{o.status_label}</Pill>
              </div>
              {o.price_label && <p className={styles.price}>{o.price_label}</p>}
              <p className={styles.summary}>{o.promise}</p>
              <p className={styles.meta}>{matchedLine(stats.data?.get(o.id), f.number)}</p>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${p.name}?`}
        description="Its draft and retired offers stay in the history."
        confirmLabel="Delete practice"
        busy={del.busy}
        onConfirm={() => void remove()}
      />
    </section>
  );
}
