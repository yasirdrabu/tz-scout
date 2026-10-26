import Link from "next/link";
import { getCompanyContext } from "@/server/context";
import { listOfferings } from "@/server/offerings";
import { Badge, Card, EmptyState, LinkButton, PageHeader, Table, Tabs, Td, Th } from "@/components/ui";
import { money, rangeMoney } from "@/lib/format";
import { STATUS_LABEL, STATUS_TONE } from "./labels";
import { ActionButton } from "@/components/client";
import { BAND_LABEL, type Readiness } from "@/lib/offerReadiness";
import { BAND_TONE } from "./[id]/readiness";
import { scoreAllOffersAction } from "./actions";

export const metadata = { title: "Offerings" };


export default async function OfferingsPage({ params, searchParams }: { params: Promise<{ company: string }>; searchParams: Promise<{ archived?: string }> }) {
  const { company: slug } = await params;
  const sp = await searchParams;
  const ctx = await getCompanyContext(slug);
  const showArchived = sp.archived === "1";
  const offerings = await listOfferings(ctx.db, { includeArchived: showArchived });
  const caseCount = await ctx.db.caseStudy.count();
  const cur = ctx.company.currency;
  const bucketName = new Map((await ctx.db.bucket.findMany({ select: { id: true, name: true } })).map((b) => [b.id, b.name]));

  return (
    <>
      <PageHeader
        title="Offerings"
        description="What we sell, who buys it, and the proof behind it. Approve an offering before segments, tests or funnel models use it."
        actions={
          ctx.can("offering.edit") && (
            <div className="flex gap-2">
              <ActionButton action={scoreAllOffersAction.bind(null, slug)} pendingText="Scoring...">
                Score readiness
              </ActionButton>
              <LinkButton href={`/c/${slug}/offerings/new`} variant="primary">
                New offering
              </LinkButton>
            </div>
          )
        }
      />
      <Tabs
        current="offerings"
        items={[
          { key: "offerings", label: "Offerings", href: `/c/${slug}/offerings`, count: offerings.length },
          { key: "cases", label: "Case studies", href: `/c/${slug}/offerings/case-studies`, count: caseCount },
        ]}
      />
      {offerings.length === 0 ? (
        <EmptyState title="No offerings yet" action={ctx.can("offering.edit") && <LinkButton href={`/c/${slug}/offerings/new`} variant="primary">New offering</LinkButton>}>
          Start from a web page, deck or case study and let Claude draft the fields, or fill them in by hand.
        </EmptyState>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Offering</Th>
                <Th>Bucket</Th>
                <Th>Status</Th>
                <Th>Readiness</Th>
                <Th numeric>Price</Th>
                <Th numeric>Typical deal</Th>
                <Th numeric>Margin</Th>
                <Th numeric>Sales cycle</Th>
                <Th numeric>Case studies</Th>
                <Th numeric>Segments</Th>
                <Th numeric>Leads</Th>
              </tr>
            </thead>
            <tbody>
              {offerings.map((o) => (
                <tr key={o.id} className="hover:bg-sunken/50">
                  <Td className="max-w-md">
                    <Link href={`/c/${slug}/offerings/${o.id}`} className="font-medium text-ink hover:text-accent">
                      {o.name}
                    </Link>
                    <div className="mt-0.5 line-clamp-2 text-xs text-ink-muted">{o.promise || "No promise yet"}</div>
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-ink-soft">{o.bucketId ? bucketName.get(o.bucketId) : <span className="text-ink-faint">None</span>}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge>
                  </Td>
                  <Td>
                    {(() => {
                      const r = o.readiness as Readiness | null;
                      return r ? (
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                          <span className="tnum font-medium text-ink">{r.score}</span>
                          <Badge tone={BAND_TONE[r.band]}>{BAND_LABEL[r.band]}</Badge>
                        </span>
                      ) : (
                        <span className="text-xs text-ink-faint">Not scored</span>
                      );
                    })()}
                  </Td>
                  <Td numeric>{rangeMoney(o.priceMinCents, o.priceMaxCents, cur)}</Td>
                  <Td numeric>{money(o.dealSizeCents, cur, { compact: true })}</Td>
                  <Td numeric>{o.grossMargin != null ? `${Math.round(o.grossMargin * 100)}%` : "n/a"}</Td>
                  <Td numeric>{o.salesCycleDays != null ? `${o.salesCycleDays} days` : "n/a"}</Td>
                  <Td numeric>{o._count.caseStudies}</Td>
                  <Td numeric>
                    {o._count.segments > 0 ? (
                      <Link className="link" href={`/c/${slug}/segments?offering=${o.id}`}>
                        {o._count.segments}
                      </Link>
                    ) : (
                      0
                    )}
                  </Td>
                  <Td numeric>{o._count.leads}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <div className="mt-3 text-xs">
        <Link className="link" href={showArchived ? `/c/${slug}/offerings` : `/c/${slug}/offerings?archived=1`}>
          {showArchived ? "Hide archived" : "Show archived"}
        </Link>
      </div>
    </>
  );
}
