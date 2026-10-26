// Account page: the discovery call plan, and reviews of calls that happened.

import { ActionButton, ActionForm, SubmitButton } from "@/components/client";
import { Badge, Card, CardHeader } from "@/components/ui";
import { relative } from "@/lib/format";
import { QUALIFICATION, QUAL_STATUS_LABEL, qualificationScore, type QualificationStatus } from "@/lib/qualification";
import type { CallPrep } from "@/ai/callPrep";
import type { CallReviewOutput } from "@/ai/callReview";
import type { FormAction } from "@/server/action";
import { CopyButton } from "./controls";

const STATUS_TONE: Record<QualificationStatus, "good" | "near" | "bad"> = { met: "good", partial: "near", missing: "bad" };
const label = (k: string) => QUALIFICATION.find((q) => q.key === k)?.label ?? k;

export function CallPrepCard({ prep, preparedAt, offerName, prepareAction, canAct }: { prep: CallPrep | null; preparedAt: Date | null; offerName: string | null; prepareAction: FormAction; canAct: boolean }) {
  return (
    <Card>
      <CardHeader
        title="Call prep"
        description={prep && preparedAt ? `Discovery call plan for ${offerName ?? "the best offer"}, ${relative(preparedAt)}.` : "A discovery call plan built from the signals, the offer and the brief: questions in order, what to listen for, objections, proof and the next step to ask for."}
        actions={
          canAct ? (
            <ActionButton action={prepareAction} size="sm" pendingText="Preparing...">
              {prep ? "Rebuild" : "Prepare the call"}
            </ActionButton>
          ) : undefined
        }
      />
      {prep && (
        <div className="space-y-4 p-4 text-sm">
          <Part label="Goal of the call">{prep.objective}</Part>
          <Part label="Open with">{prep.opening}</Part>
          <div>
            <PartLabel>Questions, in order</PartLabel>
            <ol className="list-decimal space-y-1.5 pl-5">
              {prep.questions.map((q) => (
                <li key={q.question}>
                  <span className="text-ink">{q.question}</span>
                  <div className="text-xs text-ink-muted">{q.why}</div>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <PartLabel>Listen for</PartLabel>
            <ul className="divide-y divide-line rounded border border-line">
              {prep.listenFor.map((l) => (
                <li key={l.key} className="grid gap-1 px-3 py-1.5 sm:grid-cols-[12rem_1fr]">
                  <span className="text-xs font-medium text-ink">{label(l.key)}</span>
                  <span className="text-xs text-ink-soft">{l.lookFor}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <PartLabel>Likely objections</PartLabel>
            <ul className="space-y-1.5">
              {prep.objections.map((o) => (
                <li key={o.objection}>
                  <span className="font-medium text-ink">&ldquo;{o.objection}&rdquo;</span> <span className="text-ink-soft">{o.answer}</span>
                </li>
              ))}
            </ul>
          </div>
          {prep.proof.length > 0 && (
            <div>
              <PartLabel>Proof to bring up</PartLabel>
              <ul className="list-disc space-y-0.5 pl-5 text-ink-soft">
                {prep.proof.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          <Part label="Ask for">{prep.nextStepAsk}</Part>
          <div>
            <PartLabel>Red flags</PartLabel>
            <ul className="list-disc space-y-0.5 pl-5 text-ink-soft">
              {prep.redFlags.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Card>
  );
}

export function CallsCard({
  reviews,
  reviewAction,
  pushAction,
  canAct,
  pushed,
}: {
  reviews: { id: string; title: string; heldAt: Date; source: string; review: CallReviewOutput; hubspotNoteId: string | null; createdBy: string | null }[];
  reviewAction: FormAction;
  pushAction: (id: string) => FormAction;
  canAct: boolean;
  pushed: boolean;
}) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Card>
      <CardHeader title="Calls" description="Paste a transcript or a Fathom recap after a call. It's scored against the qualification checklist, with next steps and a follow-up email, and can be added to HubSpot." />
      <div className="space-y-4 p-4">
        {reviews.map((c) => {
          const r = c.review;
          const score = qualificationScore(r.qualification);
          return (
            <details key={c.id} className="group rounded border border-line" open={c === reviews[0]}>
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span>
                  <span className="font-medium text-ink">{c.title}</span> <span className="text-ink-muted">· {c.heldAt.toISOString().slice(0, 10)}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="tnum text-xs text-ink-muted">Qualified {score}%</span>
                  <Badge tone={r.recommendedStatus === "QUALIFIED" ? "good" : r.recommendedStatus === "DISQUALIFIED" ? "bad" : "neutral"}>{r.recommendedStatus === "QUALIFIED" ? "Looks qualified" : r.recommendedStatus === "DISQUALIFIED" ? "Not a fit" : "Keep working"}</Badge>
                </span>
              </summary>
              <div className="space-y-3 border-t border-line px-3 py-3 text-sm">
                <p className="text-ink-soft">{r.summary}</p>
                <ul className="divide-y divide-line rounded border border-line">
                  {r.qualification.map((q) => (
                    <li key={q.key} className="grid gap-1 px-3 py-1.5 sm:grid-cols-[12rem_6rem_1fr]">
                      <span className="text-xs font-medium text-ink">{label(q.key)}</span>
                      <span>
                        <Badge tone={STATUS_TONE[q.status]}>{QUAL_STATUS_LABEL[q.status]}</Badge>
                      </span>
                      <span className="text-xs text-ink-soft">{q.evidence}</span>
                    </li>
                  ))}
                </ul>
                {r.pains.length > 0 && (
                  <div>
                    <PartLabel>Their pains, in their words</PartLabel>
                    <ul className="list-disc space-y-0.5 pl-5 text-ink-soft">
                      {r.pains.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div>
                  <PartLabel>Next steps</PartLabel>
                  <ul className="list-disc space-y-0.5 pl-5 text-ink-soft">
                    {r.nextSteps.map((n) => (
                      <li key={n.action}>
                        <span className="font-medium text-ink">{n.owner === "us" ? "Us" : "Them"}:</span> {n.action}
                        {n.due ? ` (by ${n.due})` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
                {r.coaching.length > 0 && (
                  <div>
                    <PartLabel>Next time</PartLabel>
                    <ul className="list-disc space-y-0.5 pl-5 text-ink-soft">
                      {r.coaching.map((x) => (
                        <li key={x}>{x}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <PartLabel>Follow-up email</PartLabel>
                    <CopyButton text={r.followUpEmail} label="Copy email" />
                  </div>
                  <div className="whitespace-pre-line rounded border border-line bg-sunken/50 px-3 py-2 text-ink">{r.followUpEmail}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                  {canAct && pushed && (
                    <ActionButton action={pushAction(c.id)} size="sm" pendingText="Adding...">
                      {c.hubspotNoteId ? "Update in HubSpot" : "Add to HubSpot"}
                    </ActionButton>
                  )}
                  {!pushed && <span>Push the account to HubSpot to add calls to it.</span>}
                  <span>
                    {c.source === "fathom" ? "From Fathom" : "Pasted"}
                    {c.createdBy ? ` by ${c.createdBy}` : ""}
                  </span>
                </div>
              </div>
            </details>
          );
        })}

        {canAct && (
          <ActionForm action={reviewAction} className="space-y-2 rounded border border-dashed border-line-strong p-3">
            <div className="text-xs font-medium text-ink">Review a call</div>
            <div className="flex flex-wrap gap-2">
              <input name="title" className="input h-8 w-56 py-0 text-xs" placeholder="Discovery call" aria-label="Call title" />
              <input name="heldAt" type="date" defaultValue={today} className="input h-8 py-0 text-xs" aria-label="Date of the call" />
              <select name="source" className="input h-8 py-0 text-xs" defaultValue="pasted" aria-label="Where it came from">
                <option value="pasted">Transcript or notes</option>
                <option value="fathom">Fathom recap</option>
              </select>
            </div>
            <textarea name="transcript" rows={6} className="input w-full text-xs" placeholder="Paste the transcript, or the Fathom recap email, here." />
            <SubmitButton size="sm" pendingText="Reviewing...">
              Review the call
            </SubmitButton>
          </ActionForm>
        )}
      </div>
    </Card>
  );
}

function PartLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-muted">{children}</div>;
}

function Part({ label: l, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <PartLabel>{l}</PartLabel>
      <p className="text-ink">{children}</p>
    </div>
  );
}
