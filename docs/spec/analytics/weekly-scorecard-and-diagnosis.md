# ANL-E5 Weekly scorecard and diagnosis

Release R3 (account rows), R4 (ad rows, once Campaigns is ported) · Module ANL

## Why

Carried from v1 Module 7. A Monday view of the week against targets, colours that only mean
something, and an AI diagnosis that names the single biggest bottleneck with owned fixes.

## Rows

Grouped, each with a target, each week Monday to Sunday, and a rolling 4-week value computed from
summed counts (not an average of rates).

| Group | Rows |
|---|---|
| Accounts | arrivals, reviewed, review rate, declined, assigned, engaged, engaged rate, opportunities, opportunity rate, won, win rate, cost per won client, revenue closed |
| Marketing (from Campaigns, R4) | spend, impressions, cost per 1,000 impressions, clicks, clickthrough rate, cost per click, form fills, form conversion rate, cost per form fill |
| Meetings (from Campaigns, R4) | discovery calls held, show-up rate, cost per discovery call, sales calls held, show-up rate, cost per sales call |

Weeks store raw counts only; every rate and cost is derived by the pure scorecard module (carried from
`src/lib/scorecard.ts`).

## Colour rules (carried, unit tested)

- Green: at or better than target.
- Amber: within 15% worse than target.
- Red: more than 15% worse.
- Grey: sample below the row's minimum (configurable per row).
- Spend is a band: green within 5% of target either side, amber within 15%, red beyond.
- No colour when there is no target.

## Diagnosis

- A scheduled job (Mondays 11:00 UTC) builds last week, then asks the AI tasks module
  (`weeklyDiagnosis` task) to read the last 4 weeks and return: the single biggest bottleneck, the
  likely cause, and 1 to 3 fixes, each with an owner role. Output Zod-validated; stored per week.
- Shown as two rows above the table (bottleneck, cause) and as a summary card.
- Fixes are tasks with a checkbox. Unfinished fixes carry over to the next week's card until done.
- People can edit the diagnosis and add, edit or tick fixes; edits record who and when.

## Stories

### ANL-E5-S1 Scorecard
As a CRO, I want this week against target in one table, so that I see problems on Monday.
- ANL-E5-S1-AC1 The table shows the rows above with target, the last 8 weeks and the rolling 4-week value.
- ANL-E5-S1-AC2 Colour logic matches the rules above (unit tested with boundary cases at exactly 0%, 15%
  and 15.01% worse, and the spend band).
- ANL-E5-S1-AC3 Owners set targets and minimum samples per row in Settings.
- ANL-E5-S1-AC4 Weeks rebuild from the read models for any selected range.

### ANL-E5-S2 Monday diagnosis
As a leader, I want Scout to name the biggest bottleneck and fixes each Monday, so that the team acts on
one thing.
- ANL-E5-S2-AC1 Each Monday a diagnosis exists for the previous week, stored with its AI run id.
- ANL-E5-S2-AC2 Without an Anthropic key, the diagnosis is built by rules (the row furthest below target)
  and labelled "Assembled from rules".
- ANL-E5-S2-AC3 Fixes not done carry over; ticking one records who and when.
