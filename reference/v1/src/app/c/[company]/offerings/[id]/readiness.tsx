// Offer readiness card: the score, both halves, each factor with its reason and where it came from,
// what to fix, and a way to set a factor by hand.

import { ActionButton, ActionForm, SubmitButton } from "@/components/client";
import { Badge, Bar, Card, CardHeader } from "@/components/ui";
import { relative } from "@/lib/format";
import { BAND_HELP, BAND_LABEL, READINESS_FACTORS, type Readiness, type ReadinessBand, type ReadinessSource } from "@/lib/offerReadiness";
import type { FormAction } from "@/server/action";

export const BAND_TONE: Record<ReadinessBand, "good" | "near" | "bad"> = { ready: "good", fix_first: "near", rework: "bad" };
const SOURCE_LABEL: Record<ReadinessSource, string> = { data: "Measured", ai: "Claude", rules: "Rules", override: "Set by hand" };

export function ReadinessCard({ readiness, scoreAction, overrideAction, canEdit }: { readiness: Readiness | null; scoreAction: FormAction; overrideAction: FormAction; canEdit: boolean }) {
  const r = readiness;
  return (
    <Card className="mb-5">
      <CardHeader
        title="Offer readiness"
        description="Is this offer strong enough, and is there enough pull in the market, to put reps and budget behind it? Market pull is measured from our accounts; offer strength is judged."
        actions={
          canEdit ? (
            <ActionButton action={scoreAction} size="sm" pendingText="Scoring...">
              {r ? "Rescore" : "Score this offer"}
            </ActionButton>
          ) : undefined
        }
      />
      {!r ? (
        <p className="px-4 py-4 text-sm text-ink-muted">Not scored yet.</p>
      ) : (
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <div>
              <span className="tnum text-3xl font-semibold text-ink">{r.score}</span>
              <span className="text-sm text-ink-muted"> of 100</span>
            </div>
            <div>
              <Badge tone={BAND_TONE[r.band]}>{BAND_LABEL[r.band]}</Badge>
              <p className="mt-1 text-xs text-ink-muted">{BAND_HELP[r.band]}</p>
            </div>
            <div className="text-xs text-ink-muted">
              Offer strength <span className="tnum font-medium text-ink">{r.offerScore}</span> of 60 · Market pull <span className="tnum font-medium text-ink">{r.marketScore}</span> of 40 · scored {relative(new Date(r.at))}
            </div>
          </div>

          {r.fixes.length > 0 && (
            <div className="rounded border border-near/40 bg-near/10 px-3 py-2">
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-muted">What to fix first</div>
              <ul className="list-disc space-y-0.5 pl-4 text-sm text-ink">
                {r.fixes.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          {(["offer", "market"] as const).map((g) => (
            <div key={g}>
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-muted">{g === "offer" ? "Offer strength" : "Market pull"}</div>
              <ul className="divide-y divide-line rounded border border-line">
                {r.factors
                  .filter((f) => f.group === g)
                  .map((f) => (
                    <li key={f.key} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 px-3 py-2 sm:grid-cols-[14rem_1fr_auto]">
                      <div>
                        <div className="text-sm font-medium text-ink">{f.label}</div>
                        <Bar value={f.value} max={10} tone={f.value >= 7 ? "good" : f.value >= 5 ? "near" : "bad"} className="mt-1 h-1" />
                      </div>
                      <div className="text-xs text-ink-soft sm:order-none">
                        {f.reason}
                        {f.override?.note ? <span className="text-ink-muted"> · Set by hand: {f.override.note}</span> : null}
                      </div>
                      <div className="text-right">
                        <div className="tnum text-sm text-ink">
                          {f.points} <span className="text-ink-muted">/ {f.max}</span>
                        </div>
                        <div className="text-2xs text-ink-faint">{SOURCE_LABEL[f.source]}</div>
                      </div>
                    </li>
                  ))}
              </ul>
            </div>
          ))}

          {canEdit && (
            <ActionForm action={overrideAction} className="flex flex-wrap items-end gap-2 border-t border-line pt-3 text-xs">
              <label className="text-ink-muted">
                Set a factor by hand
                <select name="key" className="input mt-1 h-8 w-56 py-0 text-xs" defaultValue="different">
                  {READINESS_FACTORS.map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-ink-muted">
                Value
                <select name="value" className="input mt-1 h-8 w-28 py-0 text-xs" defaultValue="">
                  <option value="">0 to 10</option>
                  {Array.from({ length: 11 }, (_, i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                  <option value="clear">Clear</option>
                </select>
              </label>
              <label className="flex-1 text-ink-muted">
                Why
                <input name="note" className="input mt-1 h-8 w-full py-0 text-xs" placeholder="What makes you say so" />
              </label>
              <SubmitButton size="sm" variant="secondary" pendingText="Saving...">
                Save
              </SubmitButton>
            </ActionForm>
          )}
        </div>
      )}
    </Card>
  );
}
