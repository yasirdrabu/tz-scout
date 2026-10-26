# OFF-E7 Segments

Release R4 · Carried from v1 Module 2 (`src/lib/scoring.ts`)

## Why

For paid campaigns and message tests, an offer needs named segments (a buyer plus a problem) ranked by
how attractive and how winnable they are. Account-based work in R1 to R3 does not depend on segments.

## Rules

Claude proposes 8 to 12 segments per approved offer, for example "Operations leaders at 200 to 1,000
person logistics firms running dispatch on spreadsheets". Enrichment per segment through adapters:
LinkedIn audience size, Google monthly searches, average cost per click, matching case studies.

Score out of 100, two halves; each factor 0 to 10, weighted (weights editable per tenant):

| Half | Factor | Weight | Source |
|---|---|---|---|
| Market (50) | Pain severity | 12 | AI, editable |
| | Urgency or trigger events | 10 | AI, editable |
| | Reachable audience size | 10 | Data (LinkedIn size) |
| | Ability to pay | 10 | AI + revenue band |
| | Competition for attention | 8 | Data (cost per click), inverted |
| Fit (50) | Proof we have | 14 | Data (case study matches) |
| | Delivery fit | 12 | AI, editable |
| | Deal size vs target | 10 | Offer data |
| | Buying committee complexity | 7 | AI, inverted |
| | Sales cycle length | 7 | AI, inverted |

Score = Σ (factor / 10 × weight); inverted factors count as (10 − value).

## Stories

### OFF-E7-S1 Generate and score segments
- OFF-E7-S1-AC1 Generating for an approved offer creates 8 to 12 segments, each with every factor, a
  one-line reason per factor and a total.
- OFF-E7-S1-AC2 Changing a weight re-ranks the list immediately.
- OFF-E7-S1-AC3 A person can add a segment by hand and score it.

### OFF-E7-S2 Overrides and status
- OFF-E7-S2-AC1 Overrides of AI factors are stored, marked, and survive regeneration.
- OFF-E7-S2-AC2 Status: proposed, shortlisted, active, rejected; at most 3 active per offer
  (configurable).
- OFF-E7-S2-AC3 The detail page shows a factor breakdown bar chart with reasons.
