import { useQuery } from '@tanstack/react-query';
import table from '../../ui/Table.module.css';
import { LoadFailed, LoadingRows } from '../settings/shared';
import { CHANNEL_WORD, whatWorkedQuery, type OutcomeKind } from './api';
import styles from './Playbooks.module.css';

const COLUMNS: { kind: OutcomeKind; label: string }[] = [
  { kind: 'reply', label: 'Replies' },
  { kind: 'meeting', label: 'Meetings' },
  { kind: 'opportunity', label: 'Opportunities' },
  { kind: 'won', label: 'Won' },
];

/** §20 What worked: the results each step type was credited with. Needs analytics:read, so the caller decides whether to show it. */
export function WhatWorked({ tenant, templateId }: { tenant: string; templateId: string }) {
  const worked = useQuery(whatWorkedQuery(tenant, templateId));
  const d = worked.data;
  const noRecent = d && COLUMNS.some((c) => d.no_recent_step[c.kind] > 0);

  return (
    <section aria-labelledby="worked-title">
      <h2 id="worked-title" className={styles.sectionTitle}>
        What worked
      </h2>
      <p className={styles.note}>Steps done in the last 90 days and the results they were credited with. A result credits the steps done in the 14 days before it.</p>
      {worked.isError ? (
        <LoadFailed title="What worked didn't load" error={worked.error} onRetry={() => void worked.refetch()} />
      ) : !d ? (
        <LoadingRows>Loading what worked</LoadingRows>
      ) : !d.rows.length && !noRecent ? (
        <p className={styles.note}>No steps done in the last 90 days.</p>
      ) : (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr>
                <th scope="col">Step type</th>
                <th scope="col" className={table.num}>
                  Steps done
                </th>
                {COLUMNS.map((c) => (
                  <th key={c.kind} scope="col" className={table.num}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => {
                const few = r.steps_done < d.min_steps;
                return (
                  <tr key={r.step_type}>
                    <td>{CHANNEL_WORD[r.step_type]}</td>
                    <td className={table.num}>{r.steps_done}</td>
                    {COLUMNS.map((c) => {
                      const per = r.per_10[c.kind];
                      return (
                        <td key={c.kind} className={table.num}>
                          <div>{r.counts[c.kind]}</div>
                          <div className={few ? `${styles.per} ${styles.muted}` : styles.per}>
                            {per === null ? '–' : `${per.toFixed(1)} per 10 steps`}
                            {few && <span className="sr-only"> (too few steps to compare)</span>}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {noRecent && (
                <tr>
                  <td>No recent step</td>
                  <td className={table.num}>
                    <span className={table.muted}>–</span>
                  </td>
                  {COLUMNS.map((c) => (
                    <td key={c.kind} className={table.num}>
                      {d.no_recent_step[c.kind]}
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
