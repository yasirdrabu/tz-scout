import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/context";
import { rulesFor, SignalRulesSchema } from "@/server/buyers";
import { defaultRulesFor } from "@/lib/signalRules";
import { TIER_LABEL, type SignalRule, type Tier } from "@/lib/matching";
import { Badge, Card, CardHeader, Notice, PageHeader } from "@/components/ui";
import { num } from "@/lib/format";
import { RulesEditor } from "./rules-editor";
import { saveRulesAction } from "./actions";

export const metadata = { title: "Buying signals" };

const TIERS: Tier[] = ["act_now", "good_fit", "watch", "not_fit"];

/** Same rules regardless of key order. */
const key = (rs: SignalRule[]) => JSON.stringify(rs.map((r) => [r.id, r.type, r.label, r.match, r.weight, r.min ?? null]));
const same = (a: SignalRule[], b: SignalRule[]) => key(a) === key(b);

export default async function OfferingSignalsPage({ params }: { params: Promise<{ company: string; id: string }> }) {
  const { company: slug, id } = await params;
  const ctx = await getCompanyContext(slug);
  const o = await ctx.db.offering.findUnique({ where: { id }, select: { id: true, slug: true, name: true, status: true, signalRules: true } });
  if (!o) notFound();
  const canEdit = ctx.can("buyers.rules") && o.status !== "ARCHIVED";

  const rules = rulesFor(o);
  const starting = defaultRulesFor(o.slug);
  const saved = SignalRulesSchema.safeParse(o.signalRules);
  const hasSaved = saved.success && saved.data.length > 0;

  const [tiers, top] = await Promise.all([
    ctx.db.account.groupBy({ by: ["tier"], where: { bestOfferingId: id }, _count: true }),
    ctx.db.account.findMany({ where: { bestOfferingId: id }, orderBy: { bestTotal: { sort: "desc", nulls: "last" } }, take: 5, select: { id: true, name: true, domain: true, bestTotal: true, tier: true } }),
  ]);
  const tierCount = Object.fromEntries(tiers.map((t) => [t.tier ?? "not_fit", t._count])) as Partial<Record<Tier, number>>;
  const bestFor = tiers.reduce((s, t) => s + t._count, 0);

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/c/${slug}/offerings/${o.id}`} className="hover:text-ink">
            {o.name}
          </Link>
        }
        title="Buying signals"
        description={
          <>
            What suggests a company is ready to buy {o.name} now. Matching signals add up to 100 points toward an account&apos;s signal score, and newer signals count more: a signal loses half its weight every 45 days, while tech stack and headcount growth don&apos;t fade.
          </>
        }
      />
      {o.status !== "APPROVED" && (
        <Notice tone="near" className="mb-4">
          Only approved offerings are matched to accounts. These rules take effect once {o.name} is approved.
        </Notice>
      )}

      <div className="grid gap-5 xl:grid-cols-[1fr_280px]">
        <Card className="min-w-0">
          <CardHeader
            title="Rules"
            description="Each rule gives points when an account shows a matching signal. A rule with no keywords counts any signal of its type. Saving re-ranks every account."
            actions={!hasSaved ? <Badge>Using the starting rules</Badge> : same(saved.data, starting) ? <Badge>Same as the starting rules</Badge> : <Badge tone="accent">Edited</Badge>}
          />
          <RulesEditor action={saveRulesAction.bind(null, slug, o.id)} initial={rules} starting={starting} canEdit={canEdit} />
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Best match for" description={`Accounts where ${o.name} is the offer they're most likely to buy.`} />
            <div className="p-4">
              <div className="tnum text-2xl font-semibold text-ink">{num(bestFor)}</div>
              <div className="text-xs text-ink-muted">{bestFor === 1 ? "account" : "accounts"}</div>
              <dl className="mt-3 space-y-1.5 text-sm">
                {TIERS.map((t) => (
                  <div key={t} className="flex items-baseline justify-between gap-3">
                    <dt className="text-ink-soft">{TIER_LABEL[t]}</dt>
                    <dd className="tnum text-ink">
                      <Link href={`/c/${slug}/buyers?offer=${o.id}&tier=${t}`} className="hover:underline">
                        {num(tierCount[t] ?? 0)}
                      </Link>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </Card>
          <Card>
            <CardHeader title="Top accounts" />
            {top.length === 0 ? (
              <p className="p-4 text-sm text-ink-muted">No accounts match this offer best yet.</p>
            ) : (
              <ol className="divide-y divide-line">
                {top.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                    <div className="min-w-0">
                      <Link href={`/c/${slug}/buyers/${a.id}`} className="block truncate font-medium text-ink hover:underline">
                        {a.name}
                      </Link>
                      <div className="truncate text-2xs text-ink-muted">{a.tier ? TIER_LABEL[a.tier as Tier] ?? a.tier : a.domain}</div>
                    </div>
                    <span className="tnum text-ink">{a.bestTotal != null ? Math.round(a.bestTotal) : ""}</span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
