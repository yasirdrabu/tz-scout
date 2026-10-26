import { getCompanyContext } from "@/server/context";
import { ActionButton } from "@/components/client";
import { Badge, Card, CardHeader, EmptyState, Notice, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { money, relative } from "@/lib/format";
import { SIGNAL_LABEL } from "@/lib/matching";
import { modeOf } from "@/integrations/mode";
import type { WonDeal } from "@/integrations/hubspot";
import type { StoredWinFindings } from "@/server/wins";
import { applyRuleSuggestionAction, runWinAnalysisAction } from "./actions";

export const metadata = { title: "Wins" };

export default async function WinsPage({ params }: { params: Promise<{ company: string }> }) {
  const { company: slug } = await params;
  const ctx = await getCompanyContext(slug);
  const latest = await ctx.db.winAnalysis.findFirst({ orderBy: { createdAt: "desc" } });
  const offers = await ctx.db.offering.findMany({ select: { slug: true, name: true } });
  const offerName = new Map(offers.map((o) => [o.slug, o.name]));
  const run = latest?.aiRunId ? await ctx.db.aiRun.findUnique({ where: { id: latest.aiRunId }, select: { mock: true } }) : null;
  const f = latest ? (latest.findings as unknown as StoredWinFindings) : null;
  const deals = latest ? (latest.deals as unknown as WonDeal[]) : [];
  const canRun = ctx.can("offering.edit");
  const canRules = ctx.can("buyers.rules");

  return (
    <>
      <PageHeader
        title="Wins"
        description="What our won clients actually bought, read from closed-won deals in HubSpot. It sharpens the buying signals, the offers and who we go after."
        actions={
          canRun ? (
            <ActionButton action={runWinAnalysisAction.bind(null, slug)} variant="primary" pendingText="Reading HubSpot...">
              {latest ? "Run again" : "Analyze our wins"}
            </ActionButton>
          ) : undefined
        }
      />
      {modeOf("hubspot") !== "live" && <Notice className="mb-4" tone="neutral">HubSpot is in sample mode, so this reads sample deals.</Notice>}

      {!latest || !f ? (
        <EmptyState title="Not analyzed yet">Reads every closed-won deal in HubSpot (read only), with the company and buyers behind it, then finds the patterns.</EmptyState>
      ) : (
        <div className="space-y-5">
          <p className="text-xs text-ink-muted">
            {latest.dealCount} won deals from {latest.source === "hubspot" ? "HubSpot" : "sample data"}, analyzed {relative(latest.createdAt)}
            {latest.createdBy ? ` by ${latest.createdBy}` : ""}.{run?.mock ? " The numbers are exact; the patterns need Claude (not connected yet)." : ""}
          </p>

          <div className="grid gap-3 sm:grid-cols-4">
            <Card className="p-4"><Stat label="Won deals" value={f.stats.deals} /></Card>
            <Card className="p-4"><Stat label="Total won" value={money(f.stats.totalCents, ctx.company.currency, { compact: true })} /></Card>
            <Card className="p-4"><Stat label="Median deal" value={f.stats.medianCents != null ? money(f.stats.medianCents, ctx.company.currency, { compact: true }) : "n/a"} /></Card>
            <Card className="p-4"><Stat label="Median time to close" value={f.stats.medianCycleDays != null ? `${f.stats.medianCycleDays} days` : "n/a"} /></Card>
          </div>

          <Card>
            <CardHeader title="What it says" />
            <div className="space-y-3 p-4 text-sm">
              <p className="text-ink">{f.summary}</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <Breakdown title="Industries" rows={f.stats.industries.map((x) => [x.name, x.deals])} />
                <Breakdown title="Company size" rows={f.stats.sizes.map((x) => [x.band, x.deals])} />
                <Breakdown title="Who bought" rows={f.stats.titles.map((x) => [x.title, x.deals])} />
              </div>
              {f.patterns.length > 0 && (
                <div>
                  <Label>Patterns</Label>
                  <ul className="space-y-1.5">
                    {f.patterns.map((p) => (
                      <li key={p.pattern}>
                        <span className="font-medium text-ink">{p.pattern}</span> <span className="text-ink-muted">({p.deals} deals)</span>
                        <div className="text-xs text-ink-soft">{p.evidence}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="What they really bought" description="The outcome behind each win, mapped to our current offers." />
            <div className="space-y-3 p-4 text-sm">
              <ul className="space-y-1">
                {f.whatTheyBought.map((w) => (
                  <li key={w.theme} className="flex flex-wrap items-center gap-2">
                    <span className="text-ink">{w.theme}</span>
                    <span className="tnum text-xs text-ink-muted">{w.deals} deals</span>
                    {w.offerSlug ? <Badge tone="accent">{offerName.get(w.offerSlug) ?? w.offerSlug}</Badge> : <Badge tone="near">No offer for this</Badge>}
                  </li>
                ))}
                {f.whatTheyBought.length === 0 && <li className="text-ink-muted">Not read yet.</li>}
              </ul>
              {f.gaps.length > 0 && (
                <div>
                  <Label>Gaps in what we offer</Label>
                  <ul className="list-disc pl-5 text-ink-soft">{f.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
                </div>
              )}
              {f.offerSuggestions.length > 0 && (
                <div>
                  <Label>Offer changes the wins suggest</Label>
                  <ul className="list-disc pl-5 text-ink-soft">{f.offerSuggestions.map((g) => <li key={g}>{g}</li>)}</ul>
                </div>
              )}
            </div>
          </Card>

          {f.ruleSuggestions.length > 0 && (
            <Card>
              <CardHeader title="Buying signals to add" description="Rules that would surface more companies like the ones we've won. Adding one rescores every account." />
              <ul className="divide-y divide-line">
                {f.ruleSuggestions.map((r, i) => (
                  <li key={`${r.offerSlug}-${r.label}`} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
                    <div>
                      <div className="font-medium text-ink">
                        {r.label} <span className="font-normal text-ink-muted">· {SIGNAL_LABEL[r.type]} · {offerName.get(r.offerSlug) ?? r.offerSlug}</span>
                      </div>
                      <div className="text-xs text-ink-soft">{r.why}</div>
                      <div className="mt-0.5 text-2xs text-ink-faint">Matches: {r.keywords.join(", ")}</div>
                    </div>
                    {f.appliedRules?.includes(i) ? (
                      <Badge tone="good">Added</Badge>
                    ) : (
                      canRules && (
                        <ActionButton action={applyRuleSuggestionAction.bind(null, slug, latest.id, i)} size="sm" pendingText="Adding...">
                          Add rule
                        </ActionButton>
                      )
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <CardHeader title="The deals" />
            <Table>
              <thead>
                <tr>
                  <Th>Deal</Th>
                  <Th>Company</Th>
                  <Th numeric>Amount</Th>
                  <Th>Closed</Th>
                  <Th>Buyers</Th>
                </tr>
              </thead>
              <tbody>
                {deals.map((d) => (
                  <tr key={d.id}>
                    <Td className="max-w-xs">
                      <div className="font-medium text-ink">{d.name}</div>
                      {d.description && <div className="line-clamp-1 text-2xs text-ink-muted">{d.description}</div>}
                    </Td>
                    <Td className="text-ink-soft">
                      {d.company?.name ?? "n/a"}
                      <div className="text-2xs text-ink-muted">{[d.company?.industry?.replace(/_/g, " ").toLowerCase(), d.company?.employees ? `${d.company.employees} employees` : null].filter(Boolean).join(" · ")}</div>
                    </Td>
                    <Td numeric>{d.amountCents != null ? money(d.amountCents, ctx.company.currency, { compact: true }) : "n/a"}</Td>
                    <Td className="whitespace-nowrap text-ink-soft">{d.closedAt ? d.closedAt.slice(0, 10) : "n/a"}</Td>
                    <Td className="text-xs text-ink-soft">{d.buyerTitles.join(", ") || "none on file"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      )}
    </>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-muted">{children}</div>;
}

function Breakdown({ title, rows }: { title: string; rows: [string, number][] }) {
  return (
    <div className="rounded border border-line p-3">
      <Label>{title}</Label>
      {rows.length === 0 ? (
        <p className="text-xs text-ink-muted">Not on file.</p>
      ) : (
        <ul className="space-y-0.5 text-xs">
          {rows.map(([k, n]) => (
            <li key={k} className="flex justify-between gap-2">
              <span className="capitalize text-ink-soft">{k}</span>
              <span className="tnum text-ink">{n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
