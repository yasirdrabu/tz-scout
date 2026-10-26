import type { ReactNode } from "react";
import { unscopedDb, scopedDb } from "@/lib/db";
import { effectiveStatus } from "@/server/leads";
import { ActionButton } from "@/components/client";
import { BOOKING_TZ_LABEL, bookingSlots, formatBooked } from "./slots";
import { bookSlotAction } from "./actions";

export const metadata = { title: "Book a time", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function BookPage({ params }: { params: Promise<{ company: string; leadId: string }> }) {
  const { company: slug, leadId } = await params;
  const company = await unscopedDb.company.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!company) return <Inactive />;
  const db = scopedDb(company.id);
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true, firstName: true, status: true, overrideStatus: true } });
  if (!lead || effectiveStatus(lead) !== "VALIDATED") return <Inactive companyName={company.name} />;

  const now = new Date();
  const upcoming = await db.meeting.findFirst({ where: { leadId: lead.id, status: "BOOKED", scheduledAt: { gt: now } }, orderBy: { scheduledAt: "asc" }, select: { scheduledAt: true } });

  if (upcoming) {
    return (
      <Shell companyName={company.name}>
        <h1 className="text-lg font-semibold text-ink">You&apos;re booked for {formatBooked(upcoming.scheduledAt)}</h1>
        <p className="mt-2 text-sm text-ink-soft">Thanks, {lead.firstName}. A confirmation is on its way to your inbox, and we&apos;ll send a reminder before we talk. Need a different time? Reply to the confirmation and we&apos;ll sort it out.</p>
      </Shell>
    );
  }

  const days = bookingSlots(now);
  return (
    <Shell companyName={company.name}>
      <h1 className="text-lg font-semibold text-ink">Pick a time to talk, {lead.firstName}</h1>
      <p className="mt-1 text-sm text-ink-soft">A 30 minute call with the {company.name} team. All times are {BOOKING_TZ_LABEL}.</p>
      <div className="mt-5 space-y-4">
        {days.map((d) => (
          <div key={d.day}>
            <div className="mb-1.5 text-xs font-medium text-ink-muted">{d.day}</div>
            <div className="flex flex-wrap gap-2">
              {d.slots.map((s) => (
                <ActionButton key={s.iso} action={bookSlotAction.bind(null, slug, lead.id)} fields={{ slot: s.iso }} pendingText="Booking...">
                  {s.time}
                </ActionButton>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Shell>
  );
}

function Shell({ companyName, children }: { companyName?: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-start justify-center bg-canvas px-4 py-16">
      <div className="w-full max-w-lg">
        {companyName && <div className="mb-3 text-sm font-semibold tracking-tight text-accent">{companyName}</div>}
        <div className="rounded-lg border border-line bg-surface p-6 shadow-card">{children}</div>
      </div>
    </main>
  );
}

function Inactive({ companyName }: { companyName?: string }) {
  return (
    <Shell companyName={companyName}>
      <h1 className="text-lg font-semibold text-ink">This link is no longer active</h1>
      <p className="mt-2 text-sm text-ink-soft">If you&apos;d still like to talk, reply to the email that brought you here and we&apos;ll find a time.</p>
    </Shell>
  );
}
