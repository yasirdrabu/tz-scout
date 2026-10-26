# CMP-E2 Ad funnel model

Release R4 · Module CMP · Carried from v1 Module 4

## Why

Before running paid campaigns for an offer, model what a won client will cost and what budget a
target needs. This is a planning tool; actual results come from Analytics.

## Stages and rates

| # | Stage | Rate | Default from |
|---|---|---|---|
| 1 | Impressions | Cost per 1,000 impressions (cents) | ad history, else tenant default |
| 2 | Clicks | Clickthrough rate | ad history |
| 3 | Form fills | Form conversion rate | form history |
| 4 | Reviewed accounts | Review pass rate (reviewed and not declined ÷ arrived, ad and form sources) | Analytics |
| 5 | Discovery calls held | Show-up rate | meetings |
| 6 | Sales-qualified | Qualification rate | CRM deals opened ÷ discovery held |
| 7 | Sales calls held | Show-up rate | meetings |
| 8 | Won | Close rate | CRM deals |

Stage 4 replaces v1's "validated leads" now that validation is the shared review step.

## Math (pure module `src/modules/campaigns/domain/adFunnel.ts`, carried from `src/lib/funnel.ts`)

- cost per click = CPM ÷ 1,000 ÷ CTR
- cost at stage n = cost at stage n−1 ÷ rate n (stages 3 to 8)
- cost per won client = cost at stage 8
- profit per client = deal value × margin − cost per won client
- return = (deal value × margin) ÷ cost per won client
- with expansion: add expansion rate × expansion value × expansion margin to profit and return
- budget needed = target won clients per month × cost per won client
- clients from budget = budget ÷ cost per won client

## Stories

### CMP-E2-S1 Model an offer
As an owner, I want to set the eight rates and see the cost per stage, so that I know what a won client
costs.
- CMP-E2-S1-AC1 One row per stage with a slider and number input, the default shown beside it, and the
  resulting cost per stage.
- CMP-E2-S1-AC2 The summary shows cost per won client, profit per client, return, budget needed for a
  target and clients from a budget.
- CMP-E2-S1-AC3 The math matches hand-calculated test cases (carried tests from v1).

### CMP-E2-S2 Defaults from history
- CMP-E2-S2-AC1 Each rate defaults from history (as in the table) when the sample is at least the
  minimum, otherwise the tenant default, and says which.

### CMP-E2-S3 Scenarios and presentation mode
As an owner, I want to save and compare scenarios and show them in a client meeting, so that the model
supports decisions.
- CMP-E2-S3-AC1 Scenarios are saved per offer; up to 3 compare side by side.
- CMP-E2-S3-AC2 Presentation mode shows the summary in large type with no editing controls.
