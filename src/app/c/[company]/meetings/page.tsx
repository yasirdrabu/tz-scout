import Link from "next/link";
import type { MeetingType, Prisma } from "@prisma/client";
import { getCompanyContext } from "@/server/context";
import { getSettings } from "@/server/settings";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Table, Tabs, Td, Th, cx } from "@/components/ui";
import { date, dateTime, num, pct, relative } from "@/lib/format";
import { MEETING_STATUS_LABEL, MEETING_STATUS_TONE, MEETING_TYPE_LABEL } from "./labels";
import { OutcomeButtons } from "./outcome-buttons";
import { lastCompleteWeeks } from "./show-up";

export const metadata = { title: "Meetings" };

const TABS = [
  { key: "upcoming", label: "Upcoming" },
  { key: "needs_outcome", label: "Needs outcome" },
  { key: "all", label: "All recent" },
] as const;
type Tab = (typeof TABS)[number]["key"];
const LIMIT = 100;

export default async function MeetingsPage({ params, searchParams }: { params: Promise<{ company: string }>; searchParams: Promise<{ tab?: string; type?: string }> }) {
  const { company: slug } = await params;
  const sp = await searchParams;
  const ctx = await getCompanyContext(slug);
  const now = new Date();
  const type: MeetingType | null = sp.type === "DISCOVERY" || sp.type === "SALES" ? sp.type : null;
  const typeWhere: Prisma.MeetingWhereInput = type ? { type } : {};

  const whereFor: Record<Tab, Prisma.MeetingWhereInput> = {
    upcoming: { ...typeWhere, status: "BOOKED", scheduledAt: { gte: now } },
    needs_outcome: { ...typeWhere, status: "BOOKED", scheduledAt: { lt: now } },
    all: typeWhere,
  };
  const [upcomingCount, needsCount, allCount] = await Promise.all([ctx.db.meeting.count({ where: whereFor.upcoming }), ctx.db.meeting.count({ where: whereFor.needs_outcome }), ctx.db.meeting.count({ where: whereFor.all })]);
  const counts: Record<Tab, number> = { upcoming: upcomingCount, needs_outcome: needsCount, all: allCount };
  const tab: Tab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as Tab) : needsCount > 0 ? "needs_outcome" : "upcoming";

  const meetings = await ctx.db.meeting.findMany({
    where: whereFor[tab],
    orderBy: { scheduledAt: tab === "upcoming" ? "asc" : "desc" },
    take: LIMIT,
    include: { lead: { select: { id: true, firstName: true, lastName: true, companyName: true, title: true } }, caseStudy: { select: { client: true, industry: true } }, touches: { select: { status: true } } },
  });
  const [showUp, settings] = await Promise.all([lastCompleteWeeks(ctx.db, 8, now), getSettings(ctx.db)]);
  const seq = settings.sequence;
  const canUpdate = ctx.can("meeting.update");

  const href = (t: Tab, ty: MeetingType | null = type) => `/c/${slug}/meetings?tab=${t}${ty ? `&type=${ty}` : ""}`;

  return (
    <>
      <PageHeader title="Meetings" description="Discovery and sales calls booked by validated leads. The show-up agent sends the confirmation, reminders and pre-call note, and rebooks no-shows." />

      <Tabs current={tab} items={TABS.map((t) => ({ key: t.key, label: t.label, href: href(t.key), count: counts[t.key] }))} />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 text-xs">
          <span className="mr-1 text-ink-muted">Type</span>
          {([null, "DISCOVERY", "SALES"] as const).map((ty) => (
            <Link key={ty ?? "any"} href={href(tab, ty)} className={cx("rounded border px-2 py-0.5", type === ty ? "border-accent-line bg-accent-soft text-accent-ink" : "border-line text-ink-soft hover:bg-sunken")}>
              {ty ? MEETING_TYPE_LABEL[ty] : "All types"}
            </Link>
          ))}
        </div>
        {canUpdate && <p className="text-xs text-ink-muted">Marking a no-show starts the rebook sequence on its own: {seq.rebookDays.length} notes over {Math.max(0, ...seq.rebookDays)} days.</p>}
      </div>

      {meetings.length === 0 ? (
        <EmptyState title={tab === "needs_outcome" ? "Every past meeting has an outcome" : tab === "upcoming" ? "No upcoming meetings" : "No meetings yet"}>
          {tab === "upcoming" ? "Validated leads get a booking link. Their meetings show up here once booked." : "Meetings appear here as validated leads book them."}
        </EmptyState>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Scheduled</Th>
                <Th>Lead</Th>
                <Th>Company</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Case study</Th>
                <Th numeric title="Touches sent">Sent</Th>
                <Th numeric title="Touches still scheduled">Scheduled</Th>
                {canUpdate && tab !== "all" && <Th className="text-right">Outcome</Th>}
                {canUpdate && tab === "all" && <Th />}
              </tr>
            </thead>
            <tbody>
              {meetings.map((m) => {
                const sent = m.touches.filter((t) => t.status === "SENT").length;
                const pending = m.touches.filter((t) => t.status === "SCHEDULED").length;
                return (
                  <tr key={m.id} className="hover:bg-sunken/50">
                    <Td className="whitespace-nowrap">
                      <Link href={`/c/${slug}/meetings/${m.id}`} className="font-medium text-ink hover:text-accent">
                        {dateTime(m.scheduledAt)}
                      </Link>
                      <div className="text-2xs text-ink-muted">{relative(m.scheduledAt, now)}</div>
                    </Td>
                    <Td>
                      <Link href={`/c/${slug}/leads/${m.lead.id}`} className="link">
                        {`${m.lead.firstName} ${m.lead.lastName}`.trim()}
                      </Link>
                      {m.lead.title && <div className="text-2xs text-ink-muted">{m.lead.title}</div>}
                    </Td>
                    <Td className="text-ink-soft">{m.lead.companyName ?? "Unknown"}</Td>
                    <Td className="text-ink-soft">{MEETING_TYPE_LABEL[m.type]}</Td>
                    <Td>
                      <Badge tone={MEETING_STATUS_TONE[m.status]}>{MEETING_STATUS_LABEL[m.status]}</Badge>
                    </Td>
                    <Td className="text-ink-soft">{m.caseStudy ? m.caseStudy.client : <span className="text-ink-faint">None</span>}</Td>
                    <Td numeric>{sent}</Td>
                    <Td numeric>{pending}</Td>
                    {canUpdate && (
                      <Td className="whitespace-nowrap">
                        <OutcomeButtons slug={slug} meeting={m} canUpdate={canUpdate} />
                      </Td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {counts[tab] > meetings.length && <p className="px-4 py-2 text-xs text-ink-muted">Showing the {meetings.length} {tab === "upcoming" ? "soonest" : "most recent"} of {num(counts[tab])} meetings.</p>}
        </Card>
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader title="Show-up rate by week" description="Last 8 complete weeks, Monday start. These rates feed the funnel model and the weekly scorecard." />
          <Table>
            <thead>
              <tr>
                <Th>Week of</Th>
                <Th numeric>Discovery booked</Th>
                <Th numeric>Held</Th>
                <Th numeric>Show-up</Th>
                <Th numeric>Sales booked</Th>
                <Th numeric>Held</Th>
                <Th numeric>Show-up</Th>
              </tr>
            </thead>
            <tbody>
              {showUp.rows.map((r) => (
                <tr key={r.week}>
                  <Td className="whitespace-nowrap">{date(r.week, { month: "short", day: "numeric", year: "numeric" })}</Td>
                  <Td numeric>{r.discovery.booked}</Td>
                  <Td numeric>{r.discovery.held}</Td>
                  <Td numeric className="font-medium">{pct(r.discovery.rate, 0)}</Td>
                  <Td numeric>{r.sales.booked}</Td>
                  <Td numeric>{r.sales.held}</Td>
                  <Td numeric className="font-medium">{pct(r.sales.rate, 0)}</Td>
                </tr>
              ))}
              <tr className="bg-sunken/40">
                <Td className="font-medium">8 weeks</Td>
                <Td numeric>{showUp.total.discovery.booked}</Td>
                <Td numeric>{showUp.total.discovery.held}</Td>
                <Td numeric className="font-semibold">{pct(showUp.total.discovery.rate, 0)}</Td>
                <Td numeric>{showUp.total.sales.booked}</Td>
                <Td numeric>{showUp.total.sales.held}</Td>
                <Td numeric className="font-semibold">{pct(showUp.total.sales.rate, 0)}</Td>
              </tr>
            </tbody>
          </Table>
          <p className="px-4 py-2 text-2xs text-ink-muted">Booked counts meetings whose time has passed: held, no-show or rebooked. Cancelled meetings are left out.</p>
        </Card>

        <Card className="self-start">
          <CardHeader
            title="Sequence timing"
            description="Set for this company."
            actions={
              <Link href={`/c/${slug}/settings?tab=sequence`} className="link text-xs">
                Change in Settings
              </Link>
            }
          />
          <ul className="space-y-2 p-4 text-sm text-ink-soft">
            <li>
              <span className="font-medium text-ink">Booking link</span> {seq.bookingLinkDelayMinutes > 0 ? `${seq.bookingLinkDelayMinutes} minutes after a lead is validated.` : "as soon as a lead is validated."}
            </li>
            <li>
              <span className="font-medium text-ink">Confirmation</span> right after booking.
            </li>
            <li>
              <span className="font-medium text-ink">Reminders</span> {seq.reminderHours.length ? `${listHours(seq.reminderHours)} before the call, by email${seq.smsReminders ? " and by text message when the lead agreed to texts." : "."}` : "turned off."}
            </li>
            <li>
              <span className="font-medium text-ink">Pre-call note</span> with one case study matched by industry, a day before.
            </li>
            <li>
              <span className="font-medium text-ink">No-show rebook</span> {seq.rebookDays.length ? `${seq.rebookDays.length} notes on ${listDays(seq.rebookDays)}.` : "turned off."}
            </li>
          </ul>
        </Card>
      </div>
    </>
  );
}

function joinList(items: string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function listHours(hours: number[]) {
  const sorted = [...hours].sort((a, b) => b - a);
  return `${joinList(sorted.map(String))} hour${sorted.length === 1 && sorted[0] === 1 ? "" : "s"}`;
}

function listDays(days: number[]) {
  return `day${days.length === 1 ? "" : "s"} ${joinList([...days].sort((a, b) => a - b).map(String))}`;
}
