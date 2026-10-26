import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/context";
import { filtersFor } from "@/server/buyers";
import { emptyFilters } from "@/integrations/prospects";
import { Card, CardHeader, cx, Notice, PageHeader } from "@/components/ui";
import { PullForm } from "../pull-form";
import { estimateTable } from "../filters";

export const metadata = { title: "New pull" };

export default async function NewPullPage({ params, searchParams }: { params: Promise<{ company: string }>; searchParams: Promise<{ offering?: string; segment?: string }> }) {
  const { company: slug } = await params;
  const sp = await searchParams;
  const ctx = await getCompanyContext(slug);
  if (!ctx.can("buyers.pull")) notFound();

  const offerings = await ctx.db.offering.findMany({ where: { status: "APPROVED" }, orderBy: { name: "asc" } });
  const segmentParam = sp.segment ? await ctx.db.segment.findUnique({ where: { id: sp.segment }, select: { id: true, offeringId: true } }) : null;
  const offeringId = sp.offering ?? segmentParam?.offeringId ?? null;
  const offering = offeringId ? offerings.find((o) => o.id === offeringId) ?? null : null;
  const segments = offering
    ? await ctx.db.segment.findMany({ where: { offeringId: offering.id, status: { in: ["ACTIVE", "SHORTLISTED"] } }, select: { id: true, name: true, buyer: true, industry: true, status: true }, orderBy: [{ status: "asc" }, { name: "asc" }] })
    : [];
  const segment = segmentParam && offering && segmentParam.offeringId === offering.id ? segments.find((s) => s.id === segmentParam.id) ?? null : null;
  const active = segments.filter((s) => s.status === "ACTIVE");

  const base = `/c/${slug}/buyers/pulls/new`;
  const values = {
    name: offering ? `${offering.name}: ${segment ? segment.name : "target buyers"}` : "",
    offeringId: offering?.id ?? null,
    segmentId: segment?.id ?? null,
    filters: offering ? filtersFor(offering, segment) : emptyFilters(),
    maxCompanies: 25,
    schedule: "off",
  };

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/c/${slug}/buyers/pulls`} className="hover:text-ink">
            Pulls
          </Link>
        }
        title="New pull"
        description="Pick an offering to fill in the filters from it, then adjust. Hiring and technology filters narrow the pull to companies already showing a buying signal."
      />
      {offeringId && !offering && (
        <Notice tone="near" className="mb-4" title="That offering isn't approved">
          Pulls start from approved offerings. Pick one below.
        </Notice>
      )}

      <Card className="mb-5 max-w-4xl">
        <CardHeader title="Start from" description="Choosing one reloads the form with its filters." />
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap gap-1.5">
            {offerings.map((o) => (
              <Chip key={o.id} href={`${base}?offering=${o.id}`} on={offering?.id === o.id}>
                {o.name}
              </Chip>
            ))}
            {offerings.length === 0 && <span className="text-sm text-ink-muted">No approved offerings yet. You can still build a pull by hand.</span>}
          </div>
          {offering && active.length > 0 && (
            <div>
              <div className="label">Active segments of {offering.name}</div>
              <div className="flex flex-wrap gap-1.5">
                <Chip href={`${base}?offering=${offering.id}`} on={!segment}>
                  Whole offering
                </Chip>
                {active.map((s) => (
                  <Chip key={s.id} href={`${base}?offering=${offering.id}&segment=${s.id}`} on={segment?.id === s.id} title={s.industry ? `Industry: ${s.industry}` : undefined}>
                    {s.name}
                  </Chip>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>

      <PullForm
        key={`${offering?.id ?? "none"}:${segment?.id ?? "none"}`}
        slug={slug}
        id={null}
        values={values}
        offerings={offerings.map((o) => ({ id: o.id, name: o.name }))}
        segments={segments.map((s) => ({ id: s.id, name: s.name, status: s.status }))}
        estimates={estimateTable()}
      />
    </>
  );
}

function Chip({ href, on, title, children }: { href: string; on: boolean; title?: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      title={title}
      className={cx("rounded-full border px-2.5 py-1 text-xs", on ? "border-accent-line bg-accent-soft font-medium text-accent-ink" : "border-line-strong bg-surface text-ink-soft hover:bg-sunken")}
    >
      {children}
    </Link>
  );
}
