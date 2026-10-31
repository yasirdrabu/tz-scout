import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { Sparkles } from 'lucide-react';
import { useFormat } from '../../../lib/useFormat';
import { EmptyState } from '../../../ui/EmptyState';
import { Field } from '../../../ui/Field';
import table from '../../../ui/Table.module.css';
import { STATUSES, taskLabel, type RunStatus } from '../../admin/ai-runs/api';
import { RunRow } from '../../admin/ai-runs/RunRow';
import type { TabProps } from '../SettingsScreen';
import { LoadFailed, LoadingRows } from '../shared';
import styles from '../Settings.module.css';
import { workspaceRunsQuery, type TaskTotal, type WorkspaceRunFilters } from './api';

const route = getRouteApi('/t/$tenant/settings/$tab');

const asStatus = (s: string | undefined): RunStatus | '' => (STATUSES.some((x) => x.status === s) ? (s as RunStatus) : '');

/**
 * Settings > AI runs: this workspace's runs (as the old Settings, AI page), with Status and Task
 * filters and the expanded run in the URL (C10), and this month's totals per task from the API.
 */
export function AiRunsTab({ tenant, open, setOpen }: TabProps) {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const filters: WorkspaceRunFilters = { status: asStatus(search.status), task: search.task ?? '' };
  const update = (patch: { status?: string; task?: string }) => void navigate({ search: (prev) => ({ ...prev, ...patch }) });
  const runs = useQuery(workspaceRunsQuery(tenant, filters));
  const rows = runs.data?.data ?? [];
  const totals = runs.data?.totals ?? [];
  // The API lists no tasks, so the Task filter offers this month's tasks and those of the runs shown.
  const tasks = [...new Set([...totals.map((t) => t.task), ...rows.map((r) => r.task), ...(filters.task ? [filters.task] : [])])].sort();
  const filtered = !!(filters.status || filters.task);

  return (
    <>
      <p className={styles.intro}>Every call Scout made to the model for this workspace: briefs, scores, fact checks and email drafts.</p>
      <div className={styles.toolbar}>
        <Field label="Status">
          {(c) => (
            <select {...c} className="input" value={filters.status} onChange={(e) => update({ status: e.target.value || undefined })}>
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
            <select {...c} className="input" value={filters.task} onChange={(e) => update({ task: e.target.value || undefined })}>
              <option value="">Every task</option>
              {tasks.map((t) => (
                <option key={t} value={t}>
                  {taskLabel(t)}
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
        filtered ? (
          <EmptyState title="No runs match">Try another status or task.</EmptyState>
        ) : (
          <EmptyState title="No AI runs yet" icon={<Sparkles />}>
            Runs show here once Scout calls the model for this workspace.
          </EmptyState>
        )
      ) : (
        <>
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Status</th>
                  <th scope="col">Task and account</th>
                  <th scope="col">Model</th>
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
                  <RunRow key={r.id} run={r} tenant={tenant} expanded={open === r.id} onToggle={() => setOpen(open === r.id ? undefined : r.id)} />
                ))}
              </tbody>
            </table>
            <div className={table.foot}>
              <span>Showing {rows.length} runs, newest first</span>
            </div>
          </div>
          {totals.length > 0 && <MonthTotals totals={totals} />}
        </>
      )}
    </>
  );
}

function MonthTotals({ totals }: { totals: TaskTotal[] }) {
  const f = useFormat();
  return (
    <section className={styles.section} aria-labelledby="ai-runs-month">
      <h3 id="ai-runs-month" className={styles.sectionTitle}>
        This month
      </h3>
      <div className={table.wrap}>
        <table className={table.table} aria-labelledby="ai-runs-month">
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col" className={table.num}>
                Runs
              </th>
              <th scope="col" className={table.num}>
                Tokens
              </th>
              <th scope="col" className={table.num}>
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {totals.map((t) => (
              <tr key={t.task}>
                <td>{taskLabel(t.task)}</td>
                <td className={table.num}>{f.number(t.runs)}</td>
                <td className={table.num}>
                  {f.compact(t.input_tokens)} in · {f.compact(t.output_tokens)} out
                </td>
                <td className={table.num}>{f.money(t.cost_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
