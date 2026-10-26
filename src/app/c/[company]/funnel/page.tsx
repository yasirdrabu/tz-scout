import { getCompanyContext } from "@/server/context";
import { funnelDefaults, listScenarios } from "@/server/funnel";
import { computeFunnel, type FunnelInputs } from "@/lib/funnel";
import { date, money, multiple } from "@/lib/format";
import { EmptyState, LinkButton, Notice, PageHeader } from "@/components/ui";
import { FunnelEditor } from "./editor";
import { OfferingPicker, ScenarioList } from "./scenarios";
import { CompareTable } from "./compare";
import { saveScenarioAction } from "./actions";

export const metadata = { title: "Funnel model" };

type Search = { offering?: string; scenario?: string; compare?: string | string[]; present?: string };

export default async function FunnelPage({ params, searchParams }: { params: Promise<{ company: string }>; searchParams: Promise<Search> }) {
  const { company: slug } = await params;
  const sp = await searchParams;
  const ctx = await getCompanyContext(slug);
  const cur = ctx.company.currency;

  const offerings = await ctx.db.offering.findMany({ where: { status: "APPROVED" }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  if (offerings.length === 0) {
    return (
      <>
        <PageHeader title="Funnel model" />
        <EmptyState title="No approved offerings" action={<LinkButton href={`/c/${slug}/offerings`} variant="primary">Go to offerings</LinkButton>}>
          The funnel model works on an approved offering. Approve one first.
        </EmptyState>
      </>
    );
  }
  // Without a choice, open the offering someone modelled most recently.
  const recent = sp.offering ? null : await ctx.db.funnelScenario.findFirst({ orderBy: { createdAt: "desc" }, select: { offeringId: true } });
  const offering = offerings.find((o) => o.id === (sp.offering ?? recent?.offeringId)) ?? offerings[0]!;
  const [defaults, scenarios] = await Promise.all([funnelDefaults(ctx.db, ctx.company.id, offering.id), listScenarios(ctx.db, offering.id)]);

  const withDefaults = (i: FunnelInputs): FunnelInputs => ({ ...defaults.inputs, ...i, expansion: i.expansion ?? null });
  const loaded = scenarios.find((s) => s.id === sp.scenario) ?? null;
  const initial = loaded ? withDefaults(loaded.inputs) : defaults.inputs;

  const compareRaw = [sp.compare ?? []].flat().flatMap((c) => c.split(","));
  const compare = [...new Set(compareRaw)].map((id) => scenarios.find((s) => s.id === id)).filter((s): s is (typeof scenarios)[number] => s != null).slice(0, 3);

  const rows = scenarios.map((s) => {
    const r = computeFunnel(withDefaults(s.inputs));
    return { id: s.id, name: s.name, createdBy: s.createdBy, created: date(s.createdAt, { month: "short", day: "numeric", year: "numeric" }), costPerWon: money(r.costPerWonCents, cur), returnMultiple: multiple(r.returnMultiple) };
  });

  const base = `/c/${slug}/funnel?offering=${offering.id}${loaded ? `&scenario=${loaded.id}` : ""}`;
  const historyCount = Object.values(defaults.fromHistory).filter(Boolean).length;
  const canEdit = ctx.can("funnel.edit");

  return (
    <>
      <PageHeader
        title="Funnel model"
        description="What a won client costs at today's rates, and what changes if one stage gets better. Every number updates as you move a rate."
        actions={<OfferingPicker slug={slug} current={offering.id} offerings={offerings} />}
      />
      <Notice tone="neutral" className="mb-5" title="Where the starting numbers come from">
        Each rate starts from the last {defaults.history.days} days of history: ad results for cost and clickthrough, form fills from the site, the validation agent&apos;s pass rate, and meetings and deals from HubSpot. Where there isn&apos;t enough history to trust, the company default from Settings is used. {historyCount} of 8 rates come from history for this offering.
      </Notice>

      <FunnelEditor
        key={`${offering.id}:${loaded?.id ?? "defaults"}`}
        offeringId={offering.id}
        offeringName={offering.name}
        currency={cur}
        initial={initial}
        defaults={defaults.inputs}
        fromHistory={defaults.fromHistory}
        samples={defaults.history.samples}
        historyDays={defaults.history.days}
        scenario={loaded ? { id: loaded.id, name: loaded.name } : null}
        canEdit={canEdit}
        saveAction={saveScenarioAction.bind(null, slug, offering.id)}
        saveRedirect={`/c/${slug}/funnel?offering=${offering.id}&scenario={id}`}
        startPresent={sp.present === "1"}
      />

      <div className="mt-6 space-y-5">
        <ScenarioList slug={slug} offeringId={offering.id} scenarios={rows} loadedId={loaded?.id ?? null} compareIds={compare.map((c) => c.id)} canEdit={canEdit} />
        {compare.length >= 2 && <CompareTable scenarios={compare.map((c) => ({ id: c.id, name: c.name, inputs: withDefaults(c.inputs) }))} currency={cur} clearHref={base} />}
        {compare.length === 1 && <p className="text-xs text-ink-muted">Pick at least two scenarios to compare.</p>}
      </div>
    </>
  );
}
