import Link from "next/link";
import { getCompanyContext } from "@/server/context";
import { rulesFor } from "@/server/buyers";
import { KIND_LABEL, SIGNAL_EXPLAINER, SIGNAL_KIND, SIGNAL_LABEL, SIGNAL_TYPES, type SignalKind } from "@/lib/matching";
import { Badge, Card, CardHeader, Dot, LinkButton, PageHeader } from "@/components/ui";

export const metadata = { title: "How signals work" };

const KINDS: { kind: SignalKind; tone: "accent" | "neutral" | "muted"; body: string }[] = [
  { kind: "research", tone: "accent", body: "The company is reading about the problem an offer solves, well above its normal level. The strongest reason, because it's the company telling us what it's trying to buy." },
  { kind: "trigger", tone: "neutral", body: "Something changed in the last 90 days that opens budget or forces a decision: a new leader, a deal, cost cutting, an incident, expansion." },
  { kind: "pain", tone: "muted", body: "Evidence the problem exists: old software, a large manual operations team, hiring to keep things running. Real, but it doesn't say they're buying now." },
];

export default async function SignalGuide({ params }: { params: Promise<{ company: string }> }) {
  const { company: slug } = await params;
  const ctx = await getCompanyContext(slug);
  const offerings = await ctx.db.offering.findMany({ where: { status: "APPROVED" }, orderBy: { name: "asc" }, select: { id: true, name: true, slug: true, signalRules: true } });

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/c/${slug}/buyers/signals`} className="hover:text-ink">
            Signals
          </Link>
        }
        title="How signals work"
        description="Fit says a company could buy. Signals say why it would buy now. A company is only an act-now lead with at least one research or trigger signal."
        actions={<LinkButton href={`/c/${slug}/buyers`}>Back to buyers</LinkButton>}
      />

      <div className="grid gap-5 lg:grid-cols-3">
        {KINDS.map((k, i) => (
          <Card key={k.kind} className="p-4">
            <div className="mb-1 flex items-center gap-2">
              <Dot tone={k.tone} />
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                {i + 1}. {KIND_LABEL[k.kind]}
              </span>
            </div>
            <p className="text-sm text-ink-soft">{k.body}</p>
          </Card>
        ))}
      </div>

      <Card className="mt-5">
        <CardHeader title="Every signal type" description="What each one is and how to read it." />
        <ul className="divide-y divide-line">
          {SIGNAL_TYPES.map((t) => (
            <li key={t} className="grid gap-2 px-4 py-3 sm:grid-cols-[180px_1fr]">
              <div className="flex items-start gap-2">
                <Badge>{SIGNAL_LABEL[t]}</Badge>
                <span className="text-2xs text-ink-faint">{KIND_LABEL[SIGNAL_KIND[t]]}</span>
              </div>
              <div className="text-sm">
                <p className="text-ink">{SIGNAL_EXPLAINER[t].what}</p>
                <p className="mt-1 text-ink-soft">{SIGNAL_EXPLAINER[t].read}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <h2 className="mb-3 mt-8 text-sm font-semibold text-ink">What counts for each offer</h2>
      <div className="space-y-5">
        {offerings.map((o) => {
          const rules = rulesFor(o);
          return (
            <Card key={o.id}>
              <CardHeader
                title={o.name}
                description="Points each signal can add. Research counts most."
                actions={ctx.can("buyers.rules") && <LinkButton size="sm" variant="ghost" href={`/c/${slug}/offerings/${o.id}/signals`}>Edit signals</LinkButton>}
              />
              <ul className="divide-y divide-line">
                {rules.map((r) => (
                  <li key={r.id} className="grid gap-2 px-4 py-2.5 sm:grid-cols-[1fr_70px]">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-ink">{r.label}</span>
                        <Badge tone={SIGNAL_KIND[r.type] === "research" ? "accent" : "neutral"}>{SIGNAL_LABEL[r.type]}</Badge>
                      </div>
                      {r.why && <p className="mt-0.5 text-xs text-ink-soft">{r.why}</p>}
                    </div>
                    <div className="tnum text-right text-sm text-ink-muted">up to {r.weight}</div>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
      </div>

      <Card className="mt-5 p-4">
        <h2 className="text-sm font-semibold text-ink">Ruled out automatically</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
          <li>Companies that sell software or AI to this market. They build it; they don&apos;t buy it.</li>
          <li>Units of large public companies. Buying decisions usually sit with the parent.</li>
          <li>Excluded industries and domains set on each offering, and existing customers or open deals once HubSpot is connected.</li>
        </ul>
        <p className="mt-2 text-xs text-ink-muted">Anyone can override a rule-out on the company page with &quot;Include anyway&quot;.</p>
      </Card>
    </>
  );
}
