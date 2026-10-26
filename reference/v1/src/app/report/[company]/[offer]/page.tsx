// The Buying Window report: the companies in a market showing buying signals right now, for one offer.
// A clean, printable page outside the app shell (sign-in required). It's the front-door offer: it shows
// who and why now, and holds back the names of people as the reason to talk.

import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/context";
import { KIND_LABEL } from "@/lib/matching";
import { reasonsOf } from "@/app/c/[company]/buyers/labels";

export const metadata = { title: "Buying Window report", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const LIMIT = 25;

export default async function ReportPage({ params, searchParams }: { params: Promise<{ company: string; offer: string }>; searchParams: Promise<{ for?: string; tier?: string }> }) {
  const { company: slug, offer: offerSlug } = await params;
  const sp = await searchParams;
  const ctx = await getCompanyContext(slug);
  const offer = await ctx.db.offering.findFirst({ where: { slug: offerSlug } });
  if (!offer) notFound();
  const tiers = sp.tier === "act_now" ? ["act_now"] : ["act_now", "good_fit"];
  const accounts = await ctx.db.account.findMany({
    where: { bestOfferingId: offer.id, tier: { in: tiers }, OR: [{ excludedReason: null }, { excludedOverride: true }] },
    orderBy: [{ bestTotal: "desc" }],
    take: LIMIT,
    include: { signals: { orderBy: { occurredAt: "desc" } }, matches: { where: { offeringId: offer.id } }, _count: { select: { contacts: true } } },
  });
  const total = await ctx.db.account.count({ where: { bestOfferingId: offer.id, tier: { in: tiers }, OR: [{ excludedReason: null }, { excludedOverride: true }] } });
  const actNow = accounts.filter((a) => a.tier === "act_now").length;
  const withBuyer = accounts.filter((a) => a._count.contacts > 0).length;
  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const industries = [...new Set(accounts.map((a) => a.industry?.replace(/:.*$/, "")).filter(Boolean))].slice(0, 4);

  return (
    <main className="min-h-screen bg-canvas px-4 py-8 print:bg-white print:p-0">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="rounded-lg border border-line bg-surface p-6 print:border-0">
          <div className="text-2xs font-semibold uppercase tracking-widest text-accent">Buying Window report</div>
          <h1 className="mt-1 text-2xl font-semibold text-ink">
            {accounts.length} companies that look ready to buy {offer.name}
          </h1>
          <p className="mt-2 text-sm text-ink-soft">
            {sp.for ? `Prepared for ${sp.for}. ` : ""}Companies in {industries.join(", ") || "your market"} that fit {offer.name} and are showing signs they&apos;re buying: researching the problem, a new leader, an expansion, or systems that are holding them back. As of {today}.
          </p>
          <div className="mt-4 grid grid-cols-3 gap-3 text-center">
            <Stat n={accounts.length} label={total > accounts.length ? `of ${total} matching` : "companies"} />
            <Stat n={actNow} label="in a buying window now" />
            <Stat n={withBuyer} label="with the decision-maker identified" />
          </div>
        </header>

        <ol className="space-y-3">
          {accounts.map((a, i) => {
            const m = a.matches[0];
            const hits = m ? reasonsOf(m.reasons).signals : [];
            const byId = new Map(a.signals.map((s) => [s.id, s]));
            const reasons = [...hits]
              .sort((x, y) => ["research", "trigger", "pain"].indexOf(x.kind) - ["research", "trigger", "pain"].indexOf(y.kind) || y.points - x.points)
              .slice(0, 4)
              .map((h) => {
                const s = h.signalIds.map((id) => byId.get(id)).find(Boolean);
                return { kind: h.kind, label: h.label, detail: s ? s.title : h.matched[0] ?? "" };
              });
            return (
              <li key={a.id} className="break-inside-avoid rounded-lg border border-line bg-surface p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <span className="tnum mr-2 text-xs text-ink-faint">{i + 1}</span>
                    <span className="text-base font-semibold text-ink">{a.name}</span>
                    <span className="ml-2 text-xs text-ink-muted">{[a.industry?.replace(/:.*$/, ""), a.employeesRange && `${a.employeesRange} employees`, [a.city, a.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}</span>
                  </div>
                  <span className={`rounded px-2 py-0.5 text-2xs font-medium ${a.tier === "act_now" ? "bg-good/10 text-good" : "bg-sunken text-ink-soft"}`}>{a.tier === "act_now" ? "Buying window open" : "Strong fit, watch"}</span>
                </div>
                {m?.whyNow && <p className="mt-2 text-sm text-ink">{m.whyNow}</p>}
                {reasons.length > 0 && (
                  <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                    {reasons.map((r) => (
                      <li key={r.label} className="text-xs text-ink-soft">
                        <span className="font-medium text-ink">{KIND_LABEL[r.kind]}:</span> {r.detail || r.label}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-2xs text-ink-muted">{a._count.contacts > 0 ? "Decision-maker identified. Contact details on request." : "Decision-maker not identified yet."}</p>
              </li>
            );
          })}
        </ol>

        {accounts.length === 0 && <p className="rounded-lg border border-line bg-surface p-6 text-sm text-ink-muted">No companies match this offer yet. Run a pull for it first.</p>}

        <footer className="rounded-lg border border-line bg-surface p-6 text-sm text-ink-soft print:border-0">
          <div className="font-semibold text-ink">What this is</div>
          <p className="mt-1">
            Every company here fits the profile of a {offer.name} buyer and is showing at least one buying signal: active research on the problem, a trigger event like a new leader or an acquisition, or systems that are holding them back. The people to talk to, and what to say to each, come with a 20-minute walk-through.
          </p>
          <p className="mt-3 text-2xs text-ink-faint">Prepared by {ctx.company.name} · {today} · Signals change weekly.</p>
        </footer>
      </div>
    </main>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="rounded border border-line px-2 py-3">
      <div className="tnum text-2xl font-semibold text-ink">{n}</div>
      <div className="text-2xs text-ink-muted">{label}</div>
    </div>
  );
}
