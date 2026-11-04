import { Button } from '../../ui/Button';
import type { Offer } from './api';
import styles from './Offers.module.css';

type Props = {
  offer: Pick<Offer, 'talking_points' | 'objections' | 'proof_points' | 'avoid'>;
  /** Shows `Write one` when the guide is empty; the caller opens the form at the guide. */
  onWrite?: () => void;
};

/** §19 "Seller guide", read-only. The offer page and the account page both show it. */
export function SellerGuide({ offer, onWrite }: Props) {
  const empty = !offer.talking_points.length && !offer.objections.length && !offer.proof_points.length && !offer.avoid.length;
  const list = (title: string, items: string[]) =>
    items.length > 0 && (
      <div className={styles.guideBlock}>
        <h4 className={styles.guideTitle}>{title}</h4>
        <ul className={styles.bullets}>
          {items.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <section className={styles.section} aria-label="Seller guide">
      <h3 className={styles.sectionTitle}>Seller guide</h3>
      <p className={styles.note}>What to say, what to expect, what to avoid. Shown to the AE on every account matched to this offer.</p>
      {empty ? (
        <p className={styles.note}>
          No seller guide yet.{' '}
          {onWrite && (
            <Button size="sm" variant="secondary" onClick={onWrite}>
              Write one
            </Button>
          )}
        </p>
      ) : (
        <>
          {offer.talking_points.length > 0 && (
            <div className={styles.guideBlock}>
              <h4 className={styles.guideTitle}>Talking points</h4>
              <ol className={styles.bullets}>
                {offer.talking_points.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ol>
            </div>
          )}
          {offer.objections.length > 0 && (
            <div className={styles.guideBlock}>
              <h4 className={styles.guideTitle}>When they say</h4>
              <ul className={styles.objections}>
                {offer.objections.map((o, i) => (
                  <li key={i}>
                    <p className={styles.quote}>&ldquo;{o.objection}&rdquo;</p>
                    <p>{o.answer}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {list('Proof points', offer.proof_points)}
          {list('Avoid', offer.avoid)}
        </>
      )}
    </section>
  );
}
