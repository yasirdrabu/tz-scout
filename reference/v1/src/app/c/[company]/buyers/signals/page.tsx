import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/context";
import type { MatchReasons } from "@/server/buyers";
import { SIGNAL_LABEL, SIGNAL_TYPES, type SignalType } from "@/lib/matching";
import { Badge, Card, cx, EmptyState, PageHeader } from "@/components/ui";
import { date, num, relative } from "@/lib/format";

export const metadata = { title: "Signals" };

const WINDOWS = [7, 30, 90] as const;
const DAY = 86400_000;

/** Monday 00:00 UTC of the week a date falls in. */
function weekStart(d: Date) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
}

const typeLabel = (t: string) => SIGNAL_LABEL[t as SignalType] ?? t;

export default async function SignalsPage({ params, searchParams }: { params: Promise<{ company: string }>; searchParams: Promise<{ days?: string; type?: string; offer?: string }> }) {
  const { company: slug } = await params;
  const sp = await searchParams;
  const ctx = await getCompanyContext(slug);
  if (!ctx.can("buyers.view")) notFound();

  const days = WINDOWS.find((w) => String(w) === sp.days) ?? 30;
  const type = SIGNAL_TYPES.find((t) => t === sp.type) ?? null;
  const now = new Date();
  const gte = new Date(now.getTime() - days * DAY);

  const [offerings, all] = await Promise.all([
    ctx.db.offering.findMany({ where: { status: "APPROVED" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ctx.db.signal.findMany({
      where: { occurredAt: { gte, lte: now } },
      include: { account: { select: { id: true, name: true, domain: true } } },
      orderBy: { occurredAt: "desc" },
      take: 2000,
    }),
  ]);
  const offer = offerings.find((o) => o.id === sp.offer) ?? null;
  const offerName = new Map(offerings.map((o) => [o.id, o.name]));

  // Which offers each signal counts toward, from the stored match reasons.
  const matches = all.length
    ? await ctx.db.accountMatch.findMany({ where: { accountId: { in: [...new Set(all.map((s) => s.accountId))] } }, select: { offeringId: true, reasons: true } })
    : [];
  const countsToward = new Map<string, Set<string>>();
  for (const m of matches) {
    const r = m.reasons as unknown as MatchReasons | null;
    for (const hit of r?.signals ?? []) {
      if (hit.points <= 0) continue;
      for (const sid of hit.signalIds) {
        const set = countsToward.get(sid) ?? new Set<string>();
        set.add(m.offeringId);
        countsToward.set(sid, set);
      }
    }
  }

  const inOffer = offer ? all.filter((s) => countsToward.get(s.id)?.has(offer.id)) : all;
  const byType = new Map<string, number>();
  for (const s of inOffer) byType.set(s.type, (byType.get(s.type) ?? 0) + 1);
  const rows = type ? inOffer.filter((s) => s.type === type) : inOffer;
  const accountsWithNew = new Set(rows.map((s) => s.accountId)).size;

  const weeks = new Map<number, typeof rows>();
  for (const s of rows) {
    const k = weekStart(s.occurredAt).getTime();
    weeks.set(k, [...(weeks.get(k) ?? []), s]);
  }

  const href = (o: { days?: number; type?: string | null; offer?: string | null }) => {
    const q = new URLSearchParams();
    const d = o.days ?? days;
    if (d !== 30) q.set("days", String(d));
    const t = o.type === undefined ? type : o.type;
    if (t) q.set("type", t);
    const of = o.offer === undefined ? offer?.id : o.offer;
    if (of) q.set("offer", of);
    const s = q.toString();
    return `/c/${slug}/buyers/signals${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/c/${slug}/buyers`} className="hover:text-ink">
            Buyers
          </Link>
        }
        title="Signals"
        description="What's happening at your accounts: what they're researching, leadership changes, deals, incidents, hiring and team changes. Newer signals count more toward an account's ranking."
        actions={
          <div className="flex items-center gap-2">
          <Link href={`/c/${slug}/buyers/signals/guide`} className="text-xs text-accent hover:underline">How signals work</Link>
          <div className="flex rounded border border-line-strong bg-surface p-0.5">
            {WINDOWS.map((w) => (
              <Link key={w} href={href({ days: w })} className={cx("rounded px-2.5 py-1 text-xs", w === days ? "bg-sunken font-medium text-ink" : "text-ink-muted hover:text-ink")}>
                {w} days
              </Link>
            ))}
          </div>
          </div>
        }
      />

      <Card className="mb-4 px-4 py-3">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div>
            <div className="text-xs text-ink-muted">Accounts with a new signal</div>
            <div className="tnum mt-0.5 text-xl font-semibold text-ink">{num(accountsWithNew)}</div>
          </div>
          <div>
            <div className="text-xs text-ink-muted">Signals</div>
            <div className="tnum mt-0.5 text-xl font-semibold text-ink">{num(rows.length)}</div>
          </div>
          <div className="ml-auto flex flex-wrap gap-1.5">
            <TypeChip href={href({ type: null })} on={!type} label="All types" count={inOffer.length} />
            {SIGNAL_TYPES.filter((t) => t !== "tech" || byType.get(t)).map((t) => (
              <TypeChip key={t} href={href({ type: t })} on={type === t} label={SIGNAL_LABEL[t]} count={byType.get(t) ?? 0} />
            ))}
          </div>
        </div>
      </Card>

      <form className="mb-4 flex flex-wrap items-end gap-3" action={`/c/${slug}/buyers/signals`}>
        {days !== 30 && <input type="hidden" name="days" value={days} />}
        {type && <input type="hidden" name="type" value={type} />}
        <label className="block">
          <span className="label">Counts toward offer</span>
          <select name="offer" className="input min-w-[240px]" defaultValue={offer?.id ?? ""}>
            <option value="">Any offer</option>
            {offerings.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="h-8 rounded border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-sunken">
          Show
        </button>
        {(offer || type) && (
          <Link href={href({ type: null, offer: null })} className="link pb-1.5 text-sm">
            Clear filters
          </Link>
        )}
      </form>

      {rows.length === 0 ? (
        <EmptyState title="No signals in this window">
          {offer || type ? "Try a longer window or clear the filters." : "Run a pull to read signals for new companies, or try a longer window."}
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {[...weeks.entries()].map(([k, list]) => (
            <Card key={k}>
              <div className="flex items-baseline justify-between border-b border-line px-4 py-2">
                <h2 className="text-sm font-semibold text-ink">Week of {date(new Date(k), { month: "short", day: "numeric", year: "numeric" })}</h2>
                <span className="tnum text-xs text-ink-muted">
                  {list.length} {list.length === 1 ? "signal" : "signals"}
                </span>
              </div>
              <ul className="divide-y divide-line">
                {list.map((s) => {
                  const offers = [...(countsToward.get(s.id) ?? [])].map((id) => offerName.get(id)).filter((n): n is string => !!n);
                  return (
                    <li key={s.id} className="grid gap-x-4 gap-y-1 px-4 py-2.5 text-sm sm:grid-cols-[200px_1fr_auto]">
                      <div className="min-w-0">
                        <Link href={`/c/${slug}/buyers/${s.account.id}`} className="font-medium text-ink hover:underline">
                          {s.account.name}
                        </Link>
                        <div className="truncate text-2xs text-ink-faint">{s.account.domain}</div>
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge>{typeLabel(s.type)}</Badge>
                          <span className="text-ink">{s.title}</span>
                          {s.url && (
                            <a href={s.url} target="_blank" rel="noreferrer" className="link text-xs">
                              Source
                            </a>
                          )}
                        </div>
                        {s.detail && <div className="mt-0.5 line-clamp-2 text-xs text-ink-muted">{s.detail}</div>}
                        {offers.length > 0 && (
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            <span className="text-2xs text-ink-muted">Counts toward</span>
                            {offers.map((n) => (
                              <Badge key={n} tone="accent">
                                {n}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="whitespace-nowrap text-xs text-ink-muted sm:text-right" title={date(s.occurredAt, { month: "short", day: "numeric", year: "numeric" })}>
                        {relative(s.occurredAt, now)}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
        </div>
      )}
      <p className="mt-4 text-2xs text-ink-muted">
        Technology use is read from each account&apos;s current tech stack, not stored as dated signals, so it doesn&apos;t appear here. It still counts toward rankings and shows on each account.
        {all.length >= 2000 && " Showing the 2,000 most recent signals."}
      </p>
    </>
  );
}

function TypeChip({ href, on, label, count }: { href: string; on: boolean; label: string; count: number }) {
  return (
    <Link href={href} className={cx("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs", on ? "border-accent-line bg-accent-soft font-medium text-accent-ink" : "border-line-strong bg-surface text-ink-soft hover:bg-sunken")}>
      {label}
      <span className="tnum text-ink-faint">{count}</span>
    </Link>
  );
}
