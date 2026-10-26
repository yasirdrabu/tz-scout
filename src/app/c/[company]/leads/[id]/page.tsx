import Link from "next/link";
import { notFound } from "next/navigation";
import type { LeadStatus } from "@prisma/client";
import { getCompanyContext } from "@/server/context";
import { effectiveStatus } from "@/server/leads";
import { CHECKS } from "@/lib/leadChecks";
import { Badge, Card, CardHeader, Field, KeyValue, Notice, PageHeader, cx } from "@/components/ui";
import { ActionButton, ActionForm, AutoRefresh, Disclosure, SubmitButton } from "@/components/client";
import { dateTime, relative } from "@/lib/format";
import { CHECK_LABEL, CHECK_TONE, LEAD_STATUS_LABEL, LEAD_STATUS_TONE, personName, timelineLabel } from "../labels";
import { BookMeetingDialog } from "../forms";
import { bookMeetingAction, overrideLeadAction, revalidateLeadAction } from "../actions";
import { MEETING_STATUS_LABEL, MEETING_STATUS_TONE, MEETING_TYPE_LABEL } from "../../meetings/labels";
import { OutcomeButtons } from "../../meetings/outcome-buttons";
import { TouchTimeline } from "../../meetings/touch-timeline";

export const metadata = { title: "Lead" };

const statusLabel = (s: unknown) => (typeof s === "string" && s in LEAD_STATUS_LABEL ? LEAD_STATUS_LABEL[s as LeadStatus] : String(s ?? ""));

