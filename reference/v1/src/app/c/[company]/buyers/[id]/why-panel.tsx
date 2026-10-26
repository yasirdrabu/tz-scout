// "Why this is a lead": the reasons behind the match, grouped by strength, each with its evidence,
// the points it earned, why it matters for the offer, and what the signal means. Server component.

import { Badge, Card, CardHeader, Dot, cx } from "@/components/ui";
import { ActionButton } from "@/components/client";
import { KIND_LABEL, SIGNAL_EXPLAINER, SIGNAL_KIND, TIER_LABEL, type RuleHit, type SignalKind, type SignalRule, type SignalType, type Tier } from "@/lib/matching";
import { relative } from "@/lib/format";
import type { FormAction } from "@/server/action";
import type { MatchReasons } from "@/server/buyers";
import { TIER_TONE, hasAge, points } from "../labels";

type Sig = { id: string; type: string; title: string; detail: string | null; occurredAt: Date };

const KIND_ORDER: SignalKind[] = ["research", "trigger", "pain"];
const KIND_HELP: Record<SignalKind, string> = {
  research: "They're reading about the problem this offer solves, right now.",
  trigger: "Something changed that opens budget or forces a decision.",
  pain: "Evidence the problem exists. Worth watching; strongest alongside research or a trigger.",
};
const KIND_TONE: Record<SignalKind, "accent" | "neutral" | "muted"> = { research: "accent", trigger: "neutral", pain: "muted" };

