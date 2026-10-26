# OFF-E5 Offer readiness

Release R2 · Carried from `src/lib/offerReadiness.ts`

## Why

Before putting reps and money behind an offer, an owner needs to know if it's strong enough to sell
and what to fix first.

## Rules

100 points in two halves, each factor rated 0 to 10 and weighted:

| Half | Factor | Weight | Measured or judged |
|---|---|---|---|
| Offer strength | Clear, measurable outcome | 10 | judged (AI, editable) |
| | Proof we can show | 12 | measured: case studies × 3 + proof points × 2, max 10 |
| | Time to first result | 8 | judged |
| | Risk taken off the buyer | 8 | judged |
| | Easy first step | 8 | measured from starting price: ≤ $10K 10, ≤ $25K 8, ≤ $50K 6, ≤ $100K 4, else 2; none set 5 |
| | Something tangible to hold | 6 | judged |
| | Different from the alternatives | 8 | judged |
| Market pull | Companies showing demand | 14 | measured: accounts with this as best offer at act now or good fit ÷ 2 |
| | Reasons to act now | 10 | measured: share of those at act now × 12 |
| | Buyers we can reach | 8 | measured: share with a decision-maker found × 10 |
| | Wins like it | 8 | measured: mapped wins × 2.5; no win history yet 5 |

Score = Σ (value / 10 × weight). Bands: 75 or more "Ready to push", 60 to 74 "Fix first", under 60
"Rework the offer". Overrides (value and note) survive recomputation and are marked.

## Stories

### OFF-E5-S1 Readiness score per offer
As an owner, I want each offer scored for readiness with fixes, so that I know where to invest.
- OFF-E5-S1-AC1 The offer page shows the score, band, both halves, each factor with its reason, and
  up to 3 fixes for the weakest factors.
- OFF-E5-S1-AC2 The offers list has a readiness column and "Score all".
- OFF-E5-S1-AC3 Measured factors recompute when market counts or wins change (nightly at most; on
  demand any time).
- OFF-E5-S1-AC4 Hand-calculated test: proof 2 case studies and 1 proof point → value 8 (12 × 0.8 =
  9.6 points); starting price $30,000 → value 6.

### OFF-E5-S2 Override a factor
- OFF-E5-S2-AC1 A person can override any factor's value with a note; the override is shown with who
  and when and survives rescoring; "Clear override" returns to the computed value.
