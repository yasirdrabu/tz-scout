import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/context";
import { getSettings } from "@/server/settings";
import { EmptyState, LinkButton, Notice, PageHeader } from "@/components/ui";
import { ActionButton } from "@/components/client";
import { addManualSegmentAction, generateSegmentsAction } from "./actions";
import { ManualSegmentDialog, OfferingPicker } from "./controls";
import { RankedSegments, type SegmentRow } from "./ranked-segments";

export const metadata = { title: "Segments" };

export default async function SegmentsPage({ params, searchParams }: { params: Promise<{ company: string }>; searchParams: Promise<{ offering?: string; status?: string }> }) {
  const { company: slug } = await params;
  const sp = await searchParams;
  const ctx = await getCompanyContext(slug);
  const settings = await getSettings(ctx.db);
  const approved = await ctx.db.offering.findMany({ where: { status: "APPROVED" }, orderBy: { name: "asc" }, select: { id: true, name: true, _count: { select: { segments: true } } } });
  const requested = sp.offering ? await ctx.db.offering.findUnique({ where: { id: sp.offering }, select: { id: true, name: true, status: true } }) : null;
  if (sp.offering && !requested) notFound();

  const offering = requested ? (requested.status === "APPROVED" ? requested : null) : (approved[0] ?? null);
  const canGenerate = ctx.can("segment.generate");
  const picker = approved.length > 0 && <OfferingPicker slug={slug} current={offering?.id ?? null} offerings={approved.map((o) => ({ id: o.id, name: o.name, segments: o._count.segments }))} />;

  const header = (actions?: React.ReactNode, description?: React.ReactNode) => (
    <PageHeader
      title="Segments"
      description={description ?? "Who to sell each offering to, ranked by how painful the problem is and how well we fit. Activate the best few to start message tests."}
      actions={actions}
    />
  );

  if (approved.length === 0 && !requested) {
    return (
      <>
        {header()}
        <EmptyState title="No approved offerings yet" action={<LinkButton href={`/c/${slug}/offerings`}>Go to offerings</LinkButton>}>
          Segments are generated for approved offerings. Approve an offering first.
        </EmptyState>
      </>
    );
  }

  if (!offering) {
    return (
      <>
        {header()}
        <div className="mb-4">{picker}</div>
        <Notice tone="near" title={`${requested!.name} is not approved yet`}>
          Segments are generated for approved offerings only.{" "}
          <Link className="link" href={`/c/${slug}/offerings/${requested!.id}`}>
            Review and approve the offering
          </Link>
          .
        </Notice>
      </>
    );
  }

  const segments = await ctx.db.segment.findMany({
    where: { offeringId: offering.id },
    include: { factors: { select: { factor: true, value: true, overrideValue: true } }, _count: { select: { batches: true } } },
    orderBy: { name: "asc" },
  });
  const activeCount = segments.filter((s) => s.status === "ACTIVE").length;
  const rows: SegmentRow[] = segments.map((s) => ({
    id: s.id,
    name: s.name,
    buyer: s.buyer,
    problem: s.problem,
    industry: s.industry,
    status: s.status,
    origin: s.origin,
    audienceSize: s.audienceSize,
    cpcCents: s.cpcCents,
    caseStudyCount: s.caseStudyCount,
    batchCount: s._count.batches,
    factors: s.factors,
  }));

  const generate = canGenerate && (
    <ActionButton
      action={generateSegmentsAction.bind(null, slug, offering.id)}
      variant={segments.length ? "secondary" : "primary"}
      pendingText="Claude is proposing segments..."
      confirm={segments.length ? `Regenerate segments for ${offering.name}? Claude refreshes its proposals and the data numbers. Your overrides and statuses stay as they are.` : undefined}
    >
      {segments.length ? "Regenerate" : "Generate segments"}
    </ActionButton>
  );

  return (
    <>
      {header(
        <>
          {generate}
          {canGenerate && <ManualSegmentDialog action={addManualSegmentAction.bind(null, slug, offering.id)} />}
        </>,
      )}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {picker}
        <div className="text-sm text-ink-muted">
          <span className="tnum font-semibold text-ink">
            {activeCount} of {settings.maxActiveSegments}
          </span>{" "}
          active for this offering
        </div>
      </div>
      {segments.length === 0 ? (
        <EmptyState title="No segments yet" action={generate}>
          Claude proposes 8 to 12 buyer and problem pairs for {offering.name}, then each is scored with audience, search and case study data. You can also add one by hand.
        </EmptyState>
      ) : (
        <>
          <RankedSegments
            key={offering.id}
            slug={slug}
            currency={ctx.company.currency}
            rows={rows}
            savedWeights={settings.weights}
            initialFilter={(sp.status ?? "").toUpperCase()}
            canSaveWeights={ctx.can("settings.edit")}
            canGenerate={canGenerate}
            canActivate={ctx.can("segment.activate")}
          />
          {canGenerate && <p className="mt-3 text-xs text-ink-muted">Regenerating keeps your overrides and statuses. Segments Claude proposes again are updated in place; new ones are added as proposed.</p>}
        </>
      )}
    </>
  );
}
