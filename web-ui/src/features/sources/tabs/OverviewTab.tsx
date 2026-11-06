import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import { useFormat } from '../../../lib/useFormat';
import { errorText } from '../../settings/shared';
import { childTab, feedbackQuery, sourcesQuery, type SourceDetail, type SourceStat } from '../api';
import styles from '../Sources.module.css';

type Props = { tenant: string; source: SourceDetail; stat: SourceStat | undefined };

/** A strip of bars, one per month of `trust_trend` (0 to 100), oldest first. */
function TrendStrip({ trend }: { trend: SourceDetail['trust_trend'] }) {
  const w = 10;
  const gap = 4;
  const h = 32;
  return (
    <svg className={styles.trend} viewBox={`0 0 ${trend.length * (w + gap) - gap} ${h}`} role="img" aria-label={`Trust by month: ${trend.map((t) => `${t.month} ${t.trust}`).join(', ')}`}>
      {trend.map((t, i) => {
        const bar = Math.max(2, (Math.max(0, Math.min(100, t.trust)) / 100) * h);
        return <rect key={t.month} x={i * (w + gap)} y={h - bar} width={w} height={bar} rx={2} className={styles.trendBar} />;
      })}
    </svg>
  );
}

/** Where its accounts went (the API's stages and counts), the Trust card, what was sent back or declined, and the details. */
export function OverviewTab({ tenant, source: s, stat }: Props) {
  const f = useFormat();
  const wentId = useId();
  const recentId = useId();
  const trustId = useId();
  const feedback = useQuery(feedbackQuery(tenant, s.id));
  const all = useQuery(sourcesQuery(tenant));
  const children = (all.data?.data ?? []).filter((c) => c.parent_id === s.id);
  const most = Math.max(1, ...(stat?.by_stage.map((b) => b.count) ?? [0]));

  return (
    <div className={styles.grid}>
      <div className={styles.section}>
        <section className={styles.panel} aria-labelledby={wentId}>
          <h2 id={wentId} className={styles.panelTitle}>
            Where its accounts went
          </h2>
          {stat ? (
            <ul className={styles.bars}>
              {stat.by_stage.map((b) => (
                <li key={b.key} className={styles.bar}>
                  <span>{b.label}</span>
                  <span className={styles.track} aria-hidden="true">
                    <span className={styles.fill} style={{ display: 'block', width: `${(b.count / most) * 100}%` }} />
                  </span>
                  <span className={styles.count}>{f.number(b.count)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.note}>Loading the numbers</p>
          )}
        </section>
        <section className={styles.panel} aria-labelledby={trustId}>
          <h2 id={trustId} className={styles.panelTitle}>
            Trust
          </h2>
          <span className={styles.note}>Updated nightly</span>
          <span className={styles.statValue}>{s.trust_label ?? s.trust}</span>
          <span className={styles.note}>{`Based on ${f.number(s.trust_sample)} ${s.trust_sample === 1 ? 'account' : 'accounts'}`}</span>
          {s.trust_trend.length > 0 ? <TrendStrip trend={s.trust_trend} /> : <p className={styles.note}>No history yet.</p>}
        </section>
        <section className={styles.panel} aria-labelledby={recentId}>
          <h2 id={recentId} className={styles.panelTitle}>
            Recent activity
          </h2>
          {feedback.isPending ? (
            <p className={styles.note}>Loading recent activity</p>
          ) : feedback.isError ? (
            <p className={styles.error}>{errorText(feedback.error)}</p>
          ) : feedback.data.length === 0 ? (
            <p className={styles.note}>Nothing sent back or declined yet.</p>
          ) : (
            <ul className={styles.activity}>
              {feedback.data.map((r) => (
                <li key={r.id}>
                  <div>{r.summary}</div>
                  <div className={styles.sub}>
                    {[
                      r.account_name,
                      f.relative(r.created_at),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section className={styles.panel} aria-label="Details">
        <h2 className={styles.panelTitle}>Details</h2>
        <dl className={styles.facts}>
          <dt>Owner</dt>
          <dd>{s.owner?.name ?? 'No owner'}</dd>
          <dt>How it sends</dt>
          <dd>{s.method_label}</dd>
          <dt>Last sent</dt>
          <dd>{s.last_sent_at ? f.relative(s.last_sent_at) : 'Never'}</dd>
          {s.parent && (
            <>
              <dt>Part of</dt>
              <dd>
                <Link to="/t/$tenant/sources/$id" params={{ tenant, id: s.parent.id }}>
                  {s.parent.name}
                </Link>
              </dd>
            </>
          )}
          {children.length > 0 && (
            <>
              <dt>{childTab(s.kind).label}</dt>
              <dd>
                {children.map((c, i) => (
                  <span key={c.id}>
                    {i > 0 && ', '}
                    <Link to="/t/$tenant/sources/$id" params={{ tenant, id: c.id }}>
                      {c.name}
                    </Link>
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>
      </section>
    </div>
  );
}
