import Link from "next/link";
import { getCompanyContext } from "@/server/context";
import { Badge, Card, EmptyState, LinkButton, PageHeader, Table, Tabs, Td, Th } from "@/components/ui";
import { AutoRefresh } from "@/components/client";
import { date, money, num } from "@/lib/format";
import { BATCH_STATUSES, BATCH_STATUS_LABEL, BATCH_STATUS_TONE, channelLabel, passCount, type BatchStatusKey } from "./labels";

export const metadata = { title: "Message tests" };

const ORDER: Record<BatchStatusKey, number> = { RUNNING: 0, APPROVED: 1, DRAFT: 2, COMPLETE: 3 };

export default async function TestsPage({ params, searchParams }: { params: Promise<{ company: string }>; searchParams: Promise<{ status?: string }> }) {
  const { company: slug } = await params;
  const sp = await searchParams;
  const ctx = await getCompanyContext(slug);
  const cur = ctx.company.currency;
  const status = BATCH_STATUSES.find((s) => s.toLowerCase() === sp.status?.toLowerCase()) ?? null;

  const all = await ctx.db.batch.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      segment: { select: { id: true, buyer: true, offering: { select: { id: true, name: true } } } },
      statements: { select: { result: { select: { impressions: true, clicks: true, spendCents: true } } } },
    },
  });
  const counts = Object.fromEntries(BATCH_STATUSES.map((s) => [s, all.filter((b) => b.status === s).length])) as Record<BatchStatusKey, number>;
  const batches = (status ? all.filter((b) => b.status === status) : all).sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const winners = await ctx.db.statement.count({ where: { inLibrary: true } });
  const canEdit = ctx.can("batch.edit");
  const href = (s: string | null) => (s ? `/c/${slug}/tests?status=${s.toLowerCase()}` : `/c/${slug}/tests`);

  return (
    <>
      <AutoRefresh seconds={4} active={counts.RUNNING > 0} />
      <PageHeader
        title="Message tests"
        description="Each statement runs as its own small ad. The ones that beat both targets go to the library as proven copy."
        actions={
          <>
            <LinkButton href={`/c/${slug}/tests/library`}>Statement library ({winners})</LinkButton>
            {canEdit && (
              <LinkButton href={`/c/${slug}/tests/new`} variant="primary">
                New test batch
              </LinkButton>
            )}
          </>
        }
      />
      <Tabs
        current={status ?? "ALL"}
        items={[{ key: "ALL", label: "All", href: href(null), count: all.length }, ...BATCH_STATUSES.map((s) => ({ key: s, label: BATCH_STATUS_LABEL[s], href: href(s), count: counts[s] }))]}
      />
      {all.length === 0 ? (
        <EmptyState
          title="No test batches yet"
          action={
            canEdit && (
              <LinkButton href={`/c/${slug}/tests/new`} variant="primary">
                New test batch
              </LinkButton>
            )
          }
        >
          Activate a segment, then let Claude write 12 to 15 statements in the buyer&apos;s words to test.
        </EmptyState>
      ) : batches.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-muted">No {status ? BATCH_STATUS_LABEL[status].toLowerCase() : ""} batches.</p>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Batch</Th>
                <Th>Offering</Th>
                <Th>Status</Th>
                <Th>Channel</Th>
                <Th numeric>Budget</Th>
                <Th numeric>Duration</Th>
                <Th numeric>Statements</Th>
                <Th numeric>Passing</Th>
                <Th numeric>Launched</Th>
                <Th numeric>Completed</Th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => {
                const hasResults = b.status === "RUNNING" || b.status === "COMPLETE";
                return (
                  <tr key={b.id} className="hover:bg-sunken/50">
                    <Td className="min-w-[240px] max-w-md">
                      <Link href={`/c/${slug}/tests/${b.id}`} className="font-medium text-ink hover:text-accent">
                        {b.name}
                      </Link>
                      <div className="mt-0.5 line-clamp-1 text-xs text-ink-muted">
                        <Link href={`/c/${slug}/segments/${b.segment.id}`} className="hover:text-ink">
                          {b.segment.buyer}
                        </Link>
                      </div>
                    </Td>
                    <Td className="whitespace-nowrap text-ink-soft">{b.segment.offering.name}</Td>
                    <Td>
                      <Badge tone={BATCH_STATUS_TONE[b.status]}>{BATCH_STATUS_LABEL[b.status]}</Badge>
                    </Td>
                    <Td className="text-ink-soft">{channelLabel(b.channel)}</Td>
                    <Td numeric>{money(b.budgetCents, cur)}</Td>
                    <Td numeric>{num(b.durationHours)} hours</Td>
                    <Td numeric>{b.statements.length}</Td>
                    <Td numeric>{hasResults ? `${passCount(b)} of ${b.statements.length}` : "n/a"}</Td>
                    <Td numeric className="text-ink-soft">{b.launchedAt ? date(b.launchedAt) : ""}</Td>
                    <Td numeric className="text-ink-soft">{b.completedAt ? date(b.completedAt) : ""}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