export function WhyPanel({
  offerName,
  tier,
  fit,
  signal,
  total,
  reasons,
  rules,
  signals,
  excluded,
  excludedOverride,
  includeAction,
  canAct,
  now,
}: {
  offerName: string | null;
  tier: Tier;
  fit: number | null;
  signal: number | null;
  total: number | null;
  reasons: MatchReasons | null;
  rules: SignalRule[];
  signals: Sig[];
  excluded: string | null;
  excludedOverride: boolean;
  includeAction?: FormAction;
  canAct: boolean;
  now: Date;
}) {
  const byId = new Map(signals.map((s) => [s.id, s]));
  const hits = reasons?.signals ?? [];
  const kindOf = (h: RuleHit) => h.kind ?? SIGNAL_KIND[h.type];
  const hitRuleIds = new Set(hits.map((h) => h.ruleId));
  const missing = rules.filter((r) => !hitRuleIds.has(r.id) && SIGNAL_KIND[r.type] !== "pain").slice(0, 4);
  const hasWhyNow = hits.some((h) => kindOf(h) !== "pain");

  const headline = (() => {
    if (excluded && !excludedOverride) return "Ruled out for every offer.";
    if (!offerName || !reasons) return "Not matched to an offer yet.";
    if (reasons.disqualified) return reasons.disqualified;
    const top = KIND_ORDER.flatMap((k) => hits.filter((h) => kindOf(h) === k)).slice(0, 2).map((h) => h.label.charAt(0).toLowerCase() + h.label.slice(1));
    if (top.length === 0) return `Looks like a ${offerName} buyer, but no buying signals yet.`;
    return `${offerName}, because: ${top.join(", and ")}.`;
  })();

  return (
    <Card className="border-accent-line">
      <CardHeader
        title="Why this is a lead"
        description={headline}
        actions={
          <span className="flex items-center gap-2">
            <Badge tone={TIER_TONE[tier]}>{TIER_LABEL[tier]}</Badge>
            {total != null && <span className="tnum text-sm font-semibold text-ink">{Math.round(total)}</span>}
          </span>
        }
      />

      {excluded && (
        <div className={cx("flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 text-sm", excludedOverride ? "bg-sunken/40" : "bg-near-soft")}>
          <span className="text-ink-soft">
            {excludedOverride ? "Included by hand, although flagged: " : "Ruled out: "}
            {excluded}
          </span>
          {canAct && includeAction && (
            <ActionButton action={includeAction} size="sm" variant="secondary" pendingText="Rescoring...">
              {excludedOverride ? "Rule out again" : "Include anyway"}
            </ActionButton>
          )}
        </div>
      )}

      {!(excluded && !excludedOverride) && reasons && (
        <div className="divide-y divide-line">
          {/* Score line */}
          <div className="grid grid-cols-3 gap-3 px-4 py-3 text-center">
            <ScoreCell label="Fit" value={fit} help="Looks like the buyer: industry, size, revenue, region, contact" />
            <ScoreCell label="Signals" value={signal} help="Signs they're buying now, newer count more" />
            <ScoreCell label="Overall" value={total} help="55% fit, 45% signals" />
          </div>

          {KIND_ORDER.map((kind) => {
            const group = hits.filter((h) => kindOf(h) === kind);
            if (group.length === 0) return null;
            return (
              <section key={kind} className="px-4 py-3">
                <div className="mb-2 flex items-baseline gap-2">
                  <Dot tone={KIND_TONE[kind]} />
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{KIND_LABEL[kind]}</h3>
                  <span className="text-2xs text-ink-faint">{KIND_HELP[kind]}</span>
                </div>
                <ul className="space-y-3">
                  {group.map((h) => {
                    const evidence = h.signalIds.map((id) => byId.get(id)).filter((s): s is Sig => !!s);
                    const ex = SIGNAL_EXPLAINER[h.type as SignalType];
                    return (
                      <li key={h.ruleId} className="rounded border border-line px-3 py-2">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-sm font-medium text-ink">{h.label}</span>
                          <span className="tnum shrink-0 text-2xs text-ink-muted">
                            {points(h.points)} of {h.max} points
                          </span>
                        </div>
                        <ul className="mt-1 space-y-0.5 text-xs text-ink-soft">
                          {evidence.length > 0
                            ? evidence.slice(0, 3).map((s) => (
                                <li key={s.id}>
                                  {s.title}
                                  {s.type === "intent" && s.detail ? <span className="text-ink-muted"> · {s.detail.split(".")[0]}</span> : null}
                                  {hasAge(s.type) && s.type !== "intent" ? <span className="text-ink-faint"> · {relative(s.occurredAt, now)}</span> : null}
                                </li>
                              ))
                            : h.matched.slice(0, 3).map((m) => <li key={m}>{h.type === "tech" ? `Uses ${m}` : m}</li>)}
                        </ul>
                        {h.why && <p className="mt-1.5 text-xs text-ink">{h.why}</p>}
                        {ex && (
                          <details className="mt-1 text-2xs text-ink-muted">
                            <summary className="cursor-pointer select-none hover:text-ink">What is this signal?</summary>
                            <p className="mt-1">{ex.what}</p>
                            <p className="mt-1">{ex.read}</p>
                          </details>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}

          {!hasWhyNow && (
            <p className="px-4 py-3 text-xs text-ink-muted">
              No research or trigger signal yet, so this isn&apos;t an &quot;act now&quot; lead. It moves up when one appears.
            </p>
          )}

          {missing.length > 0 && (
            <div className="px-4 py-3">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">Would make it stronger</div>
              <ul className="space-y-0.5 text-xs text-ink-soft">
                {missing.map((r) => (
                  <li key={r.id}>
                    {r.label} <span className="text-ink-faint">(up to {r.weight} points)</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {reasons.fit.length > 0 && (
            <details className="px-4 py-3 text-xs">
              <summary className="cursor-pointer select-none font-semibold uppercase tracking-wide text-ink-muted hover:text-ink">Why it fits</summary>
              <ul className="mt-2 space-y-0.5 text-ink-soft">
                {reasons.fit.map((p) => (
                  <li key={p.key} className="flex justify-between gap-3">
                    <span>
                      {p.label}: {p.note}
                    </span>
                    <span className="tnum shrink-0 text-ink-muted">
                      {points(p.points)} of {p.max}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

function ScoreCell({ label, value, help }: { label: string; value: number | null; help: string }) {
  return (
    <div title={help}>
      <div className="text-2xs text-ink-muted">{label}</div>
      <div className="tnum text-lg font-semibold text-ink">{value == null ? "n/a" : Math.round(value)}</div>
    </div>
  );
}
