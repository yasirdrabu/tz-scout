# ANL-E3 Source performance and cost per stage

Release R3 · Module ANL

## Why

Joining the funnel (ANL-E1) and the ledger (ANL-E2) answers the questions that matter: cost per
arrived, reviewed, engaged, opportunity and won account, per source, and which sources deserve more
budget or trust.

## Metrics (pure functions in `src/modules/analytics/domain/sourceMetrics.ts`)

| Metric | Formula |
|---|---|
| Cost per arrived account | allocated cost ÷ arrived accounts |
| Cost per reviewed account | allocated cost ÷ reviewed accounts |
| Cost per engaged account | allocated cost ÷ engaged accounts |
| Cost per opportunity | allocated cost ÷ opportunities |
| Cost per won client | allocated cost ÷ won accounts |
| Win rate | won ÷ arrived (cohort view) |
| Revenue per source | sum of `won_amount_cents` |
| Return | revenue ÷ allocated cost |
| Decline rate | declined ÷ reviewed, with the top decline reasons (from `analytics.decline`: review declines and seller declines of assignments, by reason key) |

All use the cohort view and first-source attribution unless the page is switched. Values below the
minimum sample are shown grey, not hidden.

## Stories

### ANL-E3-S1 Source table
As a CRO, I want one table of sources with cost per stage, win rate and return, so that I can move
budget to what works.
- ANL-E3-S1-AC1 One row per source (at the chosen level) with arrivals, cost, cost per stage, win rate,
  revenue, return and current trust score.
- ANL-E3-S1-AC2 Sorting by any column; numbers right-aligned with tabular figures; plain labels
  ("Cost per won client", never acronyms).
- ANL-E3-S1-AC3 Hand-calculated test cases match for every metric.

### ANL-E3-S2 One source's page
As a leader, I want a page per source, so that I can see its batches, its accounts and how its trust
moved.
- ANL-E3-S2-AC1 The page shows the source's funnel, costs by category, batches with their outcomes, top
  decline reasons and a trust trend line.
- ANL-E3-S2-AC2 For an agent-level source, the person behind it and the vendors it used are shown.

### ANL-E3-S3 Agents see their own performance
As an outside agent, I want to see how my submissions converted, so that I can send better accounts.
- ANL-E3-S3-AC1 `get_source_performance` and `GET /v1/analytics/sources/{id}/performance` (proposed
  addition to the public API) return the calling source's funnel counts, decline reasons and trust
  trend.
- ANL-E3-S3-AC2 A principal limited to its own source cannot read another source's performance (403).
- ANL-E3-S3-AC3 Costs are included only if the principal also has `analytics:read`.