export default async function LeadPage({ params }: { params: Promise<{ company: string; id: string }> }) {
  const { company: slug, id } = await params;
  const ctx = await getCompanyContext(slug);
  const lead = await ctx.db.lead.findUnique({
    where: { id },
    include: { offering: { select: { id: true, name: true } }, checks: true, submission: true, meetings: { orderBy: { scheduledAt: "desc" } }, touches: true },
  });
  if (!lead) notFound();
  const history = await ctx.db.auditLog.findMany({ where: { entity: "lead", entityId: id }, orderBy: { createdAt: "desc" }, take: 50 });
  const userIds = [...new Set([lead.ownerUserId, lead.overrideById, ...history.map((h) => h.userId)].filter((x): x is string => !!x))];
  const users = userIds.length ? await ctx.db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const userName = (uid: string | null | undefined) => (uid ? (users.find((u) => u.id === uid)?.name ?? "Someone") : null);

  const now = new Date();
  const st = effectiveStatus(lead);
  const checking = lead.status === "NEW" || lead.status === "VALIDATING";
  const dueSoon = lead.touches.some((t) => t.status === "SCHEDULED" && t.dueAt.getTime() - now.getTime() < 90_000);
  const name = personName(lead);
  const answers = lead.formAnswers && typeof lead.formAnswers === "object" && !Array.isArray(lead.formAnswers) ? Object.entries(lead.formAnswers as Record<string, unknown>) : [];
  const looseTouches = lead.touches.filter((t) => !t.meetingId);

  return (
    <>
      <AutoRefresh seconds={checking ? 3 : 10} active={checking || dueSoon} />
      <PageHeader
        eyebrow={
          <Link href={`/c/${slug}/leads`} className="hover:text-ink">
            Leads
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {name}
            <Badge tone={LEAD_STATUS_TONE[st]}>{LEAD_STATUS_LABEL[st]}</Badge>
            {lead.overrideStatus && <Badge tone="muted">Overridden</Badge>}
          </span>
        }
        description={[lead.title, lead.companyName, lead.email].filter(Boolean).join(" · ")}
        actions={
          <>
            {ctx.can("meeting.update") && !checking && <BookMeetingDialog action={bookMeetingAction.bind(null, slug, lead.id)} />}
            {ctx.can("lead.simulate") && !checking && (
              <ActionButton action={revalidateLeadAction.bind(null, slug, lead.id)} variant="ghost" pendingText="Queuing..." confirm="Run every check again? The agent's decision is replaced; an override stays in place.">
                Run checks again
              </ActionButton>
            )}
          </>
        }
      />

      {checking ? (
        <Notice className="mb-5" title="The agent is checking this lead">
          Results usually land within a minute. This page refreshes on its own.
        </Notice>
      ) : (
        <Notice tone={st === "VALIDATED" ? "good" : st === "NOT_QUALIFIED" ? "bad" : "near"} className="mb-5" title={lead.overrideStatus ? `Overridden to ${LEAD_STATUS_LABEL[lead.overrideStatus]}` : `Agent decision: ${LEAD_STATUS_LABEL[lead.status]}`}>
          {lead.overrideStatus ? (
            <>
              {userName(lead.overrideById) ?? "Someone"} on {dateTime(lead.overrideAt)}: {sentence(lead.overrideReason)} The agent had decided {LEAD_STATUS_LABEL[lead.status].toLowerCase()}: {lead.decisionReason}
            </>
          ) : (
            (lead.decisionReason ?? "No reason recorded.")
          )}
          {!lead.overrideStatus && lead.status === "NOT_QUALIFIED" && " Routed to nurture."}
        </Notice>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader title="Checks" description="All pass: validated. Any fail: not qualified. Any unknown: a person reviews it." />
            {lead.checks.length === 0 ? (
              <p className="px-4 py-4 text-sm text-ink-muted">{checking ? "Running now." : "No checks stored."}</p>
            ) : (
              <ul className="divide-y divide-line">
                {CHECKS.map((c) => {
                  const r = lead.checks.find((x) => x.check === c.key);
                  const evidence = r?.evidence && typeof r.evidence === "object" && !Array.isArray(r.evidence) ? Object.entries(r.evidence as Record<string, unknown>).filter(([k, v]) => k !== "value" && v != null) : [];
                  return (
                    <li key={c.key} className="flex items-start gap-3 px-4 py-2.5">
                      <div className="w-16 shrink-0 pt-0.5">{r ? <Badge tone={CHECK_TONE[r.result]}>{CHECK_LABEL[r.result]}</Badge> : <Badge tone="muted">Not run</Badge>}</div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-ink">{c.label}</div>
                        <div className="text-sm text-ink-soft">{r?.reason ?? "This check has not run."}</div>
                        {evidence.length > 0 && <div className="mt-0.5 text-2xs text-ink-muted">Evidence: {evidence.map(([k, v]) => `${k} ${formatValue(v)}`).join(", ")}</div>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Research note" description="Written by Claude from the company's website and company data." />
            <div className="whitespace-pre-line px-4 py-3 text-sm leading-relaxed text-ink-soft">{lead.researchNote ?? (checking ? "Writing now." : "No note was written.")}</div>
          </Card>

          <Card>
            <CardHeader title="Meetings and touches" description="Booking link, confirmation, reminders, pre-call note and rebook notes sent by the show-up agent." />
            {lead.meetings.length === 0 && looseTouches.length === 0 ? (
              <p className="px-4 py-4 text-sm text-ink-muted">{st === "VALIDATED" ? "The booking link goes out shortly." : "Only validated leads get a booking link."}</p>
            ) : (
              <div className="divide-y divide-line">
                {lead.meetings.map((m) => (
                  <div key={m.id}>
                    <div className="flex flex-wrap items-center gap-2 bg-sunken/40 px-4 py-2">
                      <Link href={`/c/${slug}/meetings/${m.id}`} className="text-sm font-medium text-ink hover:text-accent">
                        {MEETING_TYPE_LABEL[m.type]} call, {dateTime(m.scheduledAt)}
                      </Link>
                      <Badge tone={MEETING_STATUS_TONE[m.status]}>{MEETING_STATUS_LABEL[m.status]}</Badge>
                      <div className="ml-auto">
                        <OutcomeButtons slug={slug} meeting={m} canUpdate={ctx.can("meeting.update")} />
                      </div>
                    </div>
                    <TouchTimeline touches={lead.touches.filter((t) => t.meetingId === m.id)} now={now} />
                  </div>
                ))}
                {looseTouches.length > 0 && (
                  <div>
                    <div className="bg-sunken/40 px-4 py-2 text-sm font-medium text-ink">Before booking</div>
                    <TouchTimeline touches={looseTouches} now={now} />
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          {ctx.can("lead.override") && !checking && (
            <Card>
              <CardHeader title="Override" description="Your call replaces the agent's. The reason is logged." />
              <ActionForm action={overrideLeadAction.bind(null, slug, lead.id)} resetOnSuccess className="space-y-3 p-4">
                <div className="flex gap-4 text-sm">
                  {(["VALIDATED", "NOT_QUALIFIED"] as const).map((s) => (
                    <label key={s} className="flex items-center gap-1.5">
                      <input type="radio" name="status" value={s} required defaultChecked={s === (st === "VALIDATED" ? "NOT_QUALIFIED" : "VALIDATED")} className="accent-accent" />
                      {LEAD_STATUS_LABEL[s]}
                    </label>
                  ))}
                </div>
                <Field label="Reason">
                  <textarea name="reason" required rows={3} className="input" placeholder="What you know that the checks don't." />
                </Field>
                <p className="text-2xs text-ink-muted">Validating sends the booking link if it hasn&apos;t gone out yet.</p>
                <SubmitButton pendingText="Saving...">Save override</SubmitButton>
              </ActionForm>
            </Card>
          )}

          <Card>
            <CardHeader title="Details" />
            <div className="p-4">
              <KeyValue
                items={[
                  ["Owner", userName(lead.ownerUserId) ?? <span className="text-ink-muted">Unassigned</span>],
                  ["Offering", lead.offering ? lead.offering.name : <span className="text-ink-muted">None on the form</span>],
                  ["HubSpot", lead.hubspotContactId ? <span>Linked in HubSpot <span className="font-mono text-xs text-ink-muted">{lead.hubspotContactId}</span></span> : <span className="text-ink-muted">Not linked yet</span>],
                  ["Submitted", <span key="s" title={relative(lead.submittedAt, now)}>{dateTime(lead.submittedAt)}</span>],
                  ["Checked", lead.validatedAt ? <span title={relative(lead.validatedAt, now)}>{dateTime(lead.validatedAt)}</span> : <span className="text-ink-muted">Not yet</span>],
                  ["Source", lead.submission?.source === "manual" ? "Simulated" : lead.submission?.source === "hubspot" ? "HubSpot form" : lead.submission?.source === "webhook" ? "Website form" : "Imported"],
                ]}
              />
            </div>
          </Card>

          <Card>
            <CardHeader title="Form answers" />
            <div className="space-y-3 p-4">
              <KeyValue
                items={[
                  ["Email", lead.email],
                  ["Name", name],
                  ["Job title", lead.title ?? <span className="text-ink-muted">Not given</span>],
                  ["Company", lead.companyName ?? <span className="text-ink-muted">Not given</span>],
                  ["Timeline", timelineLabel(lead.timelineAnswer) ?? <span className="text-ink-muted">Not answered</span>],
                  ["Phone", lead.phone ?? <span className="text-ink-muted">Not given</span>],
                  ["Text reminders", lead.smsConsent ? "Agreed" : "Not agreed"],
                  ...answers.map(([k, v]) => [k, formatValue(v)] as [string, string]),
                ]}
              />
              {lead.submission && (
                <Disclosure summary={<span className="text-xs">Raw submission</span>}>
                  <pre className="max-h-64 overflow-auto rounded border border-line bg-sunken/50 p-2 font-mono text-2xs text-ink-soft">{JSON.stringify(lead.submission.payload, null, 2)}</pre>
                </Disclosure>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Decision history" description="The agent's decisions and every override, newest first." />
            {history.length === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-muted">Nothing logged yet.</p>
            ) : (
              <ol className="divide-y divide-line">
                {history.map((h) => {
                  const d = (h.data ?? {}) as Record<string, unknown>;
                  const who = userName(h.userId);
                  return (
                    <li key={h.id} className="px-4 py-2.5 text-sm">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={cx("font-medium", h.action === "lead.override" ? "text-ink" : "text-ink-soft")}>
                          {h.action === "lead.validated"
                            ? `Agent decided ${statusLabel(d.status).toLowerCase()}`
                            : h.action === "lead.override"
                              ? `${who ?? "Someone"} overrode to ${statusLabel(d.to).toLowerCase()}`
                              : h.action === "lead.recheck"
                                ? `${who ?? "Someone"} ran the checks again`
                                : h.action}
                        </span>
                        <span className="tnum shrink-0 text-2xs text-ink-muted" title={dateTime(h.createdAt)}>
                          {relative(h.createdAt, now)}
                        </span>
                      </div>
                      {h.action === "lead.override" && (
                        <div className="text-xs text-ink-soft">
                          From {statusLabel(d.from).toLowerCase()}. {sentence(String(d.reason ?? ""))}
                        </div>
                      )}
                      {h.action === "lead.validated" && typeof d.reason === "string" && <div className="text-xs text-ink-muted">{d.reason}</div>}
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

function formatValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function sentence(s: string | null | undefined): string {
  const t = (s ?? "").trim();
  return !t || /[.!?]$/.test(t) ? t : `${t}.`;
}
