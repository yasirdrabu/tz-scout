import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/context";
import { exportWinners, library } from "@/server/tests";
import { Card, CardHeader, EmptyState, LinkButton, PageHeader, Table, Td, Th, buttonClass } from "@/components/ui";
import { money, num, pct } from "@/lib/format";
import { KIND_LABEL } from "../labels";
import { CopyButton } from "./copy-button";
import { SegmentFilter } from "./segment-filter";

export const metadata = { title: "Statement library" };

type Winner = Awaited<ReturnType<typeof library>>[number];

export default async function LibraryPage({ params, searchParams }: { params: Promise<{ company: string }>; searchParams: Promise<{ segment?: string }> }) {
  const { company: slug } = await params;
  const sp = await searchParams;
  const ctx = await getCompanyContext(slug);
  const cur = ctx.company.currency;
  const all = await library(ctx.db);
  if (sp.segment && !(await ctx.db.segment.findUnique({ where: { id: sp.segment }, select: { id: true } }))) notFound();
  const rows = sp.segment ? all.filter((r) => r.segmentId === sp.segment) : all;

  // Offering, then segment, in a stable order.
  const byOffering = new Map<string, { offering: string; segments: Map<string, Winner[]> }>();
  for (const r of rows) {
    const o = byOffering.get(r.segment.offeringId) ?? { offering: r.segment.offering.name, segments: new Map<string, Winner[]>() };
    o.segments.set(r.segmentId, [...(o.segments.get(r.segmentId) ?? []), r]);
    byOffering.set(r.segment.offeringId, o);
  }
  const offerings = [...byOffering.values()].sort((a, b) => a.offering.localeCompare(b.offering));

  const filterGroups = new Map<string, { offering: string; segments: Map<string, { id: string; buyer: string; count: number }> }>();
  for (const r of all) {
    const g = filterGroups.get(r.segment.offeringId) ?? { offering: r.segment.offering.name, segments: new Map() };
    const s = g.segments.get(r.segmentId) ?? { id: r.segmentId, buyer: r.segment.buyer, count: 0 };
    s.count++;
    g.segments.set(r.segmentId, s);
    filterGroups.set(r.segment.offeringId, g);
  }

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/c/${slug}/tests`} className="hover:text-ink">
            Message tests
          </Link>
        }
        title="Statement library"
        description="Every statement kept after a test, across all batches, by segment. Export them as ad copy, landing page headlines or discovery call questions."
        actions={<LinkButton href={`/c/${slug}/tests`}>All test batches</LinkButton>}
      />
      {all.length === 0 ? (
        <EmptyState title="No winners yet" action={<LinkButton href={`/c/${slug}/tests`}>Go to message tests</LinkButton>}>
          When a test finishes, keep the statements that worked. They collect here for each segment.
        </EmptyState>
      ) : (
        <>
          <div className="mb-5">
            <SegmentFilter
              slug={slug}
              current={sp.segment ?? ""}
              groups={[...filterGroups.values()].sort((a, b) => a.offering.localeCompare(b.offering)).map((g) => ({ offering: g.offering, segments: [...g.segments.values()] }))}
            />
          </div>
          {rows.length === 0 && <p className="py-8 text-center text-sm text-ink-muted">No winners for this segment yet.</p>}
          <div className="space-y-8">
            {offerings.map((o) => (
              <section key={o.offering}>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">{o.offering}</h2>
                <div className="space-y-5">
                  {[...o.segments.entries()].map(([segmentId, winners]) => {
                    const seg = winners[0]!.segment;
                    const ex = exportWinners(winners);
                    const exportHref = `/c/${slug}/tests/library/export?segment=${segmentId}`;
                    return (
                      <Card key={segmentId}>
                        <CardHeader
                          title={
                            <Link href={`/c/${slug}/segments/${segmentId}`} className="hover:text-accent">
                              {seg.buyer}
                            </Link>
                          }
                          description={`${winners.length} ${winners.length === 1 ? "winner" : "winners"}. ${seg.problem}`}
                          actions={
                            <>
                              <a href={exportHref} className={buttonClass("secondary", "sm")} download>
                                Download text
                              </a>
                              <a href={`${exportHref}&format=csv`} className={buttonClass("ghost", "sm")} download>
                                Download spreadsheet
                              </a>
                            </>
                          }
                        />
                        <Table>
                          <thead>
                            <tr>
                              <Th>Kind</Th>
                              <Th>Statement</Th>
                              <Th numeric>Impressions</Th>
                              <Th numeric>Clickthrough rate</Th>
                              <Th numeric>Cost per click</Th>
                              <Th>From</Th>
                            </tr>
                          </thead>
                          <tbody>
                            {winners.map((w) => (
                              <tr key={w.id}>
                                <Td className="whitespace-nowrap text-ink-soft">{KIND_LABEL[w.kind]}</Td>
                                <Td className="min-w-[280px]">{w.text}</Td>
                                <Td numeric>{w.result ? num(w.result.impressions) : "n/a"}</Td>
                                <Td numeric>{pct(w.verdict.ctr, 2)}</Td>
                                <Td numeric>{money(w.verdict.cpcCents, cur, { precise: true })}</Td>
                                <Td className="whitespace-nowrap">
                                  <Link className="link" href={`/c/${slug}/tests/${w.batchId}`}>
                                    {w.batch.name}
                                  </Link>
                                </Td>
                              </tr>
                            ))}
                          </tbody>
                        </Table>
                        <div className="grid gap-px border-t border-line bg-line md:grid-cols-3">
                          <ExportBlock title="Ad copy" items={ex.adCopy} empty="No winners." />
                          <ExportBlock title="Landing page headlines" items={ex.headlines} empty="Keep an outcome statement to get headlines." />
                          <ExportBlock title="Discovery call questions" items={ex.discoveryQuestions} empty="Keep a problem statement to get questions." />
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function ExportBlock({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div className="bg-surface p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-ink">{title}</h3>
        <CopyButton text={items.join("\n")} label={`Copy ${items.length}`} />
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-ink-muted">{empty}</p>
      ) : (
        <ul className="space-y-1.5 text-xs text-ink-soft">
          {items.map((t, i) => (
            <li key={i} className="border-l-2 border-line pl-2">
              {t}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
