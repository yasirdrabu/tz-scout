import { useQuery } from '@tanstack/react-query';
import { cx } from '../../lib/cx';
import { useFormat } from '../../lib/useFormat';
import type { AccountReview } from '../review/api';
import { stagesQuery } from '../settings/stages/api';
import styles from './Account.module.css';

/**
 * §4 Stage tracker: one step per stage, names and order from the API (C6), each with its date. The
 * step after the current one says "Next", or "Waiting on you" when it is the stage a reviewer sets a tier for and the person reviews.
 */
export function StageTracker({ tenant, review, reviewer }: { tenant: string; review: AccountReview; reviewer: boolean }) {
  const f = useFormat();
  const triggers = new Map((useQuery(stagesQuery(tenant)).data?.stages ?? []).map((s) => [s.key, s.trigger]));
  const stages = review.stages ?? [];
  const current = stages.findIndex((s) => s.current);
  return (
    <ol className={styles.tracker} aria-label="Stages">
      {stages.map((s, i) => {
        const waiting = i === current + 1 && triggers.get(s.key) === 'reviewer_sets_tier' && reviewer;
        const note = s.at ? f.date(s.at) : waiting ? 'Waiting on you' : i === current + 1 ? 'Next' : '';
        return (
          <li key={s.key} className={cx(styles.step, s.at && styles.reached, s.current && styles.current)} {...(s.current ? { 'aria-current': 'step' as const } : {})}>
            <span className={styles.stepName}>{s.label}</span>
            <span className={waiting ? styles.waiting : styles.muted}>{note}</span>
          </li>
        );
      })}
    </ol>
  );
}
