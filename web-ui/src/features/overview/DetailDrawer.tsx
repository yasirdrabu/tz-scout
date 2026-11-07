import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useFormat } from '../../lib/useFormat';
import { LoadFailed, LoadingRows } from '../settings/shared';
import { metricQuery, type Selection } from './api';
import styles from './DetailDrawer.module.css';

const BARS = 8;

/** The side panel behind a number on the Overview: what made it up, and a link to the accounts behind it. */
export function DetailDrawer({ tenant, selection, onClose }: { tenant: string; selection: Selection | null; onClose: () => void }) {
  if (!selection) return null;
  return <Panel tenant={tenant} selection={selection} onClose={onClose} />;
}

function Panel({ tenant, selection, onClose }: { tenant: string; selection: Selection; onClose: () => void }) {
  const f = useFormat();
  const q = useQuery(metricQuery(tenant, selection));
  const ref = useRef<HTMLElement>(null);
  const d = q.data;

  useEffect(() => {
    const from = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => from?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside ref={ref} role="dialog" aria-modal="false" aria-labelledby="overview-drawer-title" tabIndex={-1} className={styles.drawer}>
      <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
        ×
      </button>
      {q.isPending ? (
        <>
          <h2 id="overview-drawer-title" className={styles.srOnly}>Loading</h2>
          <LoadingRows>Loading the detail</LoadingRows>
        </>
      ) : q.isError ? (
        <>
          <h2 id="overview-drawer-title" className={styles.srOnly}>Detail</h2>
          <LoadFailed title="The detail didn't load" error={q.error} onRetry={() => void q.refetch()} />
        </>
      ) : (
        <>
          <p className={styles.eyebrow}>{d!.eyebrow}</p>
          <h2 id="overview-drawer-title" className={styles.title}>{d!.title}</h2>
          <p className={styles.value}>{d!.value}</p>
          {d!.change_pct !== null && (
            <p className={`${styles.change} ${d!.change_pct >= 0 ? styles.up : styles.down}`}>
              {`${d!.change_pct >= 0 ? '+' : ''}${d!.change_pct}% vs last quarter at this point`}
            </p>
          )}
          <p className={styles.definition}>{d!.definition}</p>
          {d!.notes.length > 0 && (
            <dl className={styles.notes}>
              {d!.notes.map((n) => (
                <div key={n.label}>
                  <dt>{n.label}</dt>
                  <dd>{n.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {d!.breakdowns.map((b) => {
            const items = b.items.slice(0, BARS);
            const max = Math.max(1, ...items.map((i) => i.count));
            return (
              <section key={b.label} className={styles.section}>
                <h3 className={styles.heading}>{b.label}</h3>
                <ul className={styles.bars}>
                  {items.map((i) => (
                    <li key={i.name}>
                      <span className={styles.barName}>{i.name}</span>
                      <span className={styles.barValue}>{i.value}</span>
                      <span className={styles.barTrack} aria-hidden="true">
                        <span className={styles.barFill} style={{ width: `${(i.count / max) * 100}%` }} />
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {d!.accounts.length > 0 && (
            <section className={styles.section}>
              <h3 className={styles.heading}>Accounts</h3>
              <ul className={styles.accounts}>
                {d!.accounts.map((a) => (
                  <li key={a.account_id}>
                    <Link to="/t/$tenant/accounts/$id" params={{ tenant, id: a.account_id }} search={{ from: 'all' }} className={styles.accountLink}>
                      {a.name}
                    </Link>
                    <span className={styles.meta}>{a.meta}</span>
                    <span className={styles.meta}>{f.date(a.at)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {d!.see_all && (
            <Link to="/t/$tenant/accounts" params={{ tenant }} search={d!.see_all} className={styles.seeAll}>
              {`See all ${f.number(d!.total)}`}
            </Link>
          )}
        </>
      )}
    </aside>
  );
}
