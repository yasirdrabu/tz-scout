"use client";

import { useState } from "react";
import { ActionForm, Dialog, SubmitButton } from "@/components/client";
import { Field } from "@/components/ui";
import type { FormAction } from "@/server/action";

type Sample = { label: string; email: string; firstName: string; lastName: string; title?: string | null; company?: string | null; timeline?: string | null; offering?: string | null; smsConsent: boolean; phone?: string | null };
type Values = { email: string; firstName: string; lastName: string; title: string; company: string; timeline: string; offering: string; smsConsent: boolean; phone: string };

const BLANK: Values = { email: "", firstName: "", lastName: "", title: "", company: "", timeline: "3m", offering: "", smsConsent: false, phone: "" };

const fromSample = (s: Sample): Values => ({
  email: s.email,
  firstName: s.firstName,
  lastName: s.lastName,
  title: s.title ?? "",
  company: s.company ?? "",
  timeline: s.timeline ?? "",
  offering: s.offering ?? "",
  smsConsent: s.smsConsent,
  phone: s.phone ?? (s.smsConsent ? "+1 555 010 0142" : ""),
});

/** Pick a sample person (or type your own) and submit it as if the website form was filled in. */
export function SimulateDialog({ action, samples, offerings, timelines, redirectTo }: { action: FormAction; samples: Sample[]; offerings: { slug: string; name: string; draft: boolean }[]; timelines: { value: string; label: string }[]; redirectTo: string }) {
  const [pick, setPick] = useState("0");
  const [v, setV] = useState<Values>(samples[0] ? fromSample(samples[0]) : BLANK);
  const set = (k: keyof Values) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV((x) => ({ ...x, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));

  return (
    <Dialog trigger="Simulate a form fill" title="Simulate a form fill" variant="primary" wide>
      {() => (
        <ActionForm action={action} redirectTo={redirectTo} className="space-y-4">
          <Field label="Start from" hint="Each sample takes a different path through the checks. Edit any field before submitting.">
            <select
              className="input"
              value={pick}
              onChange={(e) => {
                setPick(e.target.value);
                const s = samples[Number(e.target.value)];
                setV(e.target.value === "custom" || !s ? BLANK : fromSample(s));
              }}
            >
              {samples.map((s, i) => (
                <option key={s.label} value={String(i)}>
                  {s.label}: {s.firstName} {s.lastName}, {s.company}
                </option>
              ))}
              <option value="custom">Custom, start blank</option>
            </select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Work email" hint="If this address was used before, a short tag is added so the sample can run again." className="sm:col-span-2">
              <input name="email" type="email" required className="input" value={v.email} onChange={set("email")} />
            </Field>
            <Field label="First name">
              <input name="firstName" required className="input" value={v.firstName} onChange={set("firstName")} />
            </Field>
            <Field label="Last name">
              <input name="lastName" className="input" value={v.lastName} onChange={set("lastName")} />
            </Field>
            <Field label="Job title">
              <input name="title" className="input" value={v.title} onChange={set("title")} />
            </Field>
            <Field label="Company">
              <input name="company" className="input" value={v.company} onChange={set("company")} />
            </Field>
            <Field label="Timeline">
              <select name="timeline" className="input" value={v.timeline} onChange={set("timeline")}>
                <option value="">Not answered</option>
                {timelines.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Offering">
              <select name="offering" className="input" value={v.offering} onChange={set("offering")}>
                <option value="">None on the form</option>
                {offerings.map((o) => (
                  <option key={o.slug} value={o.slug}>
                    {o.name}
                    {o.draft ? " (draft)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Phone">
              <input name="phone" className="input" value={v.phone} onChange={set("phone")} />
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-ink-soft">
              <input type="checkbox" name="smsConsent" checked={v.smsConsent} onChange={set("smsConsent")} className="accent-accent" />
              Agreed to text message reminders
            </label>
          </div>
          <div className="flex items-center gap-3">
            <SubmitButton pendingText="Submitting...">Submit form</SubmitButton>
            <span className="text-xs text-ink-muted">The agent checks it in the background. You&apos;ll go to the lead to watch.</span>
          </div>
        </ActionForm>
      )}
    </Dialog>
  );
}

/** Book a meeting for a lead. The browser turns the local date and time into an exact instant. */
export function BookMeetingDialog({ action }: { action: FormAction }) {
  const [local, setLocal] = useState("");
  const iso = local ? new Date(local).toISOString() : "";
  const zone = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";
  return (
    <Dialog trigger="Book a meeting" title="Book a meeting">
      {(close) => (
        <ActionForm action={action} onDone={(r) => r.ok && close()} className="space-y-3">
          <Field label="Date and time" hint={zone ? `Your time zone: ${zone.replace(/_/g, " ")}.` : undefined}>
            <input type="datetime-local" required className="input" value={local} onChange={(e) => setLocal(e.target.value)} />
          </Field>
          <input type="hidden" name="scheduledAt" value={iso} />
          <Field label="Type">
            <select name="type" className="input" defaultValue="DISCOVERY">
              <option value="DISCOVERY">Discovery call</option>
              <option value="SALES">Sales call</option>
            </select>
          </Field>
          <p className="text-xs text-ink-muted">Sends a confirmation now and schedules the reminders and pre-call note.</p>
          <SubmitButton pendingText="Booking...">Book</SubmitButton>
        </ActionForm>
      )}
    </Dialog>
  );
}
