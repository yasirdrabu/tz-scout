"use client";

// Ranked segment list. Scores are recomputed here with the pure scoring module so changing a weight
// re-ranks the list instantly, before anything is saved.

import Link from "next/link";
import { useMemo, useState } from "react";
import { ActionButton, ActionForm, Disclosure, SubmitButton } from "@/components/client";
import { Badge, Bar, Card, Table, Td, Th, cx } from "@/components/ui";
import { FACTORS, FACTOR_KEYS, rankSegments, scoreSegment, type FactorKey, type Weights } from "@/lib/scoring";
import { compact, money } from "@/lib/format";
import { saveWeightsAction, setSegmentStatusAction } from "./actions";
import { moveNeeds, SEGMENT_STATUSES, SEGMENT_STATUS_LABEL, SEGMENT_STATUS_TONE, STATUS_MOVES, type SegmentStatusKey } from "./labels";

export type SegmentRow = {
  id: string;
  name: string;
  buyer: string;
  problem: string;
  industry: string | null;
  status: SegmentStatusKey;
  origin: "AI" | "MANUAL";
  audienceSize: number | null;
  cpcCents: number | null;
  caseStudyCount: number;
  batchCount: number;
  factors: { factor: string; value: number; overrideValue: number | null }[];
};

type Filter = "ALL" | SegmentStatusKey;

const toStrings = (w: Weights) => Object.fromEntries(FACTOR_KEYS.map((k) => [k, String(w[k])])) as Record<FactorKey, string>;
const parse = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const round = (n: number) => Math.round(n);
const tidy = (n: number) => Math.round(n * 10) / 10;

