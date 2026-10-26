import Link from "next/link";
import type { AccountStatus } from "@prisma/client";
import { getCompanyContext } from "@/server/context";
import { listBuyers, tierCounts } from "@/server/buyers";
import { HUBSPOT_STATE_LABEL, listSellers, type HubSpotState } from "@/server/crm";
import { bulkBuyersAction } from "./actions";
import { BULK_FORM, BulkBar, SelectAll } from "./bulk";
import { modeOf } from "@/integrations/mode";
import { SIGNAL_KIND, type SignalKind, type SignalType, type Tier } from "@/lib/matching";
import { bestResearch } from "@/lib/research";
import { compact, dateTime, num, relative } from "@/lib/format";
import { Badge, Bar, Card, Dot, EmptyState, LinkButton, Notice, PageHeader, Table, Tabs, Td, Th, buttonClass, cx } from "@/components/ui";
import { ACCOUNT_STATUSES, ACCOUNT_STATUS_LABEL, ACCOUNT_STATUS_TONE, TIERS, TIER_TAB_LABEL, TIER_TONE, ageShort, contactName, hasAge, isAccountStatus, isTier, points, reasonsOf, score, shortTitle, signalLabel } from "./labels";

export const metadata = { title: "Buyers" };

const LIMIT = 200;

type Search = { tier?: string; offer?: string; status?: string; q?: string; owner?: string; list?: string; bucket?: string };

