import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/context";
import { PageHeader } from "@/components/ui";
import { dateTime } from "@/lib/format";
import { PullForm } from "../pull-form";
import { estimateTable, readFilters } from "../filters";

export const metadata = { title: "Edit pull" };

export default async function EditPullPage({ params }: { params: Promise<{ company: string; id: string }> }) {
  const { company: slug, id } = await params;
  const ctx = await getCompanyContext(slug);
  if (!ctx.can("buyers.pull")) notFound();
  const pull = await ctx.db.prospectSearch.findUnique({ where: { id } });
  if (!pull) notFound();

  const offerings = await ctx.db.offering.findMany({
    where: { OR: [{ status: "APPROVED" }, ...(pull.offeringId ? [{ id: pull.offeringId }] : [])] },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  const segments = pull.offeringId
    ? await ctx.db.segment.findMany({
        where: { offeringId: pull.offeringId, OR: [{ status: { in: ["ACTIVE", "SHORTLISTED"] } }, ...(pull.segmentId ? [{ id: pull.segmentId }] : [])] },
        select: { id: true, name: true, status: true },
        orderBy: [{ status: "asc" }, { name: "asc" }],
      })
    : [];

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/c/${slug}/buyers/pulls`} className="hover:text-ink">
            Pulls
          </Link>
        }
        title={pull.name}
        description={pull.lastRunAt ? `Last run ${dateTime(pull.lastRunAt)}: ${pull.lastRunFound ?? 0} found, ${pull.lastRunNew ?? 0} new.` : "Not run yet."}
      />
      <PullForm
        slug={slug}
        id={pull.id}
        values={{ name: pull.name, offeringId: pull.offeringId, segmentId: pull.segmentId, filters: readFilters(pull.filters), maxCompanies: pull.maxCompanies, schedule: pull.schedule }}
        offerings={offerings}
        segments={segments}
        estimates={estimateTable()}
      />
    </>
  );
}
