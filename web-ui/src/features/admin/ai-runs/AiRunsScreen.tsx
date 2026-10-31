import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useId } from 'react';
import { cx } from '../../../lib/cx';
import { useFormat } from '../../../lib/useFormat';
import { useSearchText } from '../../../lib/useSearchText';
import type { AiRunsSearch } from '../../../routes/admin';
import page from '../../../routes/Page.module.css';
import { Button } from '../../../ui/Button';
import { EmptyState } from '../../../ui/EmptyState';
import { Field } from '../../../ui/Field';
import table from '../../../ui/Table.module.css';
import { LoadFailed, LoadingRows } from '../../settings/shared';
import styles from '../Admin.module.css';
import { tenantsQuery } from '../tenants/api';
import { runsQuery, STATUSES, taskLabel, type RunFilters, type RunsSummary, type RunStatus } from './api';
import { RunRow } from './RunRow';

/** The failed share the Failed tile aims under, in percent. */
const FAILED_TARGET_PCT = 3;

const route = getRouteApi('/admin/ai-runs');

/**
 * §23 AI runs: every tenant's runs, with today's tiles, search, filters and an expandable row. The
 * search, filters and the expanded run live in the URL (C10).
 */
export function AiRunsScreen() {
  const searchId = useId();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  // Typing replaces the history entry; a filter or an expanded row adds one, so Back undoes it.
  const update = (patch: AiRunsSearch, replace = false) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  const setStatus = (status: RunStatus | '') => update({ status: status || undefined });
  const open = search.open ?? null;
  const filters: RunFilters = { q: search.q ?? '', status: search.status ?? '', task: search.task ?? '', tenant: search.tenant ?? '' };
  const { status, task, tenant } = filters;
  const [text, setText] = useSearchText(filters.q, (q) => update({ q: q || undefined }, true));
  const runs = useInfiniteQuery(runsQuery(filters));
  const tenants = useQuery(tenantsQuery());
  const rows = runs.data?.pages.flatMap((p) => p.data) ?? [];
  const summary = runs.data?.pages[0]?.summary;
  // The API lists no tasks, so the Task filter offers the tasks of the runs shown.
  const tasks = [...new Set([...rows.map((r) => r.task), ...(task ? [task] : [])])].sort();

  return (
    <div className={page.page}>
      <div>
        <h1 className={page.title}>AI runs</h1>
        <p className={page.sub}>Every call Scout makes to the model: briefs, scores, fact checks and email drafts.</p>
      </div>
      {summary && <Tiles summary={summary} />}
      {summary && summary.failed_last_hour > 0 && (
        <div className={styles.banner}>
          <span className={styles.grow}>{summary.failed_last_hour} failed in the last hour</span>
          <Button size="sm" variant="secondary" onClick={() => setStatus('failed')}>
            Show them
          </Button>
        </div>
      )}
      <div className={styles.toolbar}>
        <label htmlFor={searchId} className="sr-only">
          Find by run, account or task
        </label>
        <input
          id={searchId}
          type="search"
          className={`input ${styles.search}`}
          placeholder="Find by run, account or task"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Field label="Status">
          {(c) => (
            <select {...c} className="input" value={status} onChange={(e) => setStatus(e.target.value as RunStatus | '')}>
              <option value="">Every status</option>
              {STATUSES.map((s) => (
                <option key={s.status} value={s.status}>
                  {s.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Task">
          {(c) => (
            <select {...c} className="input" value={task} onChange={(e) => update({ task: e.target.value || undefined })}>
              <option value="">Every task</option>
              {tasks.map((t) => (
                <option key={t} value={t}>
                  {taskLabel(t)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Tenant">
          {(c) => (
            <select {...c} className="input" value={tenant} onChange={(e) => update({ tenant: e.target.value || undefined })}>
              <option value="">Every tenant</option>
              {(tenants.data?.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {runs.isPending ? (
        <LoadingRows>Loading AI runs</LoadingRows>
      ) : runs.isError ? (
        <LoadFailed title="AI runs didn't load" error={runs.error} onRetry={() => void runs.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No runs match">Try other words, or another status, task or tenant.</EmptyState>
      ) : (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Status</th>
                <th scope="col">Task and account</th>
                <th scope="col">Tenant and model</th>
                <th scope="col" className={table.num}>
                  Tokens
                </th>
                <th scope="col" className={table.num}>
                  Cost
                </th>
                <th scope="col" className={table.num}>
                  Time
                </th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <RunRow key={r.id} run={r} expanded={open === r.id} onToggle={() => update({ open: open === r.id ? undefined : r.id })} />
              ))}
            </tbody>
          </table>
          <div className={table.foot}>
            <span>Showing {rows.length} runs, newest first</span>
            {runs.hasNextPage && (
              <Button size="sm" variant="secondary" disabled={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>
                Show more
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Tiles({ summary: s }: { summary: RunsSummary }) {
  const f = useFormat();
  return (
    <div className={styles.tiles}>
      <div className={styles.tile}>
        <div className={styles.tileLabel}>Runs today</div>
        <div className={styles.tileValue}>{f.number(s.runs_today)}</div>
        <div className={styles.tileNote}>All tenants</div>
      </div>
      <div className={styles.tile}>
        <div className={styles.tileLabel}>Failed</div>
        <div className={cx(styles.tileValue, s.failed_pct !== null && s.failed_pct >= FAILED_TARGET_PCT && styles.bad)}>
          {s.failed_pct === null ? 'None' : f.percent(s.failed_pct / 100)}
        </div>
        <div className={styles.tileNote}>Target under 3%</div>
      </div>
      <div className={styles.tile}>
        <div className={styles.tileLabel}>Median time</div>
        <div className={styles.tileValue}>{s.median_ms === null ? 'None' : f.duration(s.median_ms)}</div>
        <div className={styles.tileNote}>{s.slowest_task ? `Slowest task: ${taskLabel(s.slowest_task)}` : 'No runs today'}</div>
      </div>
      <div className={styles.tile}>
        <div className={styles.tileLabel}>Spend today</div>
        <div className={styles.tileValue}>{f.money(s.spend_today_cents)}</div>
        <div className={styles.tileNote}>All tenants</div>
      </div>
    </div>
  );
}
