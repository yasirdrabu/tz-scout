import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/context";
import { Badge, Card, CardHeader, KeyValue, Notice, PageHeader } from "@/components/ui";
import { AutoRefresh } from "@/components/client";
import { dateTime, relative } from "@/lib/format";
import { MEETING_STATUS_LABEL, MEETING_STATUS_TONE, MEETING_TYPE_LABEL } from "../labels";
import { OutcomeButtons } from "../outcome-buttons";
import { TouchTimeline } from "../touch-timeline";

export const metadata = { title: "Meeting" };

export default async function MeetingPage({ params }: { params: Promise<{ company: string; id: string }> }) {
  const { company: slug, id } = await params;
  const ctx = await getCompanyContext(slug);
  const m = await ctx.db.meeting.findUnique({ where: { id }, include: { lead: true, caseStudy: true, touches: true } });
  if (!m) notFound();
  const [rebookOf, rebookedAs] = await Promise.all([
    m.rebookOfId ? ctx.db.meeting.findUnique({ where: { id: m.rebookOfId }, select: { id: true, scheduledAt: true, status: true } }) : null,
    ctx.db.meeting.findMany({ where: { rebookOfId: m.id }, select: { id: true, scheduledAt: true, status: true }, orderBy: { scheduledAt: "asc" } }),
  ]);
  const now = new Date();
  const name = `${m.lead.firstName} ${m.lead.lastName}`.trim();
  const canUpdate = ctx.can("meeting.update");
  const pastAndOpen = m.status === "BOOKED" && m.scheduledAt <= now;
  const dueSoon = m.touches.some((t) => t.status === "SCHEDULED" && t.dueAt.getTime() - now.getTime() < 90_000);

  return (
    <>
      <AutoRefresh seconds={10} active={dueSoon} />
      <PageHeader
        eyebrow={
          <Link href={`/c/${slug}/meetings`} className="hover:text-ink">
            Meetings
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {MEETING_TYPE_LABEL[m.type]} call with {name}
            <Badge tone={MEETING_STATUS_TONE[m.status]}>{MEETING_STATUS_LABEL[m.status]}</Badge>
          </span>
        }
        description={`${dateTime(m.scheduledAt)} (${relative(m.scheduledAt, now)})`}
        actions={<OutcomeButtons slug={slug} meeting={m} canUpdate={canUpdate} size="md" />}
      />
      {pastAndOpen && canUpdate && (
        <Notice tone="near" className="mb-5" title="Log the outcome">
          This call&apos;s time has passed. Mark it held, a no-show or cancelled. A no-show starts the rebook sequence on its own.
        </Notice>
      )}
      {m.status === "NO_SHOW" && (
        <Notice className="mb-5" title="Rebook sequence running">
          The lead gets the rebook notes below. When they pick a new time, this meeting is marked rebooked and the remaining notes stop.
        </Notice>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader title="Touches" description="Confirmation, reminders, pre-call note and rebook notes for this meeting." />
          <TouchTimeline touches={m.touches} now={now} />
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Details" />
            <div className="p-4">
              <KeyValue
                items={[
                  [
                    "Lead",
                    <Link key="l" href={`/c/${slug}/leads/${m.lead.id}`} className="link">
                      {name}
                    </Link>,
                  ],
                  ["Company", m.lead.companyName ?? "Unknown"],
                  ["Title", m.lead.title ?? "Not given"],
                  ["Type", MEETING_TYPE_LABEL[m.type]],
                  ["Scheduled", dateTime(m.scheduledAt)],
                  ["Booked", dateTime(m.bookedAt)],
                  ["Held", m.heldAt ? dateTime(m.heldAt) : "Not yet"],
                  ["HubSpot", m.hubspotMeetingId ? <span key="h">Linked in HubSpot <span className="font-mono text-xs text-ink-muted">{m.hubspotMeetingId}</span></span> : <span key="h" className="text-ink-muted">Not linked</span>],
                ]}
              />
            </div>
          </Card>

          <Card>
            <CardHeader title="Matched case study" description="Sent in the pre-call note. Matched by industry." />
            <div className="p-4 text-sm">
              {m.caseStudy ? (
                <>
                  <div className="font-medium text-ink">{m.caseStudy.client}</div>
                  <div className="text-xs text-ink-muted">
                    {m.caseStudy.title} · {m.caseStudy.industry}
                  </div>
                  <p className="mt-2 text-ink-soft">{m.caseStudy.result}</p>
                  {m.caseStudy.link && (
                    <a href={m.caseStudy.link} target="_blank" rel="noreferrer" className="link mt-1 inline-block text-xs">
                      Open case study
                    </a>
                  )}
                </>
              ) : (
                <p className="text-ink-muted">No case study is linked to this lead&apos;s offering, so no pre-call note was sent.</p>
              )}
            </div>
          </Card>

          {(rebookOf || rebookedAs.length > 0) && (
            <Card>
              <CardHeader title="Rebook chain" />
              <ul className="space-y-1.5 p-4 text-sm">
                {rebookOf && (
                  <li>
                    Rebooked from{" "}
                    <Link href={`/c/${slug}/meetings/${rebookOf.id}`} className="link">
                      {dateTime(rebookOf.scheduledAt)}
                    </Link>{" "}
                    <Badge tone={MEETING_STATUS_TONE[rebookOf.status]}>{MEETING_STATUS_LABEL[rebookOf.status]}</Badge>
                  </li>
                )}
                {rebookedAs.map((r) => (
                  <li key={r.id}>
                    Rebooked as{" "}
                    <Link href={`/c/${slug}/meetings/${r.id}`} className="link">
                      {dateTime(r.scheduledAt)}
                    </Link>{" "}
                    <Badge tone={MEETING_STATUS_TONE[r.status]}>{MEETING_STATUS_LABEL[r.status]}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
