import Link from "next/link";
import { getCompanyContext } from "@/server/context";
import { openFixes, scorecardView } from "@/server/scorecard";
import { addDays, weekStart } from "@/lib/scorecard";
import { date, dateTime } from "@/lib/format";
import { ActionButton } from "@/components/client";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Td, Th, colourTone, cx } from "@/components/ui";
import { addFixAction, diagnoseWeekAction, editDiagnosisAction, rebuildWeeksAction, syncConversionsAction, toggleFixAction } from "./actions";
import { AddFixForm, EditDiagnosisDialog, FixItem, SendConversions } from "./controls";
import { CELL_TONE, fmtMetric, isoDay, weekLabel } from "./format";

export const metadata = { title: "Scorecard" };

type Search = { weeks?: string; end?: string };

export default async function ScorecardPage({ params, searchParams }: { params: Promise<{ company: string }>; searchParams: Promise<Search> }) {
  const { company: slug } = await params;
  const sp = await searchParams;
  const ctx = await getCompanyContext(slug);
  const cur = ctx.company.currency;
  const canEdit = ctx.can("scorecard.edit");
  const canComplete = ctx.can("fix.complete");

  // Week range.
  const count = sp.weeks === "12" ? 12 : 8;
  const thisMonday = weekStart(new Date());
  let end = thisMonday;
  if (sp.end && /^\d{4}-\d{2}-\d{2}$/.test(sp.end)) {
    const d = new Date(`${sp.end}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) end = weekStart(d);
  }
  if (end > thisMonday) end = thisMonday;
  const first = addDays(end, -7 * (count - 1));
  const href = (e: Date, n = count) => `/c/${slug}/scorecard?weeks=${n}${e.getTime() === thisMonday.getTime() ? "" : `&end=${isoDay(e)}`}`;
  const later = addDays(end, 7 * count) > thisMonday ? thisMonday : addDays(end, 7 * count);

  const view = await scorecardView(ctx.db, { count, endMonday: end });

  // The latest complete week carries the current diagnosis.
  const latest = await ctx.db.week.findFirst({
    where: { startDate: { lt: thisMonday } },
    orderBy: { startDate: "desc" },
    include: { diagnosis: { include: { fixes: { orderBy: { createdAt: "asc" } } } } },
  });
  const diagnosis = latest?.diagnosis ?? null;
  const carried = (await openFixes(ctx.db)).filter((f) => latest && f.diagnosis.weekId !== latest.id && f.diagnosis.week.startDate < latest.startDate);
  const history = await ctx.db.diagnosis.findMany({
    where: latest ? { weekId: { not: latest.id } } : {},
    include: { week: true, fixes: true },
    orderBy: { week: { startDate: "desc" } },
    take: 12,
  });

  const userIds = [diagnosis?.editedById, ...(diagnosis?.fixes.map((f) => f.doneById) ?? [])].filter((x): x is string => !!x);
  const users = userIds.length ? await ctx.db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const nameOf = (id: string | null | undefined) => users.find((u) => u.id === id)?.name ?? null;

  const [wonDeals, sentDeals, lastSent] = await Promise.all([
    ctx.db.dealLink.count({ where: { isWon: true } }),
    ctx.db.dealLink.count({ where: { isWon: true, conversionSentAt: { not: null } } }),
    ctx.db.dealLink.findFirst({ where: { conversionSentAt: { not: null } }, orderBy: { conversionSentAt: "desc" }, select: { conversionSentAt: true } }),
  ]);

  const groups = ["Marketing", "Sales"] as const;
  const latestLabel = latest ? weekLabel(latest.startDate) : null;

  return (
    <>
      <PageHeader
        title="Weekly scorecard"
        description="Every stage of the funnel, week by week, against target. Weeks run Monday to Sunday."
        actions={
          canEdit && (
            <>
              <ActionButton action={rebuildWeeksAction.bind(null, slug, isoDay(first))} pendingText="Rebuilding...">
                Rebuild weeks
              </ActionButton>
              {latest && (
                <ActionButton
                  action={diagnoseWeekAction.bind(null, slug, latest.id)}
                  variant="primary"
                  pendingText="Diagnosing..."
                  confirm={diagnosis ? `Run the diagnosis again for the week of ${latestLabel}? Claude rewrites the text and the open fixes for that week. Fixes already done are kept.` : undefined}
                >
                  Run diagnosis now
                </ActionButton>
              )}
            </>
          )
        }
      />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-sm">
        <div className="flex items-center gap-1">
          <Link href={href(addDays(end, -7 * count))} className="rounded border border-line-strong bg-surface px-2.5 py-1 text-xs hover:bg-sunken">
            ‹ Earlier
          </Link>
          {end < thisMonday ? (
            <Link href={href(later)} className="rounded border border-line-strong bg-surface px-2.5 py-1 text-xs hover:bg-sunken">
              Later ›
            </Link>
          ) : (
            <span className="rounded border border-line px-2.5 py-1 text-xs text-ink-faint">Later ›</span>
          )}
          <span className="ml-2 text-xs text-ink-muted">
            {weekLabel(first)} to {date(addDays(end, 6), { month: "short", day: "numeric", year: "numeric" })}
          </span>
          {end < thisMonday && (
            <Link href={href(thisMonday)} className="link ml-2 text-xs">
              Back to this week
            </Link>
          )}
        </div>
        <div className="flex overflow-hidden rounded border border-line-strong text-xs">
          {[8, 12].map((n) => (
            <Link key={n} href={href(end, n)} className={cx("px-2.5 py-1", n === count ? "bg-accent-soft font-medium text-accent-ink" : "bg-surface hover:bg-sunken")}>
              {n} weeks
            </Link>
          ))}
        </div>
      </div>

      {view.weeks.length === 0 ? (
        <EmptyState title="No weeks built for this range" action={canEdit && <ActionButton action={rebuildWeeksAction.bind(null, slug, isoDay(first))} variant="primary" pendingText="Building...">Build these weeks</ActionButton>}>
          Weeks are built every Monday from ad results, leads, meetings and deals. You can build them now.
        </EmptyState>
      ) : (
        <Card>
          {diagnosis ? (
            <div className="border-b border-line text-sm">
              <div className="grid gap-x-4 border-b border-line px-4 py-2 sm:grid-cols-[240px_1fr]">
                <span className="text-xs font-medium text-ink-muted">Biggest bottleneck, week of {latestLabel}</span>
                <span className="font-medium text-ink">{diagnosis.bottleneck}</span>
              </div>
              <div className="grid gap-x-4 px-4 py-2 sm:grid-cols-[240px_1fr]">
                <span className="text-xs font-medium text-ink-muted">Likely cause</span>
                <span className="text-ink-soft">{diagnosis.cause}</span>
              </div>
            </div>
          ) : (
            <div className="border-b border-line px-4 py-2 text-xs text-ink-muted">
              {latest ? `No diagnosis yet for the week of ${latestLabel}.` : "No complete week yet."} {canEdit && latest ? "Use Run diagnosis now." : ""}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <Th className="sticky left-0 z-10 bg-sunken">Metric</Th>
                  <Th numeric>Target</Th>
                  {view.weeks.map((w) => (
                    <Th key={w.id} numeric title={`${weekLabel(w.startDate)} to ${weekLabel(addDays(w.startDate, 6))}`} className={cx(w.inProgress && "normal-case")}>
                      {w.inProgress ? (
                        <>
                          <span className="block">{weekLabel(w.startDate)}</span>
                          <span className="block font-normal tracking-normal">This week, so far</span>
                        </>
                      ) : (
                        weekLabel(w.startDate)
                      )}
                    </Th>
                  ))}
                  <Th numeric className="border-l border-line">
                    4-week average
                  </Th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <GroupRows key={g} group={g} rows={view.rows.filter((r) => r.def.group === g)} weeks={view.weeks} currency={cur} config={view.config} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-2xs text-ink-muted">
            <Legend tone="good" label="At or better than target" />
            <Legend tone="near" label="Within 15% of target" />
            <Legend tone="bad" label="More than 15% off target" />
            <Legend tone="muted" label="Too few to judge" />
            <span>
              Rates compare counts within the same week, so a rate can now and then go above 100% when deals close from earlier calls. The 4-week average leaves out the current week.
            </span>
          </div>
        </Card>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <CardHeader
            title={latestLabel ? `Week of ${latestLabel}: summary and fixes` : "Weekly summary"}
            description={
              diagnosis
                ? diagnosis.editedById
                  ? `Edited by ${nameOf(diagnosis.editedById) ?? "a teammate"}${diagnosis.editedAt ? `, ${dateTime(diagnosis.editedAt)}` : ""}`
                  : "Written by Claude from the last four weeks"
                : undefined
            }
            actions={diagnosis && canEdit && <EditDiagnosisDialog action={editDiagnosisAction.bind(null, slug, diagnosis.id)} initial={{ bottleneck: diagnosis.bottleneck, cause: diagnosis.cause, summary: diagnosis.summary }} />}
          />
          <div className="p-4">
            {diagnosis ? (
              <>
                <p className="whitespace-pre-line text-sm leading-relaxed text-ink-soft">{diagnosis.summary}</p>
                <h3 className="mb-1 mt-4 text-xs font-semibold text-ink">Fixes</h3>
                {diagnosis.fixes.length === 0 && carried.length === 0 && <p className="text-xs text-ink-muted">No fixes yet.</p>}
                <div className="divide-y divide-line">
                  {diagnosis.fixes.map((f) => (
                    <FixItem key={f.id} text={f.text} ownerRole={f.ownerRole} done={f.done} doneBy={nameOf(f.doneById)} action={toggleFixAction.bind(null, slug, f.id, !f.done)} canComplete={canComplete} />
                  ))}
                  {carried.map((f) => (
                    <FixItem key={f.id} text={f.text} ownerRole={f.ownerRole} done={f.done} from={weekLabel(f.diagnosis.week.startDate)} action={toggleFixAction.bind(null, slug, f.id, true)} canComplete={canComplete} />
                  ))}
                </div>
                {canEdit && <AddFixForm action={addFixAction.bind(null, slug, diagnosis.id)} />}
              </>
            ) : (
              <p className="text-sm text-ink-muted">The diagnosis runs every Monday. It names the single biggest bottleneck, the likely cause and one to three fixes, each with an owner.</p>
            )}
          </div>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Closed deals sent to ads" description="Won deals go back to the ad platform as offline conversions so it learns which clicks become clients." />
            <div className="space-y-2 p-4 text-sm">
              <div className="flex items-baseline justify-between">
                <span className="text-ink-muted">Won deals sent</span>
                <span className="tnum font-semibold">
                  {sentDeals} of {wonDeals}
                </span>
              </div>
              {lastSent?.conversionSentAt && <div className="text-xs text-ink-muted">Last sent {dateTime(lastSent.conversionSentAt)}</div>}
              {canEdit && <SendConversions action={syncConversionsAction.bind(null, slug)} pending={wonDeals - sentDeals} />}
            </div>
          </Card>

          <Card>
            <CardHeader title="Earlier diagnoses" />
            {history.length === 0 ? (
              <p className="p-4 text-xs text-ink-muted">None yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {history.map((h) => {
                  const done = h.fixes.filter((f) => f.done).length;
                  return (
                    <li key={h.id} className="px-4 py-2.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs font-medium text-ink-muted">Week of {weekLabel(h.week.startDate)}</span>
                        {h.fixes.length > 0 && (
                          <Badge tone={done === h.fixes.length ? "good" : "neutral"}>
                            {done} of {h.fixes.length} fixes done
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 text-sm text-ink">{h.bottleneck}</div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function Legend({ tone, label }: { tone: "good" | "near" | "bad" | "muted"; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cx("inline-block h-2.5 w-2.5 rounded-sm border border-line", CELL_TONE[tone])} />
      {label}
    </span>
  );
}

type View = Awaited<ReturnType<typeof scorecardView>>;

function GroupRows({ group, rows, weeks, currency, config }: { group: string; rows: View["rows"]; weeks: View["weeks"]; currency: string; config: View["config"] }) {
  return (
    <>
      <tr>
        <td colSpan={weeks.length + 3} className="sticky left-0 border-b border-line bg-sunken/40 px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-muted">
          {group}
        </td>
      </tr>
      {rows.map((r) => {
        const min = config[r.def.key]?.minSample ?? 0;
        return (
          <tr key={r.def.key} className="hover:bg-sunken/40">
            <Td className="sticky left-0 z-10 whitespace-nowrap bg-surface font-medium">{r.def.label}</Td>
            <Td numeric className="text-ink-muted">
              {r.target == null ? "" : fmtMetric(r.def.format, r.target, currency)}
            </Td>
            {r.weeks.map((c, j) => {
              const tone = colourTone(c.colour);
              const inProgress = weeks[j]?.inProgress;
              const title = inProgress ? "This week, so far. Not judged until the week ends." : c.colour === "grey" ? `Too few to judge: ${Math.round(c.sample)} against a minimum of ${min}` : undefined;
              return (
                <Td key={j} numeric title={title} className={cx(CELL_TONE[tone], inProgress && "italic text-ink-muted")}>
                  {fmtMetric(r.def.format, c.value, currency)}
                </Td>
              );
            })}
            <Td numeric className={cx("border-l border-line font-medium", CELL_TONE[colourTone(r.rolling.colour)])} title={r.rolling.colour === "grey" ? `Too few to judge: ${Math.round(r.rolling.sample)} against a minimum of ${min}` : undefined}>
              {fmtMetric(r.def.format, r.rolling.value, currency)}
            </Td>
          </tr>
        );
      })}
    </>
  );
}
