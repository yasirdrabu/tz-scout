import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { getCompanyContext } from "@/server/context";
import { effectiveStatus, SAMPLE_SUBMISSIONS } from "@/server/leads";
import { TIMELINE_OPTIONS } from "@/lib/leadChecks";
import { Badge, Card, EmptyState, Notice, PageHeader, Table, Tabs, Td, Th, buttonClass } from "@/components/ui";
import { AutoRefresh } from "@/components/client";
import { dateTime, num, relative } from "@/lib/format";
import { LEAD_STATUS_LABEL, LEAD_STATUS_TONE, LEAD_TABS, personName, type LeadTab } from "./labels";
import { CheckStrip } from "./check-strip";
import { SimulateDialog } from "./forms";
import { simulateSubmissionAction } from "./actions";

export const metadata = { title: "Leads" };

const LIMIT = 100;

const TAB_WHERE: Record<LeadTab, Prisma.LeadWhereInput> = {
  review: { status: "REVIEW", overrideStatus: null },
  validated: { OR: [{ overrideStatus: "VALIDATED" }, { overrideStatus: null, status: "VALIDATED" }] },
  not_qualified: { OR: [{ overrideStatus: "NOT_QUALIFIED" }, { overrideStatus: null, status: "NOT_QUALIFIED" }] },
  all: {},
};

export default async function LeadsPage({ params, searchParams }: { params: Promise<{ company: string }>; searchParams: Promise<{ tab?: string; offering?: string }> }) {
  const { company: slug } = await params;
  const sp = await searchParams;
  const ctx = await getCompanyContext(slug);
  const now = new Date();

  const offerings = await ctx.db.offering.findMany({ where: { status: { not: "ARCHIVED" } }, orderBy: { name: "asc" }, select: { id: true, slug: true, name: true, status: true } });
  const offeringId = offerings.some((o) => o.id === sp.offering) ? sp.offering! : null;
  const base: Prisma.LeadWhereInput = offeringId ? { offeringId } : {};
  const where = (t: LeadTab): Prisma.LeadWhereInput => ({ AND: [base, TAB_WHERE[t]] });

  const [review, validated, notQualified, all, checking] = await Promise.all([
    ctx.db.lead.count({ where: where("review") }),
    ctx.db.lead.count({ where: where("validated") }),
    ctx.db.lead.count({ where: where("not_qualified") }),
    ctx.db.lead.count({ where: where("all") }),
    ctx.db.lead.count({ where: { status: { in: ["NEW", "VALIDATING"] } } }),
  ]);
  const counts: Record<LeadTab, number> = { review, validated, not_qualified: notQualified, all };
  const tab: LeadTab = LEAD_TABS.some((t) => t.key === sp.tab) ? (sp.tab as LeadTab) : review > 0 ? "review" : "all";

  const leads = await ctx.db.lead.findMany({
    where: where(tab),
    orderBy: { submittedAt: "desc" },
    take: LIMIT,
    include: { offering: { select: { name: true } }, checks: { select: { check: true, result: true, reason: true } } },
  });
  const ownerIds = [...new Set(leads.map((l) => l.ownerUserId).filter((x): x is string => !!x))];
  const owners = ownerIds.length ? await ctx.db.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } }) : [];
  const ownerName = new Map(owners.map((u) => [u.id, u.name]));

  const href = (t: LeadTab) => `/c/${slug}/leads?tab=${t}${offeringId ? `&offering=${offeringId}` : ""}`;
  const canSimulate = ctx.can("lead.simulate");

  return (
    <>
      <AutoRefresh seconds={4} active={checking > 0} />
      <PageHeader
        title="Leads"
        description="Every form fill is checked by the validation agent within a couple of minutes. All checks pass: validated and sent a booking link. Any check fails: not qualified, routed to nurture. Anything unknown: a person reviews it here."
        actions={
          canSimulate && (
            <SimulateDialog
              action={simulateSubmissionAction.bind(null, slug)}
              redirectTo={`/c/${slug}/leads/{id}`}
              samples={SAMPLE_SUBMISSIONS}
              offerings={offerings.filter((o) => o.status === "APPROVED" || o.status === "DRAFT").map((o) => ({ slug: o.slug, name: o.name, draft: o.status === "DRAFT" }))}
              timelines={TIMELINE_OPTIONS.map((t) => ({ value: t.value, label: t.label }))}
            />
          )
        }
      />

      {checking > 0 && (
        <Notice className="mb-4" title={`Checking ${checking} new lead${checking === 1 ? "" : "s"}`}>
          Results appear here on their own.
        </Notice>
      )}

      <Tabs current={tab} items={LEAD_TABS.map((t) => ({ key: t.key, label: t.label, href: href(t.key), count: counts[t.key] }))} />

      <form method="get" className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <input type="hidden" name="tab" value={tab} />
        <label htmlFor="offering-filter" className="text-ink-muted">
          Offering
        </label>
        <select id="offering-filter" name="offering" defaultValue={offeringId ?? ""} className="input h-7 w-auto py-0 text-xs">
          <option value="">All offerings</option>
          {offerings.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <button type="submit" className={buttonClass("secondary", "sm")}>
          Filter
        </button>
        {offeringId && (
          <Link href={`/c/${slug}/leads?tab=${tab}`} className="link">
            Clear
          </Link>
        )}
      </form>

      {leads.length === 0 ? (
        <EmptyState title={tab === "review" ? "Nothing to review" : "No leads here yet"}>
          {tab === "review" ? "Leads land here when a check can't be confirmed either way." : "Leads arrive from the website form. Use Simulate a form fill to try the agent."}
        </EmptyState>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Submitted</Th>
                <Th>Person</Th>
                <Th>Company</Th>
                <Th>Offering</Th>
                <Th>Status</Th>
                <Th>Checks</Th>
                <Th>Owner</Th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => {
                const st = effectiveStatus(l);
                return (
                  <tr key={l.id} className="hover:bg-sunken/50">
                    <Td className="whitespace-nowrap text-ink-soft" title={dateTime(l.submittedAt)}>
                      {relative(l.submittedAt, now)}
                    </Td>
                    <Td>
                      <Link href={`/c/${slug}/leads/${l.id}`} className="font-medium text-ink hover:text-accent">
                        {personName(l)}
                      </Link>
                      <div className="text-2xs text-ink-muted">{l.title ?? "No title given"}</div>
                    </Td>
                    <Td className="text-ink-soft">{l.companyName ?? l.domain ?? "Unknown"}</Td>
                    <Td className="text-ink-soft">{l.offering?.name ?? <span className="text-ink-faint">None</span>}</Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge tone={LEAD_STATUS_TONE[st]}>{LEAD_STATUS_LABEL[st]}</Badge>
                        {l.overrideStatus && (
                          <Badge tone="muted" title={l.overrideReason ?? undefined}>
                            Overridden
                          </Badge>
                        )}
                      </div>
                    </Td>
                    <Td>
                      <CheckStrip checks={l.checks} />
                    </Td>
                    <Td className="whitespace-nowrap text-ink-soft">{l.ownerUserId ? (ownerName.get(l.ownerUserId) ?? "Unknown") : <span className="text-ink-faint">Unassigned</span>}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {counts[tab] > leads.length && <p className="px-4 py-2 text-xs text-ink-muted">Showing the {leads.length} most recent of {num(counts[tab])} leads.</p>}
        </Card>
      )}
    </>
  );
}
