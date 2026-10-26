import Link from 'next/link';
import { TenantShell } from '@/components/shell';
import { Card, CardHeader, EmptyState, Notice, PageHeader, Table, Td, Th, buttonClass } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { listAudit } from '@/platform/audit';
import { withTenant } from '@/platform/db/tenant';
import { ScoutError } from '@/platform/errors';
import { pageContext } from '@/server/page-context';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Audit' };

type Search = { person?: string; key?: string; source?: string; subject?: string; from?: string; to?: string; cursor?: string };

function dateOrUndefined(v: string | undefined, endOfDay = false): Date | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const summary = (v: unknown): string => (v == null ? '' : JSON.stringify(v));

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<Search>;
}) {
  const slug = (await params).tenant;
  const ctx = await pageContext(slug);
  if (!ctx.can('audit:read')) {
    return (
      <TenantShell ctx={ctx} current="audit">
        <PageHeader title="Audit" />
        <Notice tone="bad">You don&apos;t have access to that.</Notice>
      </TenantShell>
    );
  }
  const q = await searchParams;
  const { principal } = ctx;
  let badCursor = false;
  const result = await withTenant(principal.tenantId, async (tx) => {
    const c = { tenantId: principal.tenantId, tx };
    try {
      return await listAudit(c, {
        actorId: q.person?.trim() || undefined,
        apiKeyId: q.key?.trim() || undefined,
        sourceId: q.source?.trim() || undefined,
        subjectId: q.subject?.trim() || undefined,
        from: dateOrUndefined(q.from),
        to: dateOrUndefined(q.to, true),
        cursor: q.cursor || undefined,
        limit: 50,
      });
    } catch (e) {
      if (e instanceof ScoutError && e.slug === 'invalid-cursor') {
        badCursor = true;
        return { rows: [], nextCursor: null };
      }
      throw e;
    }
  });
  const base = `/t/${slug}/settings/audit`;
  const keep = new URLSearchParams();
  for (const k of ['person', 'key', 'source', 'subject', 'from', 'to'] as const) if (q[k]) keep.set(k, q[k]!);
  const olderHref = result.nextCursor ? `${base}?${new URLSearchParams({ ...Object.fromEntries(keep), cursor: result.nextCursor })}` : null;

  return (
    <TenantShell ctx={ctx} current="audit">
      <PageHeader title="Audit" description="Who changed what, newest first." />
      <Card>
        <CardHeader title="Changes" />
        <form method="get" action={base} className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <label className="block">
            <span className="label">Person</span>
            <input name="person" defaultValue={q.person ?? ''} placeholder="Person id" className="input" />
          </label>
          <label className="block">
            <span className="label">Key</span>
            <input name="key" defaultValue={q.key ?? ''} placeholder="Key id" className="input" />
          </label>
          <label className="block">
            <span className="label">Source</span>
            <input name="source" defaultValue={q.source ?? ''} placeholder="Source id" className="input" />
          </label>
          <label className="block">
            <span className="label">Subject</span>
            <input name="subject" defaultValue={q.subject ?? ''} placeholder="Id of the thing changed" className="input" />
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
        {badCursor && (
          <div className="p-4">
            <Notice tone="near">That page link is no longer valid. Showing nothing; clear the filters to start again.</Notice>
          </div>
        )}
        {result.rows.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No changes found">Try clearing the filters.</EmptyState>
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>What happened</Th>
                <Th>Who</Th>
                <Th>Subject</Th>
                <Th>Details</Th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.id} data-testid={`audit-${r.id}`}>
                  <Td className="whitespace-nowrap text-xs">{formatDateTime(r.at)}</Td>
                  <Td className="font-mono text-xs">{r.action}</Td>
                  <Td className="text-xs">
                    <span className="font-mono">{r.actorId}</span>
                    {r.apiKeyId && <div className="text-ink-muted">via key {r.apiKeyId}</div>}
                    {r.sourceId && <div className="text-ink-muted">via source {r.sourceId}</div>}
                  </Td>
                  <Td className="font-mono text-xs">{r.subjectType ? `${r.subjectType} ${r.subjectId ?? ''}` : ''}</Td>
                  <Td className="max-w-sm break-words font-mono text-2xs text-ink-soft">{summary(r.after ?? r.before)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {olderHref && (
          <div className="border-t border-line p-3">
            <Link href={olderHref} className={buttonClass('secondary', 'sm')}>
              Older changes
            </Link>
          </div>
        )}
      </Card>
    </TenantShell>
  );
}
