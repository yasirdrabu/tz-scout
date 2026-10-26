import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/context";
import { maxCreditsPerRun } from "@/integrations/prospects";
import { modeOf } from "@/integrations/mode";
import { ActionButton, AutoRefresh, Spinner } from "@/components/client";
import { Badge, Card, EmptyState, LinkButton, Notice, PageHeader, Table, Td, Th } from "@/components/ui";
import { dateTime, num, relative } from "@/lib/format";
import { deletePullAction, runPullAction } from "./actions";
import { estimateFor, readFilters } from "./filters";
import { estimateText, filterSummary, scheduleLabel } from "./labels";

export const metadata = { title: "Pulls" };

export default async function PullsPage({ params }: { params: Promise<{ company: string }> }) {
  const { company: slug } = await params;
  const ctx = await getCompanyContext(slug);
  if (!ctx.can("buyers.view")) notFound();
  const canPull = ctx.can("buyers.pull");
  const live = modeOf("prospects") === "live";

  const pulls = await ctx.db.prospectSearch.findMany({ include: { offering: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } });
  const running = pulls.some((p) => p.status === "running");

  return (
    <>
      <AutoRefresh seconds={3} active={running} />
      <PageHeader
        eyebrow={
          <Link href={`/c/${slug}/buyers`} className="hover:text-ink">
            Buyers
          </Link>
        }
        title="Pulls"
        description="Saved searches for companies that look like your buyers. Each pull finds companies, reads their buying signals, finds the people to contact and ranks every company against your offerings."
        actions={
          canPull && (
            <LinkButton href={`/c/${slug}/buyers/pulls/new`} variant="primary">
              New pull
            </LinkButton>
          )
        }
      />

      {live ? (
        <Notice className="mb-4" tone="neutral" title="Apollo">
          Each pull is capped at {num(maxCreditsPerRun())} credits (APOLLO_MAX_CREDITS_PER_RUN).
        </Notice>
      ) : (
        <Notice className="mb-4" tone="near" title="Sample data">
          Pulls return made-up companies and use no credits. Add APOLLO_API_KEY and set INTEGRATION_PROSPECTS=live to pull real companies.
        </Notice>
      )}

      {pulls.length === 0 ? (
        <EmptyState
          title="No pulls yet"
          action={
            canPull && (
              <LinkButton href={`/c/${slug}/buyers/pulls/new`} variant="primary">
                New pull
              </LinkButton>
            )
          }
        >
          Start a pull from an offering or one of its segments. The filters fill in from the offering.
        </EmptyState>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Pull</Th>
                <Th>Offering</Th>
                <Th>Schedule</Th>
                <Th>Status</Th>
                <Th>Last run</Th>
                {canPull && <Th />}
              </tr>
            </thead>
            <tbody>
              {pulls.map((p) => {
                const summary = filterSummary(readFilters(p.filters));
                return (
                  <tr key={p.id}>
                    <Td className="min-w-[260px]">
                      {canPull ? (
                        <Link href={`/c/${slug}/buyers/pulls/${p.id}`} className="font-medium hover:underline">
                          {p.name}
                        </Link>
                      ) : (
                        <span className="font-medium">{p.name}</span>
                      )}
                      {summary.length > 0 && <div className="mt-0.5 text-xs text-ink-muted">{summary.join(" · ")}</div>}
                      <div className="mt-0.5 text-2xs text-ink-faint">{p.provider === "vibe" ? "Pulled from Vibe Prospecting through Claude. Ask Claude to refresh it." : estimateText(estimateFor(p.maxCompanies))}</div>
                    </Td>
                    <Td className="text-ink-soft">
                      {p.offering ? (
                        <Link href={`/c/${slug}/offerings/${p.offering.id}`} className="hover:underline">
                          {p.offering.name}
                        </Link>
                      ) : (
                        <span className="text-ink-muted">None</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-ink-soft">{scheduleLabel(p.schedule)}</Td>
                    <Td className="max-w-[240px]">
                      {p.status === "running" ? (
                        <span className="inline-flex items-center gap-1.5 text-ink-soft">
                          <Spinner /> Running
                        </span>
                      ) : p.status === "error" ? (
                        <>
                          <Badge tone="bad">Error</Badge>
                          {p.error && <div className="mt-1 text-2xs text-bad">{p.error}</div>}
                        </>
                      ) : p.lastRunAt ? (
                        <span className="text-ink-soft">Done</span>
                      ) : (
                        <span className="text-ink-muted">Not run yet</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-ink-soft" title={p.lastRunAt ? dateTime(p.lastRunAt) : undefined}>
                      {p.lastRunAt ? (
                        <>
                          {relative(p.lastRunAt)}
                          <div className="tnum text-xs text-ink-muted">
                            {num(p.lastRunFound ?? 0)} found, {num(p.lastRunNew ?? 0)} new
                          </div>
                          <div className="tnum text-xs text-ink-muted">{num(p.lastRunCredits ?? 0)} {p.provider === "vibe" ? "Vibe" : "Apollo"} credits used</div>
                        </>
                      ) : (
                        <span className="text-ink-muted">Never</span>
                      )}
                    </Td>
                    {canPull && (
                      <Td>
                        <div className="flex items-start justify-end gap-1.5">
                          {p.status !== "running" && p.provider !== "vibe" && (
                            <ActionButton action={runPullAction.bind(null, slug, p.id)} size="sm" pendingText="Starting...">
                              Run now
                            </ActionButton>
                          )}
                          <LinkButton href={`/c/${slug}/buyers/pulls/${p.id}`} size="sm" variant="ghost">
                            Edit
                          </LinkButton>
                          <ActionButton action={deletePullAction.bind(null, slug, p.id)} size="sm" variant="ghost" confirm={`Delete the pull "${p.name}"? Companies it already found stay in Buyers.`}>
                            Delete
                          </ActionButton>
                        </div>
                      </Td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
      <p className="mt-3 text-2xs text-ink-muted">Credits for a pull cover the search, company details, job postings and news. Revealing an email on an account costs one more credit.</p>
    </>
  );
}
