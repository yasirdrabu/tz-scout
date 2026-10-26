# ANL-E1 Account funnel by source

Release R3 · Module ANL

## Why

The CRO needs to see, for every source, how many accounts arrived and how far they got: reviewed,
assigned, engaged, opportunity, won. That is the core of "what is working".

## Stages (D15)

Arrived → Reviewed → Assigned → Engaged → Opportunity → Won, with exits Declined (after review) and
Lost (after opportunity). Review and routing tracks the stage of every account (REV-E4) and publishes
`routing.stage.changed`; Analytics takes stage timestamps only from that event. Assigned includes
implied acceptance (the seller acted on the account in the CRM, or 2 working days passed with no
decline). A stage counts once per account, at the first time it was entered; a move back (for
example a declined assignment returning to Reviewed) does not erase the earlier entry. An account
that skips a stage (a deal opened before any reply was logged) counts as having passed the skipped
stages at the later stage's time.

## Two views

| View | Question it answers | Counts |
|---|---|---|
| Cohort (default) | "Of the accounts that arrived in Q3, how far did they get?" | Accounts by `arrived_at` in the period, with the furthest stage each reached so far |
| Activity | "What happened this month?" | Stage entries whose timestamp is in the period, whatever the arrival date |

## Attribution

- **First source (default):** each account is credited to the source of its first resolved arrival,
  at all three levels (person, agent, vendor). Totals add up.
- **Any source:** each account counts once for every source that ever sent it (`source_touch`).
  Totals do not add up and the UI says so: "Accounts sent by more than one source are counted under
  each".

## Pure functions (in `src/modules/analytics/domain/accountFunnel.ts`)

- `funnelCounts(journeys, view, period)` → counts per stage, plus exits.
- `conversion(from, to)` → decimal, undefined when `from` is below the minimum sample (default 5).
- `timeInStage(journeys, stage)` → median and 80th percentile days between entering the stage and
  entering the next one.

## Stories

### ANL-E1-S1 Funnel by source
As a CRO, I want the account funnel broken down by source, so that I can see which sources produce
pipeline.
- ANL-E1-S1-AC1 The funnel page shows one row per source with counts per stage, the exits, and the
  conversion rate between each pair of stages, right-aligned with tabular figures.
- ANL-E1-S1-AC2 Grouping can switch between source level (person, agent, vendor), practice, offer,
  batch and seller.
- ANL-E1-S1-AC3 Given hand-built journeys in a test, counts and rates match hand-calculated values for
  both views and both attribution modes.

### ANL-E1-S2 Time in stage
As a leader, I want to see how long accounts sit at each stage, so that I can find where they stall.
- ANL-E1-S2-AC1 Each stage shows median and 80th percentile days to the next stage.
- ANL-E1-S2-AC2 Accounts currently in a stage longer than the 80th percentile are listed with a link.

### ANL-E1-S3 Period and filters
As an owner, I want to pick a period and filters, so that I can answer specific questions.
- ANL-E1-S3-AC1 Periods: this week, last 4 weeks, month, quarter, custom; week starts Monday in the
  tenant's timezone.
- ANL-E1-S3-AC2 Filters: practice, offer, source, source level, batch, seller, tier at arrival.
- ANL-E1-S3-AC3 Rates with too small a sample show grey with "Not enough data yet".

### ANL-E1-S4 Drill to accounts
As a CRO, I want to click any number and see the accounts behind it, so that I trust the number.
- ANL-E1-S4-AC1 Every count links to the list of accounts it counts, with the stage timestamps.
