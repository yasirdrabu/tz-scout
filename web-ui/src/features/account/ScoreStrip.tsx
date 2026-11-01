import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../../api/errors';
import { errorText } from '../settings/shared';
import { scoreQuery, type Tile } from './api';
import styles from './Account.module.css';

/** One score tile: the number "/ 100" with a bar, or, with no value yet, the API's note alone. */
export function ScoreTile({ tile }: { tile: Tile }) {
  return (
    <div className={styles.scoreTile}>
      <span className={styles.label}>{tile.label}</span>
      {tile.value !== null ? (
        <>
          <span className={styles.big}>
            {tile.value}
            {tile.max !== null && <small>{` / ${tile.max}`}</small>}
          </span>
          <div className={styles.bar} aria-hidden="true">
            <div className={styles.fill} style={{ width: `${Math.max(0, Math.min(100, tile.max ? (tile.value / tile.max) * 100 : tile.value))}%` }} />
          </div>
          {tile.note && <span className={styles.note}>{tile.note}</span>}
        </>
      ) : (
        <span className={styles.note}>{tile.note}</span>
      )}
    </div>
  );
}

/** §4a 3. Score strip: the five tiles as the scoring model returns them. */
export function ScoreStrip({ tenant, id }: { tenant: string; id: string }) {
  const score = useQuery(scoreQuery(tenant, id));
  return (
    <section className={styles.section} aria-label="Scores">
      {score.isPending ? (
        <p className={styles.note}>Loading scores</p>
      ) : score.isError ? (
        score.error instanceof ApiError && score.error.status === 404 ? (
          <p className={styles.note}>Scout hasn&apos;t scored this account yet. Scores show here once it has.</p>
        ) : (
          <p className={styles.error} role="alert">{`Scores didn't load. ${errorText(score.error)}`}</p>
        )
      ) : (
        <div className={styles.tiles}>
          {score.data.tiles.map((t) => (
            <ScoreTile key={t.key} tile={t} />
          ))}
        </div>
      )}
    </section>
  );
}
