import Link from 'next/link';
import { TenantShell } from '@/components/shell';
import { Badge, Card, CardHeader, EmptyState, Notice, PageHeader, Table, Td, Th, buttonClass, type Tone } from '@/components/ui';
import { formatCents, formatDateTime, formatDuration } from '@/lib/format';
import { redactPersonalText } from '@/lib/redact-text';
import {
  AI_LABEL,
  getRun,
  listRuns,
  runTotalsThisMonth,
  type AiMode,
  type AiRunRow,
  type AiStatus,
} from '@/modules/ai-tasks';
import { withTenant } from '@/platform/db/tenant';
import { newId } from '@/platform/ids';
import { pageContext } from '@/server/page-context';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'AI runs' };

const STATUS: Record<AiStatus, { tone: Tone; text: string }> = {
  ok: { tone: 'good', text: 'Worked' },
  invalid_output: { tone: 'bad', text: 'Answer rejected' },
  error: { tone: 'bad', text: 'Failed' },
  refused_by_cap: { tone: 'near', text: 'Stopped by limit' },
};
const MODES: AiMode[] = ['live', 'rules', 'mock'];

type Search = { task?: string; status?: string; mode?: string; from?: string; to?: string; run?: string };

const pick = <T extends string>(v: string | undefined, allowed: readonly T[]): T | undefined =>
  allowed.includes(v as T) ? (v as T) : undefined;

