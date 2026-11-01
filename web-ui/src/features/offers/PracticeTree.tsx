import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { cx } from '../../lib/cx';
import { Button } from '../../ui/Button';
import type { Offer, Practice } from './api';
import styles from './Offers.module.css';

/** The dots' key, as screens.md names the statuses. */
const LEGEND = { approved: 'Active', draft: 'Draft', archived: 'Retired' };

type Props = {
  tenant: string;
  practices: Practice[];
  offers: Offer[];
  practiceId: string | undefined;
  offerId: string | undefined;
  canManage: boolean;
  onNewPractice: () => void;
  onAddOffer: (practiceId: string) => void;
};

/** §19 left tree: each practice with the API's offer count, its offers with a status dot, and `Add offer`. */
export function PracticeTree({ tenant, practices, offers, practiceId, offerId, canManage, onNewPractice, onAddOffer }: Props) {
  return (
    <nav aria-label="Practices" className={styles.tree}>
      {canManage && (
        <Button size="sm" variant="secondary" icon={<Plus />} onClick={onNewPractice}>
          New practice
        </Button>
      )}
      <ul className={styles.practices}>
        {practices.map((p) => (
          <li key={p.id}>
            <Link
              to="/t/$tenant/offers/$practiceId"
              params={{ tenant, practiceId: p.id }}
              className={cx(styles.practiceLink, p.id === practiceId && !offerId && styles.current)}
              aria-current={p.id === practiceId && !offerId ? 'page' : undefined}
            >
              <span className={styles.grow}>{p.name}</span>{' '}
              <span className={styles.count}>
                {p.offer_count} <span className="sr-only">{p.offer_count === 1 ? 'offer' : 'offers'}</span>
              </span>
            </Link>
            <ul className={styles.offers}>
              {offers
                .filter((o) => o.practice_id === p.id)
                .map((o) => (
                  <li key={o.id}>
                    <Link
                      to="/t/$tenant/offers/$practiceId/$offerId"
                      params={{ tenant, practiceId: p.id, offerId: o.id }}
                      className={cx(styles.offerLink, o.id === offerId && styles.current)}
                      aria-current={o.id === offerId ? 'page' : undefined}
                    >
                      <span className={cx(styles.dot, styles[o.status])} aria-hidden="true" />
                      <span className={styles.grow}>{o.name}</span> <span className="sr-only">{o.status_label}</span>
                    </Link>
                  </li>
                ))}
              {canManage && (
                <li>
                  <button type="button" className={styles.addOffer} onClick={() => onAddOffer(p.id)} aria-label={`Add offer to ${p.name}`}>
                    Add offer
                  </button>
                </li>
              )}
            </ul>
          </li>
        ))}
      </ul>
      <ul className={styles.legend} aria-hidden="true">
        {(['approved', 'draft', 'archived'] as const).map((s) => (
          <li key={s}>
            <span className={cx(styles.dot, styles[s])} />
            {LEGEND[s]}
          </li>
        ))}
      </ul>
    </nav>
  );
}
