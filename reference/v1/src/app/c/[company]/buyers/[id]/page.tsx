import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/context";
import { modeOf } from "@/integrations/mode";
import { TIER_LABEL } from "@/lib/matching";
import { dateTime, money, num, relative } from "@/lib/format";
import { Badge, Card, CardHeader, KeyValue, Notice, PageHeader, buttonClass, cx } from "@/components/ui";
import { ActionButton } from "@/components/client";
import { ACCOUNT_STATUSES, ACCOUNT_STATUS_LABEL, ACCOUNT_STATUS_TONE, STATUS_ACTION_LABEL, TIER_TONE, ageShort, contactName, hasAge, location, points, reasonsOf, score, seniorityLabel, signalLabel, sourceLabel, tierOf } from "../labels";
import { WhyPanel } from "./why-panel";
import { ResearchCard } from "./research-card";
import type { ResearchEntry } from "@/lib/research";
import { buyerSettings, rulesFor } from "@/server/buyers";
import { SIGNAL_EXPLAINER, type SignalType } from "@/lib/matching";
import { assignSellerAction, checkHubSpotAction, setExclusionAction, briefAccountAction, draftProposalAction, prepareCallAction, pushCallReviewAction, pushToHubSpotAction, refreshAccountAction, reviewCallAction, revealEmailAction, setAccountStatusAction, startOutreachAction } from "../actions";
import { CopyButton, OwnerSelect, PushButton } from "./controls";
import { CallPrepCard, CallsCard } from "./calls";
import type { CallPrep } from "@/ai/callPrep";
import type { CallReviewOutput } from "@/ai/callReview";
import { HUBSPOT_STATE_LABEL, listSellers, type HubSpotState } from "@/server/crm";

export const metadata = { title: "Buyer" };