function dateOrUndefined(v: string | undefined, endOfDay = false): Date | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function Detail({ run, closeHref }: { run: AiRunRow; closeHref: string }) {
  const input = redactPersonalText(JSON.stringify(run.inputRef ?? {}, null, 2));
  const output = run.output == null ? '' : JSON.stringify(run.output, null, 2);
  const label = AI_LABEL[run.mode as AiMode] ?? run.mode;
  return (
    <aside
      aria-label="Run detail"
      data-testid="run-detail"
      className="fixed inset-y-0 right-0 z-30 w-full max-w-xl overflow-y-auto border-l border-line bg-surface p-5 shadow-pop"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{run.task}</h2>
          <div className="mt-0.5 font-mono text-2xs text-ink-muted">{run.id}</div>
        </div>
        <Link href={closeHref} className={buttonClass('secondary', 'sm')}>
          Close
        </Link>
      </div>
      <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div>
          <dt className="text-xs text-ink-muted">Written by</dt>
          <dd>{label}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Result</dt>
          <dd>{STATUS[run.status as AiStatus]?.text ?? run.status}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Prompt version</dt>
          <dd className="font-mono text-xs">{run.promptVersion}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Model</dt>
          <dd className="font-mono text-xs">{run.model ?? 'None (rules)'}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Duration</dt>
          <dd className="tnum">{formatDuration(run.durationMs)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Cost</dt>
          <dd className="tnum">{formatCents(run.costCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Words in and out</dt>
          <dd className="tnum">
            {run.inputTokens.toLocaleString('en-US')} in, {run.outputTokens.toLocaleString('en-US')} out
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">When</dt>
          <dd>{formatDateTime(run.createdAt)}</dd>
        </div>
      </dl>
      {run.error && (
        <div className="mb-4">
          <Notice tone="bad" title="What went wrong">
            {redactPersonalText(run.error)}
          </Notice>
        </div>
      )}
      <h3 className="mb-1 text-xs font-medium text-ink-muted">Input (emails and phone numbers hidden)</h3>
      <pre className="mb-4 max-h-60 overflow-auto rounded border border-line bg-sunken p-3 font-mono text-xs" data-testid="run-input">
        {input}
      </pre>
      <div className="mb-1 text-2xs text-ink-muted">
        Fingerprint <span className="font-mono">{run.inputHash.slice(0, 16)}</span>
      </div>
      <h3 className="mb-1 mt-4 text-xs font-medium text-ink-muted">Output</h3>
      <pre className="max-h-72 overflow-auto rounded border border-line bg-sunken p-3 font-mono text-xs" data-testid="run-output">
        {output || 'No output.'}
      </pre>
    </aside>
  );
}

export default async function AiRunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<Search>;
}) {
  const slug = (await params).tenant;
  const ctx = await pageContext(slug);
  if (!ctx.can('settings:manage')) {
    return (
      <TenantShell ctx={ctx} current="ai">
        <PageHeader title="AI runs" />
        <Notice tone="bad">You don&apos;t have access to that.</Notice>
      </TenantShell>
    );
  }
  const q = await searchParams;
  const status = pick(q.status, Object.keys(STATUS) as AiStatus[]);
  const mode = pick(q.mode, MODES);
  const task = q.task?.trim() || undefined;
  const { principal } = ctx;
  const { runs, totals, detail } = await withTenant(principal.tenantId, async (tx) => {
    const c = { tenantId: principal.tenantId, actor: { kind: 'user' as const, id: principal.id }, correlationId: newId('cor'), tx };
    return {
      runs: await listRuns(c, { task, status, mode, from: dateOrUndefined(q.from), to: dateOrUndefined(q.to, true), limit: 200 }),
      totals: await runTotalsThisMonth(c),
      detail: q.run ? await getRun(c, q.run) : undefined,
    };
  });

  const keep = new URLSearchParams();
  for (const k of ['task', 'status', 'mode', 'from', 'to'] as const) if (q[k]) keep.set(k, q[k]!);
  const base = `/t/${slug}/settings/ai`;
  const href = (extra?: Record<string, string>) => {
    const p = new URLSearchParams(keep);
    for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };
  const taskNames = [...new Set([...totals.map((t) => t.task), ...(task ? [task] : [])])].sort();

  return (
    <TenantShell ctx={ctx} current="ai">
      <PageHeader title="AI runs" description="Every time Scout asked Claude, or assembled an answer from rules, with what it cost." />

      <Card className="mb-6">
        <CardHeader title="This month" description="Runs and cost per task since the start of the month (UTC)." />
        {totals.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No runs this month">Runs show up here as soon as a task runs.</EmptyState>
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Task</Th>
                <Th numeric>Runs</Th>
                <Th numeric>Words in</Th>
                <Th numeric>Words out</Th>
                <Th numeric>Cost</Th>
              </tr>
            </thead>
            <tbody>
              {totals.map((t) => (
                <tr key={t.task}>
                  <Td className="font-mono text-xs">{t.task}</Td>
                  <Td numeric>{t.runs.toLocaleString('en-US')}</Td>
                  <Td numeric>{t.inputTokens.toLocaleString('en-US')}</Td>
                  <Td numeric>{t.outputTokens.toLocaleString('en-US')}</Td>
                  <Td numeric>{formatCents(t.costCents)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Runs" description="Newest first. Choose a run to see what went in and what came out." />
        <form method="get" action={base} className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <label className="block">
            <span className="label">Task</span>
            <select name="task" defaultValue={task ?? ''} className="input">
              <option value="">All tasks</option>
              {taskNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Result</span>
            <select name="status" defaultValue={status ?? ''} className="input">
              <option value="">Any result</option>
              {(Object.keys(STATUS) as AiStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS[s].text}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Written by</span>
            <select name="mode" defaultValue={mode ?? ''} className="input">
              <option value="">Anyone</option>
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {AI_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">From</span>
            <input type="date" name="from" defaultValue={q.from ?? ''} className="input" />
          </label>
          <label className="block">
            <span className="label">To</span>
            <input type="date" name="to" defaultValue={q.to ?? ''} className="input" />
          </label>
          <button type="submit" className={buttonClass('primary')}>
            Apply filters
          </button>
          <Link href={base} className={buttonClass('ghost')}>
            Clear
          </Link>
        </form>
        {runs.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No runs match">Try clearing the filters.</EmptyState>
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Task</Th>
                <Th>Written by</Th>
                <Th>Result</Th>
                <Th numeric>Duration</Th>
                <Th numeric>Cost</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const s = STATUS[r.status as AiStatus] ?? { tone: 'neutral' as Tone, text: r.status };
                return (
                  <tr key={r.id} data-testid={`run-${r.id}`}>
                    <Td className="whitespace-nowrap text-xs">{formatDateTime(r.createdAt)}</Td>
                    <Td className="font-mono text-xs">{r.task}</Td>
                    <Td>{AI_LABEL[r.mode as AiMode] ?? r.mode}</Td>
                    <Td>
                      <Badge tone={s.tone}>{s.text}</Badge>
                    </Td>
                    <Td numeric>{formatDuration(r.durationMs)}</Td>
                    <Td numeric>{formatCents(r.costCents)}</Td>
                    <Td>
                      <Link href={href({ run: r.id })} className="link text-xs">
                        View
                      </Link>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {detail && <Detail run={detail} closeHref={href()} />}
    </TenantShell>
  );
}