export function RankedSegments({
  slug,
  currency,
  rows,
  savedWeights,
  initialFilter,
  canSaveWeights,
  canGenerate,
  canActivate,
}: {
  slug: string;
  currency: string;
  rows: SegmentRow[];
  savedWeights: Weights;
  initialFilter: string;
  canSaveWeights: boolean;
  canGenerate: boolean;
  canActivate: boolean;
}) {
  const [inputs, setInputs] = useState(() => toStrings(savedWeights));
  const [filter, setFilter] = useState<Filter>(() => ((SEGMENT_STATUSES as readonly string[]).includes(initialFilter) ? (initialFilter as SegmentStatusKey) : "ALL"));

  const weights = useMemo(() => Object.fromEntries(FACTOR_KEYS.map((k) => [k, parse(inputs[k])])) as Weights, [inputs]);
  const changed = FACTOR_KEYS.some((k) => weights[k] !== savedWeights[k]);
  const total = tidy(FACTOR_KEYS.reduce((s, k) => s + weights[k], 0));
  const halfTotal = (half: "market" | "fit") => tidy(FACTORS.filter((f) => f.half === half).reduce((s, f) => s + weights[f.key], 0));

  const ranked = useMemo(
    () =>
      rankSegments(
        rows.map((r) => {
          const b = scoreSegment(r.factors, weights);
          return { ...r, b, score: b.total };
        }),
      ),
    [rows, weights],
  );
  const savedRank = useMemo(() => {
    const m = new Map<string, number>();
    rankSegments(rows.map((r) => ({ id: r.id, name: r.name, score: scoreSegment(r.factors, savedWeights).total }))).forEach((r, i) => m.set(r.id, i + 1));
    return m;
  }, [rows, savedWeights]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { ALL: rows.length, PROPOSED: 0, SHORTLISTED: 0, ACTIVE: 0, REJECTED: 0 };
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);

  const pickFilter = (f: Filter) => {
    setFilter(f);
    try {
      const url = new URL(window.location.href);
      if (f === "ALL") url.searchParams.delete("status");
      else url.searchParams.set("status", f.toLowerCase());
      window.history.replaceState(null, "", url.toString());
    } catch {
      // URL sync is a convenience only.
    }
  };

  const visible = ranked.map((r, i) => ({ ...r, rank: i + 1 })).filter((r) => filter === "ALL" || r.status === filter);
  const can = (from: SegmentStatusKey, to: SegmentStatusKey) => (moveNeeds(from, to) === "segment.activate" ? canActivate : canGenerate);

  return (
    <>
      <Card className="mb-4 px-4 py-3">
        <Disclosure
          summary={
            <span>
              Weights <span className="tnum font-normal text-ink-muted">(market {halfTotal("market")}, fit {halfTotal("fit")}, total {total})</span>
              {changed && <Badge tone="accent" className="ml-2">Trying new weights</Badge>}
            </span>
          }
        >
          <ActionForm action={saveWeightsAction.bind(null, slug)}>
            <p className="mb-3 max-w-3xl text-xs text-ink-muted">
              Change a weight and the list re-ranks straight away. Each factor is rated 0 to 10 and earns its share of the weight. Scores always scale to 100, so weights that add up to something other than 100 still compare fairly.
            </p>
            <div className="grid gap-6 md:grid-cols-2">
              {(["market", "fit"] as const).map((half) => (
                <div key={half}>
                  <div className="mb-2 flex items-baseline justify-between border-b border-line pb-1">
                    <span className="text-xs font-semibold text-ink">{half === "market" ? "Market" : "Fit"}</span>
                    <span className="tnum text-xs text-ink-muted">{halfTotal(half)}</span>
                  </div>
                  <div className="space-y-1.5">
                    {FACTORS.filter((f) => f.half === half).map((f) => (
                      <label key={f.key} className="flex items-center justify-between gap-3 text-sm" title={f.help}>
                        <span className="text-ink-soft">
                          {f.label}
                          {f.inverted && <span className="ml-1 text-2xs text-ink-faint">(lower is better)</span>}
                        </span>
                        <input
                          name={`w_${f.key}`}
                          type="number"
                          min={0}
                          step={1}
                          inputMode="decimal"
                          value={inputs[f.key]}
                          onChange={(e) => setInputs((v) => ({ ...v, [f.key]: e.target.value }))}
                          className={cx("input tnum w-20 text-right", weights[f.key] !== savedWeights[f.key] && "border-accent-line bg-accent-soft/40")}
                          aria-label={`${f.label} weight`}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {canSaveWeights ? (
                <SubmitButton size="sm" pendingText="Saving..." disabled={!changed}>
                  Save as company weights
                </SubmitButton>
              ) : (
                <span className="text-xs text-ink-muted">You can try weights here. They are not saved; an owner sets the company weights.</span>
              )}
              {changed && (
                <button type="button" className="link text-xs" onClick={() => setInputs(toStrings(savedWeights))}>
                  Reset to saved weights
                </button>
              )}
              {canSaveWeights && total !== 100 && <span className="text-xs text-near">Company weights must add up to 100 to save.</span>}
            </div>
          </ActionForm>
        </Disclosure>
      </Card>

      <div className="mb-4 flex gap-1 border-b border-line" role="tablist">
        {(["ALL", ...SEGMENT_STATUSES] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            onClick={() => pickFilter(f)}
            className={cx("-mb-px border-b-2 px-3 py-2 text-sm", filter === f ? "border-accent font-medium text-ink" : "border-transparent text-ink-muted hover:text-ink")}
          >
            {f === "ALL" ? "All" : SEGMENT_STATUS_LABEL[f]}
            <span className="tnum ml-1.5 text-xs text-ink-faint">{counts[f]}</span>
          </button>
        ))}
      </div>

      <Card>
        <Table>
          <thead>
            <tr>
              <Th numeric>Rank</Th>
              <Th>Segment</Th>
              <Th>Industry</Th>
              <Th>Status</Th>
              <Th numeric>Score</Th>
              <Th numeric>Market</Th>
              <Th numeric>Fit</Th>
              <Th numeric>LinkedIn audience</Th>
              <Th numeric>Cost per click</Th>
              <Th numeric>Case studies</Th>
              <Th numeric>Test batches</Th>
              {(canGenerate || canActivate) && <Th />}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <Td colSpan={12} className="py-6 text-center text-ink-muted">
                  No {filter === "ALL" ? "" : SEGMENT_STATUS_LABEL[filter as SegmentStatusKey].toLowerCase()} segments.
                </Td>
              </tr>
            )}
            {visible.map((r) => {
              const before = savedRank.get(r.id) ?? r.rank;
              const moved = changed ? before - r.rank : 0;
              const moves = STATUS_MOVES[r.status].filter((m) => can(r.status, m.to));
              return (
                <tr key={r.id} className={cx("hover:bg-sunken/50", r.status === "REJECTED" && "text-ink-muted")}>
                  <Td numeric className="text-ink-muted">
                    {r.rank}
                    {moved !== 0 && <div className={cx("text-2xs", moved > 0 ? "text-accent" : "text-ink-faint")}>{moved > 0 ? `up ${moved}` : `down ${-moved}`}</div>}
                  </Td>
                  <Td className="min-w-[260px] max-w-md">
                    <Link href={`/c/${slug}/segments/${r.id}`} className="font-medium text-ink hover:text-accent">
                      {r.buyer}
                    </Link>
                    <div className="mt-0.5 line-clamp-2 text-xs text-ink-muted">{r.problem}</div>
                    {r.origin === "MANUAL" && <div className="mt-0.5 text-2xs text-ink-faint">Added by hand</div>}
                  </Td>
                  <Td className="whitespace-nowrap text-ink-soft">{r.industry ?? "n/a"}</Td>
                  <Td>
                    <Badge tone={SEGMENT_STATUS_TONE[r.status]}>{SEGMENT_STATUS_LABEL[r.status]}</Badge>
                  </Td>
                  <Td numeric>
                    <div className="font-semibold">{round(r.b.total)}</div>
                    <Bar value={r.b.total} max={100} className="mt-1 w-16" />
                  </Td>
                  <Td numeric className="text-ink-soft">
                    {round(r.b.market)} of {round(r.b.marketMax)}
                  </Td>
                  <Td numeric className="text-ink-soft">
                    {round(r.b.fit)} of {round(r.b.fitMax)}
                  </Td>
                  <Td numeric>{compact(r.audienceSize)}</Td>
                  <Td numeric>{money(r.cpcCents, currency, { precise: true })}</Td>
                  <Td numeric>{r.caseStudyCount}</Td>
                  <Td numeric>{r.batchCount}</Td>
                  {(canGenerate || canActivate) && (
                    <Td className="whitespace-nowrap">
                      <div className="flex justify-end gap-1">
                        {moves.map((m) => (
                          <ActionButton key={m.to} action={setSegmentStatusAction.bind(null, slug, r.id, m.to)} size="sm" variant={m.to === "ACTIVE" ? "secondary" : "ghost"} pendingText="Saving...">
                            {m.label}
                          </ActionButton>
                        ))}
                      </div>
                    </Td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