export default async function BuyerPage({ params, searchParams }: { params: Promise<{ company: string; id: string }>; searchParams: Promise<{ offer?: string }> }) {
  const { company: slug, id } = await params;
  const sp = await searchParams;
  const ctx = await getCompanyContext(slug);
  const now = new Date();

  const account = await ctx.db.account.findUnique({
    where: { id },
    include: {
      contacts: { orderBy: [{ isPrimary: "desc" }, { firstName: "asc" }] },
      seller: true,
      batch: true,
      signals: { orderBy: { occurredAt: "desc" } },
      matches: { include: { offering: { select: { id: true, name: true, status: true, targetTitles: true, slug: true, signalRules: true } } } },
    },
  });
  if (!account) notFound();

  const lists = account.importIds.length ? await ctx.db.leadImport.findMany({ where: { id: { in: account.importIds } }, select: { id: true, name: true }, orderBy: { createdAt: "asc" } }) : [];
  const contactIds = account.contacts.map((c) => c.id);
  const [leads, members, history] = await Promise.all([
    contactIds.length ? ctx.db.lead.findMany({ where: { contactId: { in: contactIds } }, select: { id: true, contactId: true } }) : [],
    ctx.db.membership.findMany({ include: { user: { select: { id: true, name: true } } } }),
    ctx.db.auditLog.findMany({
      where: { OR: [{ entity: "account", entityId: id }, ...(contactIds.length ? [{ entity: "contact", entityId: { in: contactIds } }] : [])] },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
  ]);
  const leadByContact = new Map(leads.map((l) => [l.contactId, l.id]));
  const sellers = await listSellers(ctx.db);
  const sellerName = (sid: string | null | undefined) => (sid ? (sellers.find((x) => x.id === sid)?.name ?? "someone") : null);
  const hubspotUrl = account.hubspotCompanyId && process.env.HUBSPOT_PORTAL_ID ? `https://app.hubspot.com/contacts/${process.env.HUBSPOT_PORTAL_ID}/record/0-2/${account.hubspotCompanyId}` : null;
  const crmOwner = account.hubspotOwnerId ? sellers.find((x) => x.hubspotOwnerId === account.hubspotOwnerId) : undefined;
  const hubspotOwner = account.hubspotOwnerId ? (crmOwner ? `${crmOwner.name}${crmOwner.active ? "" : " (no longer active)"}` : `HubSpot owner ${account.hubspotOwnerId}`) : null;
  // Owned by someone active other than our pick: pushing needs an explicit "push anyway". Inactive owners are reassigned.
  const ownedElsewhere = !!account.hubspotOwnerId && account.hubspotOwnerId !== account.seller?.hubspotOwnerId && account.hubspotOwnerId !== account.pushedOwnerId;
  // Someone is actually working it: pushing won't reassign it (src/lib/ownership.ts).
  const engaged = account.hubspotState === "open_deal" ? "has an open deal" : account.hubspotState === "customer" ? "is a customer" : null;
  const { takeOverOwnership } = await buyerSettings(ctx.db);
  const willTakeOver = ownedElsewhere && !engaged && (takeOverOwnership || crmOwner?.active === false);
  const team = members.map((m) => m.user).sort((x, y) => x.name.localeCompare(y.name));
  const historyUserIds = [...new Set([account.ownerUserId, ...history.map((h) => h.userId)].filter((x): x is string => !!x))].filter((uid) => !team.some((u) => u.id === uid));
  const others = historyUserIds.length ? await ctx.db.user.findMany({ where: { id: { in: historyUserIds } }, select: { id: true, name: true } }) : [];
  const userName = (uid: string | null | undefined) => (uid ? ([...team, ...others].find((u) => u.id === uid)?.name ?? "Someone") : null);

  const matches = account.matches
    .filter((m) => m.offering.status === "APPROVED")
    .map((m) => ({ ...m, why: reasonsOf(m.reasons) }))
    .sort((x, y) => y.total - x.total);
  const offerName = new Map(account.matches.map((m) => [m.offeringId, m.offering.name]));
  const selected = matches.find((m) => m.offeringId === sp.offer) ?? matches.find((m) => m.offeringId === account.bestOfferingId) ?? (account.buckets.length ? null : (matches[0] ?? null));
  const bucketName = new Map((await ctx.db.bucket.findMany({ select: { slug: true, name: true } })).map((b) => [b.slug, b.name]));
  const isBest = selected?.offeringId === account.bestOfferingId;
  // Without an Anthropic key the brief is assembled from rules; say so rather than credit Claude.
  const briefRun = selected?.aiRunId ? await ctx.db.aiRun.findUnique({ where: { id: selected.aiRunId }, select: { model: true } }) : null;
  const briefBy = briefRun?.model === "mock" ? "Assembled from rules (Claude isn't connected yet)" : "Written by Claude";

  // Which offers each signal counted toward, and which tech matched any offer.
  const countsToward = new Map<string, string[]>();
  const whyBySignal = new Map<string, { offer: string; why: string }[]>();
  const techHits = new Set<string>();
  for (const m of matches) {
    for (const h of m.why.signals) {
      if (h.points <= 0) continue;
      for (const sid of h.signalIds) {
        countsToward.set(sid, [...new Set([...(countsToward.get(sid) ?? []), m.offering.name])]);
        if (h.why) whyBySignal.set(sid, [...(whyBySignal.get(sid) ?? []), { offer: m.offering.name, why: h.why }]);
      }
      if (h.type === "tech") for (const t of h.matched) techHits.add(t.toLowerCase());
    }
  }

  const tier = tierOf(account.tier);
  const canAct = ctx.can("buyers.act");
  const callReviews = await ctx.db.callReview.findMany({ where: { accountId: account.id }, orderBy: { heldAt: "desc" } });
  const proposals = await ctx.db.proposal.findMany({ where: { accountId: account.id }, orderBy: { createdAt: "desc" }, select: { id: true, title: true, status: true, createdAt: true } });
  const canPull = ctx.can("buyers.pull");
  const revenue = account.revenueCents != null ? money(Number(account.revenueCents), ctx.company.currency, { compact: true }) : null;
  const where = location(account);
  const live = modeOf("prospects") === "live";
  const contactById = new Map(account.contacts.map((c) => [c.id, c]));
  const suggested = selected ? account.contacts.find((c) => c.isPrimary) : undefined;

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/c/${slug}/buyers`} className="hover:text-ink">
            Buyers
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {account.name}
            <Badge tone={ACCOUNT_STATUS_TONE[account.status]}>{ACCOUNT_STATUS_LABEL[account.status]}</Badge>
            <Badge tone={TIER_TONE[tier]}>{TIER_LABEL[tier]}</Badge>
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-1.5">
            <a href={account.websiteUrl ?? `https://${account.domain}`} target="_blank" rel="noreferrer" className="link">
              {account.domain}
            </a>
            {[account.industry, account.employees != null ? `${num(account.employees)} employees` : null, revenue ? `${revenue} revenue` : null, where || null, account.foundedYear ? `founded ${account.foundedYear}` : null, `Source: ${sourceLabel(account.source)}`]
              .filter(Boolean)
              .map((s) => (
                <span key={s}>· {s}</span>
              ))}
          </span>
        }
        actions={
          canPull && (
            <ActionButton action={refreshAccountAction.bind(null, slug, account.id)} variant="secondary" pendingText="Refreshing..." confirm="Pulls fresh data from the prospect source. Uses about 3 credits with Apollo.">
              Refresh data
            </ActionButton>
          )
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-5">
          <WhyPanel
            offerName={selected?.offering.name ?? null}
            tier={selected && selected.offeringId !== account.bestOfferingId ? tierOf(selected.tier) : tier}
            fit={selected?.fit ?? null}
            signal={selected?.signal ?? null}
            total={selected?.total ?? null}
            reasons={selected?.why ?? null}
            rules={selected ? rulesFor(selected.offering) : []}
            signals={account.signals}
            excluded={account.excludedReason}
            excludedOverride={account.excludedOverride}
            includeAction={setExclusionAction.bind(null, slug, account.id, !account.excludedOverride)}
            canAct={canAct}
            now={now}
          />
          {account.research && <ResearchCard slug={slug} research={account.research as Record<string, ResearchEntry>} bucketName={bucketName} />}
          {/* Brief */}
          <Card className="border-accent-line">
            <CardHeader
              title={selected ? `Brief for ${selected.offering.name}` : "Brief"}
              description={
                selected
                  ? selected.briefedAt
                    ? `${briefBy} ${relative(selected.briefedAt, now)} from this company's signals and the offer.${isBest ? "" : " This isn't the best offer for this company."}`
                    : "Claude writes why now, the angle, an opener and who to contact from this company's signals."
                  : undefined
              }
              actions={
                selected &&
                canAct && (
                  <ActionButton action={briefAccountAction.bind(null, slug, account.id, selected.offeringId)} size="sm" variant={selected.briefedAt ? "ghost" : "primary"} pendingText="Writing...">
                    {selected.briefedAt ? "Rewrite brief" : "Write brief"}
                  </ActionButton>
                )
              }
            />
            {matches.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2 text-xs">
                <span className="text-ink-muted">Offer</span>
                {matches.map((m) => (
                  <Link
                    key={m.id}
                    href={m.offeringId === account.bestOfferingId ? `/c/${slug}/buyers/${account.id}` : `/c/${slug}/buyers/${account.id}?offer=${m.offeringId}`}
                    scroll={false}
                    className={cx(
                      "inline-flex h-6 items-center gap-1 rounded-full border px-2.5",
                      m.id === selected?.id ? "border-accent-line bg-accent-soft font-medium text-accent-ink" : "border-line text-ink-soft hover:border-line-strong hover:text-ink",
                    )}
                  >
                    {m.offering.name}
                    <span className="tnum text-ink-faint">{score(m.total)}</span>
                    {m.offeringId === account.bestOfferingId && <span className="text-ink-faint">best</span>}
                  </Link>
                ))}
              </div>
            )}
            {!selected ? (
              <p className="px-4 py-4 text-sm text-ink-muted">This company isn&apos;t matched to an approved offering yet. Refresh its data or approve an offering.</p>
            ) : !selected.briefedAt ? (
              <p className="px-4 py-4 text-sm text-ink-muted">Not briefed yet.{canAct ? " Write a brief to get the why now, angle and opener." : ""}</p>
            ) : (
              <div className="space-y-4 px-4 py-4">
                <BriefPart label="Why now">{selected.whyNow}</BriefPart>
                <BriefPart label="Angle">{selected.angle}</BriefPart>
                <div>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">Opener</span>
                    {selected.opener && <CopyButton text={selected.opener} label="Copy opener" />}
                  </div>
                  <div className="whitespace-pre-line rounded border border-line bg-sunken/50 px-3 py-2 text-sm leading-relaxed text-ink">{selected.opener ?? <span className="text-ink-muted">No opener written.</span>}</div>
                </div>
                <BriefPart label="Who to contact">
                  {selected.contactTitle}
                  {suggested && (
                    <span className="text-ink-muted">
                      {" "}
                      · On file: {contactName(suggested)}
                      {suggested.title ? `, ${suggested.title}` : ""}
                    </span>
                  )}
                </BriefPart>
                {Array.isArray(selected.sequence) && selected.sequence.length > 0 && (
                  <div>
                    <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-muted">Follow-up sequence</div>
                    <p className="mb-2 text-2xs text-ink-muted">Four emails over two weeks. Each one becomes a dated task for the owner when the account is pushed to HubSpot.</p>
                    <ol className="space-y-2">
                      {(selected.sequence as { step: number; day: number; purpose: string; subject: string; body: string }[]).map((s) => (
                        <li key={s.step}>
                          <details className="group rounded border border-line bg-surface">
                            <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm">
                              <span>
                                <span className="tnum text-ink-muted">Day {s.day}</span> · <span className="font-medium text-ink">{s.purpose}</span>
                                <span className="text-ink-muted">: {s.subject}</span>
                              </span>
                              <span className="text-2xs text-ink-faint group-open:hidden">Show</span>
                            </summary>
                            <div className="border-t border-line px-3 py-2">
                              <div className="mb-1 flex justify-end">
                                <CopyButton text={`Subject: ${s.subject}\n\n${s.body}`} label="Copy email" />
                              </div>
                              <div className="whitespace-pre-line text-sm leading-relaxed text-ink">{s.body}</div>
                            </div>
                          </details>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            )}
          </Card>

          <CallPrepCard
            prep={(selected?.callPrep as CallPrep | null) ?? null}
            preparedAt={selected?.callPrepAt ?? null}
            offerName={selected?.offering.name ?? null}
            prepareAction={prepareCallAction.bind(null, slug, account.id, selected?.offeringId ?? null)}
            canAct={canAct && !!selected}
          />

          <CallsCard
            reviews={callReviews.map((c) => ({ id: c.id, title: c.title, heldAt: c.heldAt, source: c.source, review: c.review as unknown as CallReviewOutput, hubspotNoteId: c.hubspotNoteId, createdBy: c.createdBy }))}
            reviewAction={reviewCallAction.bind(null, slug, account.id)}
            pushAction={(rid) => pushCallReviewAction.bind(null, slug, rid)}
            canAct={canAct}
            pushed={!!account.hubspotCompanyId}
          />

          <Card>
            <CardHeader
              title="Proposals"
              description="A draft built from the account, the offer and the reviewed calls, in the buyer's own words. Edit, copy, and add to HubSpot."
              actions={
                canAct && selected ? (
                  <ActionButton action={draftProposalAction.bind(null, slug, account.id, selected.offeringId)} size="sm" pendingText="Drafting...">
                    Draft a proposal
                  </ActionButton>
                ) : undefined
              }
            />
            {proposals.length === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-muted">None yet.{callReviews.length === 0 ? " Review a call first for a sharper draft." : ""}</p>
            ) : (
              <ul className="divide-y divide-line">
                {proposals.map((pr) => (
                  <li key={pr.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                    <Link href={`/c/${slug}/buyers/${account.id}/proposals/${pr.id}`} className="font-medium text-ink hover:text-accent">
                      {pr.title}
                    </Link>
                    <span className="flex items-center gap-2 text-xs text-ink-muted">
                      {relative(pr.createdAt, now)}
                      <Badge tone={pr.status === "sent" ? "good" : "neutral"}>{pr.status === "sent" ? "Sent" : "Draft"}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Contacts */}
          <Card>
            <CardHeader
              title="Contacts"
              description={account.source === "vibe" ? "Decision-makers from Vibe Prospecting. The starred person is the best fit for the best offer. They go to HubSpot with the account." : live ? "Emails are revealed on request because each one uses an Apollo credit." : "Sample people. Revealing an email uses an Apollo credit once a key is added."}
            />
            {account.contacts.length === 0 ? (
              <p className="px-4 py-4 text-sm text-ink-muted">{account.source === "vibe" ? "No people pulled yet. Contacts are pulled through Vibe in Claude." : "No people pulled yet. Refresh the data to look for buyer titles."}</p>
            ) : (
              <ul className="divide-y divide-line">
                {account.contacts.map((c) => {
                  const leadId = leadByContact.get(c.id);
                  return (
                    <li key={c.id} className="flex flex-wrap items-start gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-sm font-medium text-ink">
                          {contactName(c)}
                          {c.isPrimary && (
                            <span className="text-accent" title="Primary contact for the best offer">
                              ★
                            </span>
                          )}
                          {c.seniority && <Badge tone="muted">{seniorityLabel(c.seniority)}</Badge>}
                        </div>
                        <div className="text-xs text-ink-soft">{c.title ?? "No title"}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                          {c.email ? <span className="font-mono text-ink-soft">{c.email}</span> : <span className="text-ink-faint">Email not revealed</span>}
                          {c.email && c.emailStatus === "valid" && <Badge tone="good">Verified</Badge>}
                          {c.email && c.emailStatus === "catch_all" && <Badge tone="near" title="The company's mail server accepts every address, so this one can't be confirmed. Usually right; watch for bounces.">Can&apos;t be verified</Badge>}
                          {c.importId && <Badge tone="muted" title="This person came in on an imported lead list. The email is as given in the list, not verified.">From a list</Badge>}
                          {c.linkedinUrl && (
                            <a href={c.linkedinUrl} target="_blank" rel="noreferrer" className="link">
                              LinkedIn
                            </a>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-start gap-2">
                        {!c.email && canAct && !leadId && (
                          <ActionButton action={revealEmailAction.bind(null, slug, c.id)} size="sm" variant="ghost" pendingText="Revealing..." confirm="Uses 1 Apollo credit">
                            Reveal email
                          </ActionButton>
                        )}
                        {leadId ? (
                          <Link href={`/c/${slug}/leads/${leadId}`} className={cx("inline-flex h-7 items-center gap-1 rounded border border-good-line bg-good-soft px-2.5 text-xs font-medium text-good")}>
                            In outreach
                          </Link>
                        ) : (
                          canAct &&
                          account.bestOfferingId && (
                            <ActionButton
                              action={startOutreachAction.bind(null, slug, account.id, c.id)}
                              size="sm"
                              variant={c.isPrimary ? "primary" : "secondary"}
                              pendingText="Starting..."
                              confirm={`Send ${contactName(c)} the opener with a booking link?${c.email ? "" : " This reveals the email first and uses 1 Apollo credit."}`}
                            >
                              Start outreach
                            </ActionButton>
                          )
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {/* Offer matches */}
          <Card>
            <CardHeader title="Offer match" description="How this company scores against every approved offer. Fit is whether it looks like the buyer; signals are signs it's buying now." />
            {matches.length === 0 ? (
              <p className="px-4 py-4 text-sm text-ink-muted">No matches yet.</p>
            ) : (
              <div>
                <div className="grid grid-cols-[1fr_auto_3rem_3.5rem_3rem] items-center gap-3 border-b border-line bg-sunken/60 px-4 py-2 text-2xs font-semibold uppercase tracking-wide text-ink-muted">
                  <span>Offer</span>
                  <span>Tier</span>
                  <span className="text-right">Fit</span>
                  <span className="text-right">Signals</span>
                  <span className="text-right">Total</span>
                </div>
                {matches.map((m) => {
                  const mt = tierOf(m.tier);
                  return (
                    <details key={m.id} className="group border-b border-line last:border-b-0">
                      <summary className="grid cursor-pointer list-none grid-cols-[1fr_auto_3rem_3.5rem_3rem] items-center gap-3 px-4 py-2 text-sm hover:bg-sunken/50 [&::-webkit-details-marker]:hidden">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="inline-block text-ink-muted transition-transform group-open:rotate-90">›</span>
                          <span className="truncate text-ink">{m.offering.name}</span>
                          {m.offeringId === account.bestOfferingId && <span className="text-2xs text-ink-faint">best</span>}
                        </span>
                        <Badge tone={TIER_TONE[mt]}>{TIER_LABEL[mt]}</Badge>
                        <span className="tnum text-right text-ink-soft">{score(m.fit)}</span>
                        <span className="tnum text-right text-ink-soft">{score(m.signal)}</span>
                        <span className="tnum text-right font-medium text-ink">{score(m.total)}</span>
                      </summary>
                      <div className="space-y-3 bg-sunken/30 px-4 pb-4 pt-2">
                        {m.why.disqualified && (
                          <Notice tone="bad" title="Ruled out">
                            {m.why.disqualified}
                          </Notice>
                        )}
                        <div className="grid gap-4 md:grid-cols-2">
                          <div>
                            <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-muted">Fit</div>
                            {m.why.fit.length === 0 ? (
                              <p className="text-xs text-ink-muted">No fit details.</p>
                            ) : (
                              <ul className="space-y-1">
                                {m.why.fit.map((p) => (
                                  <li key={p.key} className="text-xs">
                                    <div className="flex items-baseline justify-between gap-2">
                                      <span className="font-medium text-ink">{p.label}</span>
                                      <span className="tnum text-ink-soft">
                                        {points(p.points)} of {p.max}
                                      </span>
                                    </div>
                                    <div className="text-ink-muted">{p.note}</div>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                          <div>
                            <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-muted">Signals</div>
                            {m.why.signals.length === 0 ? (
                              <p className="text-xs text-ink-muted">No signal rules matched.</p>
                            ) : (
                              <ul className="space-y-1">
                                {m.why.signals.map((h) => (
                                  <li key={h.ruleId} className="text-xs">
                                    <div className="flex items-baseline justify-between gap-2">
                                      <span className="font-medium text-ink">{h.label}</span>
                                      <span className="tnum text-ink-soft">
                                        {points(h.points)} of {h.max}
                                      </span>
                                    </div>
                                    {h.matched.length > 0 && <div className="text-ink-muted">{h.matched.join("; ")}</div>}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </div>
                      </div>
                    </details>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Signals */}
          <Card>
            <CardHeader title="Signals" description="Everything we've seen at this company, newest first. Older signals count for less." />
            {account.signals.length === 0 ? (
              <p className="px-4 py-4 text-sm text-ink-muted">No signals yet.</p>
            ) : (
              <ol className="divide-y divide-line">
                {account.signals.map((s) => {
                  const toward = countsToward.get(s.id) ?? [];
                  return (
                    <li key={s.id} className="flex gap-3 px-4 py-2.5">
                      <div className="w-28 shrink-0 pt-0.5">
                        <Badge>{signalLabel(s.type)}</Badge>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-ink">
                          {s.url ? (
                            <a href={s.url} target="_blank" rel="noreferrer" className="hover:text-accent hover:underline">
                              {s.title}
                            </a>
                          ) : (
                            s.title
                          )}
                        </div>
                        {s.detail && <div className="line-clamp-2 text-xs text-ink-soft">{s.detail}</div>}
                        {toward.length > 0 && <div className="mt-0.5 text-2xs text-accent-ink">Counts toward {toward.join(", ")}</div>}
                        <details className="mt-0.5 text-2xs text-ink-muted">
                          <summary className="cursor-pointer select-none hover:text-ink">Why this matters</summary>
                          {(whyBySignal.get(s.id) ?? []).map((w) => (
                            <p key={w.offer} className="mt-1 text-ink-soft">
                              <span className="font-medium text-ink">{w.offer}:</span> {w.why}
                            </p>
                          ))}
                          {SIGNAL_EXPLAINER[s.type as SignalType] && (
                            <>
                              <p className="mt-1">{SIGNAL_EXPLAINER[s.type as SignalType].what}</p>
                              <p className="mt-1">{SIGNAL_EXPLAINER[s.type as SignalType].read}</p>
                            </>
                          )}
                        </details>
                      </div>
                      <div className="tnum shrink-0 text-right text-2xs text-ink-muted" title={dateTime(s.occurredAt)}>
                        {s.type === "intent" ? "this week" : hasAge(s.type) ? relative(s.occurredAt, now) : "current"}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          {canAct && (
            <Card>
              <CardHeader title="Work this account" />
              <div className="space-y-4 p-4">
                <OwnerSelect action={assignSellerAction.bind(null, slug, account.id)} current={account.sellerId} members={sellers.filter((x) => x.onTeam || x.id === account.sellerId).map((x) => ({ id: x.id, name: x.name }))} />
                <div>
                  <div className="label">Status</div>
                  <div className="flex flex-wrap gap-1.5">
                    {ACCOUNT_STATUSES.filter((s) => s !== account.status).map((s) => (
                      <ActionButton key={s} action={setAccountStatusAction.bind(null, slug, account.id, s)} size="sm" variant={s === "DISQUALIFIED" ? "danger" : "secondary"}>
                        {STATUS_ACTION_LABEL[s]}
                      </ActionButton>
                    ))}
                  </div>
                </div>
                {account.batch && (
                  <p className="rounded border border-accent-line bg-accent-soft px-2 py-1.5 text-xs text-ink">
                    Sent in <Link href={`/c/${slug}/buyers/sent`} className="font-medium underline">{account.batch.name}</Link>. It&apos;s out of the Buyers queue and lives in Sent.
                  </p>
                )}
                <div>
                  <div className="label">HubSpot</div>
                  {account.hubspotState && (
                    <p className="mb-2 text-xs text-ink-soft">
                      {HUBSPOT_STATE_LABEL[account.hubspotState as HubSpotState] ?? account.hubspotState}
                      {account.hubspotNote ? `: ${account.hubspotNote}` : ""}
                      {account.hubspotCheckedAt && <span className="text-ink-faint"> (checked {relative(account.hubspotCheckedAt, now)})</span>}
                    </p>
                  )}
                  {ownedElsewhere && hubspotOwner && (
                    <p className="mb-2 rounded border border-near/40 bg-near/10 px-2 py-1 text-xs text-ink">
                      {willTakeOver
                        ? `${hubspotOwner} owns this in HubSpot today. Pushing reassigns it${account.seller ? ` to ${account.seller.name}` : ""}, and the note records who had it.`
                        : engaged
                          ? `${hubspotOwner} owns this in HubSpot and it ${engaged}, so pushing won't reassign it. Push anyway adds the context and keeps their ownership.`
                          : `${hubspotOwner} owns this in HubSpot. Push anyway adds the context and keeps their ownership.`}
                    </p>
                  )}
                  <div className="flex flex-wrap items-start gap-2">
                    {account.seller ? (
                      <PushButton action={pushToHubSpotAction.bind(null, slug, account.id, ownedElsewhere && !willTakeOver)} label={account.pushedAt ? "Push again" : ownedElsewhere && !willTakeOver ? "Push anyway" : "Push to HubSpot"} confirmText={`Push ${account.name} to HubSpot for ${account.seller.name}? It sends the company, a note with every signal and why it matters, ${account.contacts.length ? `${account.contacts.length} contact${account.contacts.length === 1 ? "" : "s"}` : "no contacts yet"}, and a task for ${account.seller.name}.${account.pushedAt ? " The note and task are updated in place." : ""}`} />
                    ) : (
                      <span className="text-xs text-ink-muted">Assign an owner first.</span>
                    )}
                    <ActionButton action={checkHubSpotAction.bind(null, slug, account.id)} size="sm" variant="ghost" pendingText="Checking...">
                      Check HubSpot
                    </ActionButton>
                    {hubspotUrl && (
                      <a href={hubspotUrl} target="_blank" rel="noreferrer" className={buttonClass("ghost", "sm")}>
                        Open in HubSpot
                      </a>
                    )}
                  </div>
                  <p className="mt-1 text-2xs text-ink-muted">
                    {account.pushedAt ? `Pushed ${relative(account.pushedAt, now)}. ` : ""}Sends the company with its owner, a note with every signal and why it matters, the offer match and brief, the buyers we found with emails and phones, and a task for the owner.
                  </p>
                </div>
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title="Details" />
            <div className="space-y-3 p-4">
              <KeyValue
                items={[
                  ["Owner", account.seller?.name ?? <span className="text-ink-muted">Unassigned</span>],
                  ["Best offer", account.bestOfferingId ? `${offerName.get(account.bestOfferingId) ?? "Unknown"} (${score(account.bestTotal)})` : <span className="text-ink-muted">None yet</span>],
                  ["Fit and signals", account.bestFit != null ? `${score(account.bestFit)} fit, ${score(account.bestSignal)} signals` : <span className="text-ink-muted">Not scored</span>],
                  ["Headcount growth", account.headcountGrowth6m != null ? `${Math.round(account.headcountGrowth6m * 100)}% in six months` : <span className="text-ink-muted">Unknown</span>],
                  ["HubSpot", account.pushedAt ? <span title={dateTime(account.pushedAt)}>Pushed {relative(account.pushedAt, now)}{hubspotOwner ? `, owner ${hubspotOwner}` : ""}</span> : account.hubspotCompanyId ? <span>In HubSpot{hubspotOwner ? `, owner ${hubspotOwner}` : ""}</span> : <span className="text-ink-muted">Not pushed yet</span>],
                  ["Data from", <span key="src" title={account.enrichedAt ? dateTime(account.enrichedAt) : undefined}>{sourceLabel(account.source)}{account.enrichedAt ? `, ${relative(account.enrichedAt, now)}` : ""}</span>],
                  ...(lists.length
                    ? [["From lists", <span key="lists">{lists.map((l, i) => <span key={l.id}>{i > 0 && ", "}<Link href={`/c/${slug}/buyers/import/${l.id}`} className="link">{l.name}</Link></span>)}</span>] as [string, React.ReactNode]]
                    : []),
                  ["Matched", account.matchedAt ? <span title={dateTime(account.matchedAt)}>{relative(account.matchedAt, now)}</span> : <span className="text-ink-muted">Not yet</span>],
                  ...(account.linkedinUrl ? [["LinkedIn", <a key="li" href={account.linkedinUrl} target="_blank" rel="noreferrer" className="link">Company page</a>] as [string, React.ReactNode]] : []),
                ]}
              />
              {account.description && <p className="text-xs leading-relaxed text-ink-soft">{account.description}</p>}
            </div>
          </Card>

          <Card>
            <CardHeader title="Tech stack" description={techHits.size ? "Highlighted tools count toward an offer." : undefined} />
            {account.technologies.length === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-muted">No tools known.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5 p-4">
                {account.technologies.map((t) => (
                  <Badge key={t} tone={techHits.has(t.toLowerCase()) ? "accent" : "neutral"}>
                    {t}
                  </Badge>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Activity" description="Who did what on this account, newest first." />
            {history.length === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-muted">Nothing logged yet.</p>
            ) : (
              <ol className="divide-y divide-line">
                {history.map((h) => {
                  const d = (h.data && typeof h.data === "object" && !Array.isArray(h.data) ? h.data : {}) as Record<string, unknown>;
                  const contact = h.entity === "contact" && h.entityId ? contactById.get(h.entityId) : undefined;
                  return (
                    <li key={h.id} className="px-4 py-2.5 text-sm">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-ink-soft">
                          <span className="font-medium text-ink">{userName(h.userId) ?? "System"}</span> {describe(h.action, d, { contact: contact ? contactName(contact) : null, offerName: (oid) => offerName.get(oid) ?? "an offer", userName, sellerName, contactName: (cid) => { const c = contactById.get(cid); return c ? contactName(c) : null; } })}
                        </span>
                        <span className="tnum shrink-0 text-2xs text-ink-muted" title={dateTime(h.createdAt)}>
                          {ageShort(h.createdAt, now)}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function BriefPart({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-0.5 text-2xs font-semibold uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="text-sm leading-relaxed text-ink">{children || <span className="text-ink-muted">Not written.</span>}</div>
    </div>
  );
}

function describe(
  action: string,
  d: Record<string, unknown>,
  h: { contact: string | null; offerName: (id: string) => string; userName: (id: string | null) => string | null; sellerName: (id: string | null) => string | null; contactName: (id: string) => string | null },
): string {
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  switch (action) {
    case "account.new":
      return "moved it back to new";
    case "account.working":
      return "marked it working";
    case "account.qualified":
      return "marked it qualified";
    case "account.disqualified":
      return "disqualified it";
    case "account.customer":
      return "marked it as a customer";
    case "account.pushHubspot":
      return `pushed it to HubSpot${str(d.owner) ? ` for ${str(d.owner)}` : ""}${typeof d.contacts === "number" ? ` with ${d.contacts} contact${d.contacts === 1 ? "" : "s"}` : ""}`;
    case "account.assign": {
      const who = h.sellerName(str(d.sellerId));
      return who ? `assigned it to ${who}` : "removed the owner";
    }
    case "account.outreach": {
      const who = str(d.contactId) ? h.contactName(str(d.contactId)!) : null;
      return who ? `started outreach with ${who}` : "started outreach";
    }
    case "account.owner": {
      const owner = h.userName(str(d.ownerUserId));
      return owner ? `assigned it to ${owner}` : "removed the owner";
    }
    case "account.brief":
      return `wrote the brief for ${str(d.offeringId) ? h.offerName(str(d.offeringId)!) : "an offer"}`;
    case "account.refresh":
      return "refreshed the data";
    case "contact.revealEmail":
      return `revealed the email for ${h.contact ?? "a contact"}`;
    default:
      return action.replace(/[._]/g, " ");
  }
}
