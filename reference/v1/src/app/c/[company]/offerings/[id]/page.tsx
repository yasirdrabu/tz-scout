import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/context";
import { getOffering } from "@/server/offerings";
import { Badge, LinkButton, Notice, PageHeader } from "@/components/ui";
import { ActionButton } from "@/components/client";
import { date } from "@/lib/format";
import { OfferingForm } from "../offering-form";
import { toFormValues } from "../values";
import { draftOfferingAction, saveOfferingAction, scoreOfferAction, setOfferingStatusAction, setReadinessOverrideAction } from "../actions";
import { ReadinessCard } from "./readiness";
import type { Readiness } from "@/lib/offerReadiness";
import { STATUS_LABEL, STATUS_TONE } from "../labels";

export default async function OfferingPage({ params }: { params: Promise<{ company: string; id: string }> }) {
  const { company: slug, id } = await params;
  const ctx = await getCompanyContext(slug);
  const o = await getOffering(ctx.db, id);
  if (!o) notFound();
  const caseStudies = await ctx.db.caseStudy.findMany({ orderBy: { client: "asc" }, select: { id: true, title: true, client: true, industry: true } });
  const segCount = await ctx.db.segment.count({ where: { offeringId: id } });
  const canEdit = ctx.can("offering.edit") && o.status !== "ARCHIVED";

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/c/${slug}/offerings`} className="hover:text-ink">
            Offerings
          </Link>
        }
        title={
          <span className="flex items-center gap-2">
            {o.name}
            <Badge tone={STATUS_TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge>
          </span>
        }
        description={o.status === "APPROVED" && o.approvedAt ? `Approved ${date(o.approvedAt, { month: "short", day: "numeric", year: "numeric" })}` : undefined}
        actions={
          <>
            <LinkButton href={`/c/${slug}/offerings/${o.id}/signals`}>Buying signals</LinkButton>
            <LinkButton href={`/report/${slug}/${o.slug}`}>Buying Window report</LinkButton>
            {o.status === "APPROVED" && (
              <>
                <LinkButton href={`/c/${slug}/segments?offering=${o.id}`}>{segCount ? `Segments (${segCount})` : "Generate segments"}</LinkButton>
                <LinkButton href={`/c/${slug}/funnel?offering=${o.id}`}>Funnel model</LinkButton>
              </>
            )}
            {o.status === "DRAFT" && ctx.can("offering.approve") && (
              <ActionButton action={setOfferingStatusAction.bind(null, slug, o.id, "APPROVED")} variant="primary" pendingText="Approving...">
                Approve
              </ActionButton>
            )}
            {o.status !== "ARCHIVED" && ctx.can("offering.edit") && (
              <ActionButton action={setOfferingStatusAction.bind(null, slug, o.id, "ARCHIVED")} variant="ghost" confirm={`Archive ${o.name}? It will be hidden from lists and new work.`}>
                Archive
              </ActionButton>
            )}
            {o.status === "ARCHIVED" && ctx.can("offering.edit") && (
              <ActionButton action={setOfferingStatusAction.bind(null, slug, o.id, "DRAFT")}>Restore as draft</ActionButton>
            )}
          </>
        }
      />
      {o.status === "DRAFT" && (
        <Notice tone="near" className="mb-5" title="Draft">
          {ctx.can("offering.approve") ? "Review the fields and approve when ready. Segments, message tests and the funnel model only use approved offerings." : "An owner needs to approve this offering before segments, tests and the funnel model can use it."}
        </Notice>
      )}
      {o.status === "APPROVED" && ctx.can("offering.edit") && (
        <p className="mb-4 text-xs text-ink-muted">Changing the promise, titles, industries or company size sends the offering back to draft for re-approval.</p>
      )}
      {o.status !== "ARCHIVED" && (
        <ReadinessCard readiness={(o.readiness as Readiness | null) ?? null} scoreAction={scoreOfferAction.bind(null, slug, o.id)} overrideAction={setReadinessOverrideAction.bind(null, slug, o.id)} canEdit={ctx.can("offering.edit")} />
      )}
      <OfferingForm
        initial={toFormValues(o)}
        saveAction={saveOfferingAction.bind(null, slug, o.id)}
        draftAction={draftOfferingAction.bind(null, slug, o.id)}
        caseStudies={caseStudies}
        canEdit={canEdit}
      />
    </>
  );
}