export default async function BuyersPage({ params, searchParams }: { params: Promise<{ company: string }>; searchParams: Promise<Search> }) {
  const { company: slug } = await params;
  const sp = await searchParams;
  const ctx = await getCompanyContext(slug);
  const now = new Date();

  const tier: Tier | "all" = sp.tier === "all" || (sp.list && !sp.tier) ? "all" : isTier(sp.tier) ? sp.tier : "act_now";
  const status: AccountStatus | null = isAccountStatus(sp.status) ? sp.status : null;
  const q = sp.q?.trim() || null;

  const offerings = await ctx.db.offering.findMany({ where: { status: "APPROVED" }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  const offeringId = offerings.some((o) => o.id === sp.offer) ? sp.offer! : null;
  const sellers = await listSellers(ctx.db, { teamOnly: true });
  const owner = sp.owner === "none" || sellers.some((x) => x.id === sp.owner) ? sp.owner! : null;
  const canAct = ctx.can("buyers.act");
  // An imported lead list, shown on its own (all fit levels unless a tab is picked).
  const list = sp.list ? await ctx.db.leadImport.findUnique({ where: { id: sp.list }, select: { id: true, name: true } }) : null;
  const listId = list?.id ?? null;
  const buckets = await ctx.db.bucket.findMany({ orderBy: { sort: "asc" }, select: { slug: true, name: true } });
  const bucketName = new Map(buckets.map((b) => [b.slug, b.name]));
  const bucket = buckets.some((b) => b.slug === sp.bucket) ? sp.bucket! : null;

  const [counts, offerGroups, lastPull, totalAccounts, sentCount, rows] = await Promise.all([
    tierCounts(ctx.db, offeringId, listId, bucket),
    ctx.db.account.groupBy({ by: ["bestOfferingId"], _count: true, where: { batchId: null, ...(tier === "all" ? {} : { tier }), ...(listId ? { importIds: { has: listId } } : {}), ...(bucket ? { buckets: { has: bucket } } : {}) } }),
    ctx.db.prospectSearch.aggregate({ _max: { lastRunAt: true } }),
    ctx.db.account.count(),
    ctx.db.account.count({ where: { batchId: { not: null } } }),
    listBuyers(ctx.db, { tier, offeringId, status, q, sellerId: owner, listId, bucket, take: LIMIT }),
  ]);
  const allCount = Object.values(counts).reduce((s, n) => s + (n ?? 0), 0);
  const tabCount = (t: Tier | "all") => (t === "all" ? allCount : (counts[t] ?? 0));
  const offerCount = new Map(offerGroups.map((g) => [g.bestOfferingId, g._count]));
  const lastRunAt = lastPull._max.lastRunAt;

  // Signals that counted toward each row's best offer, loaded once for the chips.
  const countedIds = new Set<string>();
  for (const a of rows) {
    const best = a.matches.find((m) => m.offeringId === a.bestOfferingId);
    if (best) for (const h of reasonsOf(best.reasons).signals) for (const id of h.signalIds.slice(0, 2)) countedIds.add(id);
  }
  const counted = countedIds.size ? await ctx.db.signal.findMany({ where: { id: { in: [...countedIds] } }, select: { id: true, type: true, title: true, occurredAt: true } }) : [];
  const signalById = new Map(counted.map((s) => [s.id, s]));

  const href = (patch: Partial<Record<keyof Search, string | null>>) => {
    const p = new URLSearchParams();
    const merged = { tier, offer: offeringId, status, q, owner, list: listId, bucket, ...patch };
    // With a list open, "All" is the default tab, so the tier is always spelled out.
    for (const [k, v] of Object.entries(merged)) if (v && !(k === "tier" && v === "act_now" && !merged.list)) p.set(k, v);
    const s = p.toString();
    return `/c/${slug}/buyers${s ? `?${s}` : ""}`;
  };
  const filtered = !!(offeringId || status || q || owner || bucket);
  const canPull = ctx.can("buyers.pull");

  return (
    <>
      <PageHeader
        title="Buyers"
        description="Companies that look like our buyers, ranked by fit and by signs they're buying now, each matched to the offer they're most likely to buy."
        actions={
          <div className="flex flex-col items-end gap-1">
            <div className="flex gap-2">
              <LinkButton href={`/c/${slug}/buyers/sent`} size="sm" variant="ghost">
                Sent ({sentCount})
              </LinkButton>
              {canAct && (
                <LinkButton href={`/c/${slug}/buyers/import`} size="sm" variant="ghost">
                  Import a list
                </LinkButton>
              )}
              <LinkButton href={`/c/${slug}/buyers/signals/guide`} size="sm" variant="ghost">
                How signals work
              </LinkButton>
              {canPull && (
                <LinkButton href={`/c/${slug}/buyers/pulls`} size="sm">
                  Pulls
                </LinkButton>
              )}
            </div>
            <span className="text-2xs text-ink-muted" title={lastRunAt ? dateTime(lastRunAt) : undefined}>
              {lastRunAt ? `Last pull ${relative(lastRunAt, now)}` : "No pulls run yet"}
            </span>
          </div>
        }
      />

      {modeOf("prospects") === "mock" && (
        <Notice className="mb-4" title="Sample data">
          Sample companies until an Apollo key is added. Matching, signals and briefs work the same way.
        </Notice>
      )}

      {list && (
        <Notice className="mb-4" title={`Showing the list "${list.name}"`}>
          Only companies from this lead list that are still in the queue.{" "}
          <Link href={`/c/${slug}/buyers/import/${list.id}`} className="link">
            What the import did
          </Link>
          {" · "}
          <Link href={href({ list: null, tier: null })} className="link">
            Show everyone
          </Link>
        </Notice>
      )}

      {totalAccounts === 0 ? (
        <EmptyState
          title="No companies yet"
          action={
            canPull ? (
              <LinkButton href={`/c/${slug}/buyers/pulls`} variant="primary">
                Go to pulls
              </LinkButton>
            ) : undefined
          }
        >
          A pull asks the prospect source for companies that fit an offering, reads their signals and finds the people to contact. Every company is then matched to the offer it&apos;s most likely to buy.
          {!canPull && " Ask an owner or operator to run the first pull."}
        </EmptyState>
      ) : (
        <>
          <Tabs
            current={tier}
            items={[...TIERS, "all" as const].map((t) => ({
              key: t,
              href: href({ tier: t }),
              count: tabCount(t),
              label: t === "all" ? "All" : (
                <span className="inline-flex items-center gap-1.5">
                  <Dot tone={TIER_TONE[t]} />
                  {TIER_TAB_LABEL[t]}
                </span>
              ),
            }))}
          />

          <div className="mb-3 space-y-2 text-xs">
            {buckets.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="w-14 shrink-0 text-ink-muted">Bucket</span>
                <FilterChip href={href({ bucket: null })} active={!bucket}>
                  All
                </FilterChip>
                {buckets.map((b) => (
                  <FilterChip key={b.slug} href={href({ bucket: b.slug })} active={b.slug === bucket}>
                    {b.name}
                  </FilterChip>
                ))}
              </div>
            )}
            {offerings.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="w-14 shrink-0 text-ink-muted">Best offer</span>
                <FilterChip href={href({ offer: null })} active={!offeringId}>
                  Any
                </FilterChip>
                {offerings.map((o) => (
                  <FilterChip key={o.id} href={href({ offer: o.id })} active={o.id === offeringId} count={offerCount.get(o.id) ?? 0}>
                    {o.name}
                  </FilterChip>
                ))}
              </div>
            )}
            {sellers.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="w-14 shrink-0 text-ink-muted">Owner</span>
                <FilterChip href={href({ owner: null })} active={!owner}>
                  Anyone
                </FilterChip>
                {sellers.map((x) => (
                  <FilterChip key={x.id} href={href({ owner: x.id })} active={x.id === owner}>
                    {x.name}
                  </FilterChip>
                ))}
                <FilterChip href={href({ owner: "none" })} active={owner === "none"}>
                  Unassigned
                </FilterChip>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="w-14 shrink-0 text-ink-muted">Status</span>
              <FilterChip href={href({ status: null })} active={!status}>
                Any
              </FilterChip>
              {ACCOUNT_STATUSES.map((s) => (
                <FilterChip key={s} href={href({ status: s })} active={s === status}>
                  {ACCOUNT_STATUS_LABEL[s]}
                </FilterChip>
              ))}
              <form method="get" className="ml-auto flex items-center gap-1.5">
                {tier !== "act_now" && <input type="hidden" name="tier" value={tier} />}
                {offeringId && <input type="hidden" name="offer" value={offeringId} />}
                {status && <input type="hidden" name="status" value={status} />}
                {bucket && <input type="hidden" name="bucket" value={bucket} />}
                {listId && <input type="hidden" name="list" value={listId} />}
                <input name="q" defaultValue={q ?? ""} placeholder="Company name or domain" aria-label="Search companies" className="input h-7 w-56 py-0 text-xs" />
                <button type="submit" className={buttonClass("secondary", "sm")}>
                  Search
                </button>
                {filtered && (
                  <Link href={href({ offer: null, status: null, q: null, owner: null, bucket: null })} className="link whitespace-nowrap">
                    Clear filters
                  </Link>
                )}
              </form>
            </div>
          </div>

          {rows.length === 0 ? (
            <EmptyState title="No companies here" action={filtered ? <LinkButton href={href({ offer: null, status: null, q: null, owner: null })}>Clear filters</LinkButton> : undefined}>
              {filtered ? "Nothing in this tier matches these filters." : tier === "act_now" ? "No company has both a strong fit and a recent buying signal right now. Check Good fit for companies to warm up." : "No companies in this tier."}
            </EmptyState>
          ) : (
            <>
            {canAct && <BulkBar action={bulkBuyersAction.bind(null, slug)} sellers={sellers.map((x) => ({ id: x.id, name: x.name }))} />}
            <Card>
              <Table>
                <thead>
                  <tr>
                    {canAct && (
                      <Th className="w-8">
                        <SelectAll />
                      </Th>
                    )}
                    <Th>Company</Th>
                    <Th>Best offer</Th>
                    <Th className="w-28">Fit and signals</Th>
                    <Th>Why they&apos;re a lead</Th>
                    <Th>Why now</Th>
                    <Th>Contact</Th>
                    <Th>Owner</Th>
                    <Th>HubSpot</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => {
                    const sorted = [...a.matches].sort((x, y) => y.total - x.total);
                    const best = sorted.find((m) => m.offeringId === a.bestOfferingId) ?? null;
                    const runnerUp = sorted.find((m) => m.offeringId !== a.bestOfferingId && m.tier !== "not_fit") ?? null;
                    const chips = topSignals(a, best ? reasonsOf(best.reasons) : null, signalById);
                    const contact = a.contacts[0];
                    const facts = [a.industry, a.employees != null ? `${compact(a.employees)} employees` : null, [a.city, a.state].filter(Boolean).join(", ") || null].filter(Boolean).join(" · ");
                    return (
                      <tr key={a.id} className="hover:bg-sunken/50">
                        {canAct && (
                          <Td className="w-8">
                            <input type="checkbox" name="ids" value={a.id} form={BULK_FORM} aria-label={`Select ${a.name}`} className="h-3.5 w-3.5" />
                          </Td>
                        )}
                        <Td className="min-w-40 max-w-[13rem]">
                          <Link href={`/c/${slug}/buyers/${a.id}`} className="font-medium text-ink hover:text-accent">
                            {a.name}
                          </Link>
                          <div className="text-2xs text-ink-muted">{a.domain}</div>
                          {facts && <div className="text-2xs text-ink-faint">{facts}</div>}
                        </Td>
                        <Td className="min-w-36 max-w-[12rem]">
                          {best ? (
                            <>
                              <div className="flex items-baseline justify-between gap-2">
                                <span className="text-ink">{best.offering.name}</span>
                                <span className="tnum font-medium text-ink">{score(best.total)}</span>
                              </div>
                              {runnerUp && (
                                <div className="flex items-baseline justify-between gap-2 text-2xs text-ink-muted">
                                  <span>also {runnerUp.offering.name}</span>
                                  <span className="tnum">{score(runnerUp.total)}</span>
                                </div>
                              )}
                            </>
                          ) : a.buckets.length ? (
                            <span className="text-ink-soft" title="No approved offer in this bucket yet; the research's proposed pilot goes to HubSpot instead.">{a.buckets.map((b) => bucketName.get(b) ?? b).join(", ")}</span>
                          ) : (
                            <span className="text-ink-faint">Not matched yet</span>
                          )}
                          {(() => {
                            const r = bestResearch(a.research)?.entry;
                            return r?.tier ? <div className="text-2xs text-ink-muted" title="The researcher's tier and score from the imported sheet">Research {r.tier}{r.score != null ? ` · ${r.score}` : ""}</div> : null;
                          })()}
                        </Td>
                        <Td>
                          <ScoreBar label="Fit" value={a.bestFit} />
                          <ScoreBar label="Signals" value={a.bestSignal} />
                        </Td>
                        <Td className="min-w-48 max-w-[15rem]">
                          {chips.length === 0 ? (
                            <span className="text-2xs text-ink-faint">{a.excludedReason && !a.excludedOverride ? a.excludedReason : "No buying signals yet"}</span>
                          ) : (
                            <div className="flex flex-col items-start gap-1">
                              {chips.map((c) => (
                                <span key={c.key} className="inline-flex max-w-full items-center gap-1.5 text-2xs text-ink-soft" title={[c.full, c.why].filter(Boolean).join("\n\n")}>
                                  <Dot tone={KIND_TONE[c.kind]} />
                                  <span className="truncate">
                                    <span className="font-medium text-ink">{c.label}</span>
                                    {c.title && <span className="text-ink-muted">: {c.title}</span>}
                                  </span>
                                  {c.age && <span className="tnum shrink-0 text-ink-faint">{c.age}</span>}
                                </span>
                              ))}
                            </div>
                          )}
                        </Td>
                        <Td className="min-w-44 max-w-[14rem]">
                          {best?.whyNow ? <p className="line-clamp-2 text-xs text-ink-soft" title={best.whyNow}>{best.whyNow}</p> : <span className="text-xs text-ink-faint">Not briefed yet</span>}
                        </Td>
                        <Td className="min-w-32">
                          {contact ? (
                            <>
                              <div className="text-ink">{contactName(contact)}</div>
                              <div className="text-2xs text-ink-muted">{contact.title ?? "No title"}</div>
                            </>
                          ) : (
                            <span className="text-2xs text-ink-faint">No buyer contact yet</span>
                          )}
                        </Td>
                        <Td className="whitespace-nowrap text-ink-soft">{a.seller ? a.seller.name : <span className="text-ink-faint">Unassigned</span>}</Td>
                        <Td className="min-w-28 max-w-[10rem]">
                          <HubSpotCell state={a.hubspotState} note={a.hubspotNote} pushedAt={a.pushedAt} now={now} />
                        </Td>
                        <Td>
                          <Badge tone={ACCOUNT_STATUS_TONE[a.status]}>{ACCOUNT_STATUS_LABEL[a.status]}</Badge>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              {rows.length >= LIMIT && <p className="px-4 py-2 text-xs text-ink-muted">Showing the top {num(rows.length)}. Narrow with the filters to see more.</p>}
            </Card>
            </>
          )}
        </>
      )}
    </>
  );
}

function FilterChip({ href, active, count, children }: { href: string; active: boolean; count?: number; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cx(
        "inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-xs",
        active ? "border-accent-line bg-accent-soft font-medium text-accent-ink" : "border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink",
      )}
    >
      {children}
      {count != null && <span className="tnum text-ink-faint">{count}</span>}
    </Link>
  );
}

function ScoreBar({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="mb-1 last:mb-0">
      <div className="flex items-baseline justify-between text-2xs">
        <span className="text-ink-muted">{label}</span>
        <span className="tnum text-ink">{value == null ? "n/a" : score(value)}</span>
      </div>
      <Bar value={value ?? 0} max={100} tone="accent" className="h-1" />
    </div>
  );
}

type Chip = { key: string; kind: SignalKind; label: string; title: string; full: string; why: string | null; age: string | null };

/** Research is the strongest reason, then trigger events, then visible pain. */
const KIND_TONE: Record<SignalKind, "accent" | "neutral" | "muted"> = { research: "accent", trigger: "neutral", pain: "muted" };

/** Up to three reasons: the signal rules that earned the best offer the most points, each with the evidence behind it. */
function topSignals(
  a: { name: string; signals: { id: string; type: string; title: string; occurredAt: Date; source?: string }[] },
  reasons: ReturnType<typeof reasonsOf> | null,
  byId: Map<string, { id: string; type: string; title: string; occurredAt: Date }>,
): Chip[] {
  const now = new Date();
  const out: Chip[] = [];
  const rank: Record<SignalKind, number> = { research: 0, trigger: 1, pain: 2 };
  const hits = [...(reasons?.signals ?? [])].sort((x, y) => rank[x.kind ?? SIGNAL_KIND[x.type]] - rank[y.kind ?? SIGNAL_KIND[y.type]] || y.points - x.points);
  const used = new Set<string>();
  for (const h of hits.slice(0, 3)) {
    const kind = h.kind ?? SIGNAL_KIND[h.type];
    const s = h.signalIds.map((id) => byId.get(id) ?? a.signals.find((x) => x.id === id)).find(Boolean);
    const evidence = s ? s.title : h.matched.slice(0, 2).join(", ");
    if (s) used.add(s.id);
    out.push({
      key: h.ruleId,
      kind,
      label: h.label,
      title: shortTitle(evidence.replace(/^Researching:\s*/i, ""), 28, a.name),
      full: `${h.label}: ${s ? s.title : h.matched.join(", ")} (${points(h.points)} of ${h.max} points)`,
      why: h.why ?? null,
      age: s && hasAge(s.type) && s.type !== "intent" ? ageShort(s.occurredAt, now) : null,
    });
  }
  for (const s of a.signals.filter((x) => x.source === "research" && !used.has(x.id)).slice(0, 3 - out.length)) {
    out.push({ key: s.id, kind: SIGNAL_KIND[s.type as SignalType] ?? "trigger", label: signalLabel(s.type), title: shortTitle(s.title, 28, a.name), full: `${signalLabel(s.type)}: ${s.title} (from research)`, why: null, age: ageShort(s.occurredAt, now) });
  }
  return out;
}
const HUBSPOT_TONE: Record<HubSpotState, "neutral" | "near" | "good"> = { new: "neutral", in_crm: "neutral", open_deal: "near", customer: "near" };

function HubSpotCell({ state, note, pushedAt, now }: { state: string | null; note: string | null; pushedAt: Date | null; now: Date }) {
  if (pushedAt) return <span className="text-2xs text-ink-soft" title={note ?? undefined}>Pushed {relative(pushedAt, now)}</span>;
  if (!state) return <span className="text-2xs text-ink-faint">Not checked</span>;
  const st = state as HubSpotState;
  return (
    <div title={note ?? undefined}>
      <Badge tone={HUBSPOT_TONE[st] ?? "neutral"}>{HUBSPOT_STATE_LABEL[st] ?? state}</Badge>
      {note && <div className="mt-0.5 truncate text-2xs text-ink-muted">{note}</div>}
    </div>
  );
}
