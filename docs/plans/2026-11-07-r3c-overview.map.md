# R3c map: Overview, scorecard, flywheel and playbook rates

Read-only map of branch feat/r3c-overview (= main 3334a06, after R3b trust). Paths are relative to C:\dev\tz-scout-overview.
"Mockup" means `C:\Users\yasir\AppData\Local\Temp\claude\c--dev-tz-scout\5d5b32bf-3547-4ae0-9554-5906e0cd9276\scratchpad\mock\Taazaa Scout Operations.dc.html`
(3766 lines). Scope (roadmap): Overview §9, weekly scorecard + diagnosis, flywheel trends, playbook rates / `step_credit`.

## 1. What the spec asks

- **Overview (§9, docs/spec/web-ui/screens.md:471-495)**: `/t/:tenant/overview`, `analytics:read` (every role; sellers data-limited). Sub
  "...{quarter}, week {w} of {n}..." and `Configure stages` (with `settings:manage`). KPI tiles Pipeline value, Won value, Sent to Won,
  Days to win (median). Pipeline funnel: band per stage with "{x}% of {previous}", count, value at Opportunity and Won, "{count} of
  {target}" + pace (Behind/On/Ahead) against "Where we should be today"; "Left the pipeline" exits, no target. Scorecard tabs By
  seller / offer / practice, sortable, every number clickable, green on/ahead of target, amber needs attention. Detail drawer on any
  number: eyebrow, value, change vs last quarter at this point, "Counts when:", notes, breakdown bars (top 8), 6 accounts + `See all
  {n}`. Before R3 the KPIs/scorecard show "Results arrive with analytics. Stage counts are live now." (494-495).
- **Mockup**: markup 1934-2030 (KPI tiles 1941-1947, funnel 1948-1975, exits 1969-1973, scorecard 1976-2000, drawer 2003-2028); logic
  `scVals` 3117-3215; data `STAGE_COUNT`/`STAGE_PREV` 2582-2583, `SELLERS` 2584; pace = 4/13 (3121), Behind under 0.9 x pace, Ahead from
  1.05 x pace (3150); "Days to win 64" is hard-coded (3157, 3204); money = count x offer price (3125-3128). No flywheel or what-worked
  screen exists in the mockup (grep: none); playbook Reply/Meeting rate columns at 3297, note 1730, playbook tiles 3254.
- **Weekly scorecard (docs/spec/analytics/weekly-scorecard-and-diagnosis.md)**: Account group of 13 rows (arrivals .. revenue closed)
  10-16; marketing/meeting rows are R4 (Campaigns); raw counts only in `analytics.week`, rates by a pure module 18-19; colour rules
  21-27 (amber within 15%, grey under per-row minimum, spend band); Monday 11:00 UTC job asks AI task `weeklyDiagnosis` for bottleneck,
  cause, 1-3 fixes 29-37, rules fallback "Assembled from rules" 50-51, fixes carry over; S1 = target + 8 weeks + rolling 4 weeks 41-44;
  owners set targets and min sample in Settings 45. Release R4 ("R3 for the account rows", analytics/index.md:51). Not the same thing
  as the Overview scorecard tabs (people/offers/practices, this quarter).
- **Flywheel (docs/spec/analytics/flywheel-trends.md)**: 8 numbers by quarter, last 4 + quarter to date (cost per won overall and per
  level, win rate, median days arrival to won, share declined at review, avg trust weighted by arrivals, learnings + template edits
  accepted, engaged rate on a plan vs not, outcomes credited per step type/playbook) 14-23; "What worked" roll-up from
  `analytics.step_credit` by template x step type, per 10 steps, filter practice/offer, `whatWorked(ctx, filter)` also read by
  Playbooks 25-32; S1 change colours (>5% green/red, grey under min sample) + loop diagram 35-42; S3 AC1-3 44-50; S2 top 3 sources and
  playbooks by win-rate change 52-55.
- **Playbook rates**: playbooks/outcomes-and-what-worked.md:9-40 (outcome kinds; credit = steps done in the 14 days before, equal
  shares, else "no recent step"; what-worked score 0-100; roll-ups by template/step type/source/practice/offer/seller);
  `playbooks.outcome.recorded` {outcomeId, accountId, kind, occurredAt, source, amountCents, creditedStepIds} (playbooks/index.md:74;
  event-catalog.md:59). Playbook list "Reply rate / Meeting rate ... accounts that finished the playbook in the last 90 days"; page
  tiles Finished, Replied, Booked a meeting, Won.
- **Analytics index (docs/spec/analytics/index.md)**: tables `week`, `scorecard_target`, `diagnosis`, `fix`, `step_credit`,
  `consumer_cursor` (23-35); consumers `playbooks.outcome.recorded`, `playbooks.learning.recorded`, `intake.source.trust_changed` (78-80);
  publishes `analytics.diagnosis.created` (85); proposed `GET /analytics/flywheel`, `GET /analytics/scorecard` (119-120;
  public-api/index.md:129-130, `?from&to`, `?weeks`). MCP: only `get_source_performance` (mcp/index.md:50, agent-tools.md:235); none for
  these areas.
- **Access (access-and-exports.md)**: costs need `costs:read` (7-9); seller = own accounts (`own_accounts`, roles-and-data-scopes.md
  124-129); viewer sees pipeline + scorecard read-only (roles 86-87); CSV export on every table with audit 31-35; "Updated <time>" from
  the cursor (read-models-and-replay.md:39); rebuild 12-22.
- **api-gaps.md**: Overview rows 552-553 (`GET /api/v1/stages/summary` NEW ENDPOINT; `?from&to` entered-this-period; a jump counts skipped
  stages as passed), 569 (`quarter_target` stored, pace shown in R3), 1085-1088 (pace needs `scorecard_target`; value at Opportunity/Won;
  Sent to Won, Days to win; scorecard tabs + `GET /analytics/scorecard`, `GET /analytics/metrics/{key}` for the drawer "not in the
  analytics spec"), proposed change 4 (1109), correction 1 (Overview stays `analytics:read`, 1121).

## 2. What exists in code

- **Web UI**: Overview is still a `Placeholder` (web-ui/src/routes/workspace.tsx:59-63; `SCREENS.overview` routes/screens.ts:9, tag R3);
  nav item gated `analytics:read` (app/nav.ts:35). No features/overview dir. Funnel + Drill (features/funnel/*, api.ts `PERIODS`,
  `CostStatus`) and Costs (features/costs/*) are the patterns to copy. Playbooks: Reply/Meeting rate columns render `<NotYet />`
  (features/playbooks/PlaybookList.tsx:52-55, 90-93), page tiles Finished/Replied/Booked a meeting/Won all `NotYet`
  (PlaybookView.tsx:172-175). msw handlers in web-ui/src/test/server.ts have no overview mocks.
- **Analytics (R3a/R3b)**: tables `cost_line`, `cost_budget`, `budget_state`, `cost_setting`, `journey`, `journey_stage`, `journey_deal`
  only (db/schema.ts:16-136). No `source_touch`, `decline`, `week`, `scorecard_target`, `diagnosis`, `fix`, `step_credit`,
  `consumer_cursor`. Services/journeys.ts: `recordArrival` 41, `recordStage` 57, `recordScore` 79, `recordDeal` 91, `loadJourneys` 156,
  `journeysUpdatedAt` 191 (the "Updated" stamp), `backfillJourneys` 205; services/funnel.ts `funnel` 148, `sourcePerformance` 215. Pure
  domain/funnel.ts: `stageCounts` 21, `stepPct` 31, `lostAt` 35, `costStatus` 72, `insight` 82; domain/period.ts (30d/90d/quarter/year,
  tenant timezone). Routes only `/analytics/funnel` and `/analytics/sources/:id/performance` (src/http/routes.ts:223-224). No scorecard,
  flywheel or overview route, job handler or schedule.
- **Journey holds** first source, batch, `arrived_at`, practice, offer, exit stage, per-stage `entered_at`, deals (`amount_cents`,
  `closed_at`). **Not held**: seller (analytics does not consume `routing.assignment.accepted`), declines, meetings, step timeliness.
- **Stage counts**: routing `listStages` returns live stages with `quarterTarget` (routing/services/pipeline-stages.ts:21; route
  src/http/routes/v1/stages/route.ts, `accounts:read` or `status:read`); target saved by `PUT /settings/stages` (settings/stages/route.ts:13).
  `GET /api/v1/stages/summary` is **not built**. Current stage on `account_review.stage`; history `routing.stage_change`
  (routing/db/schema.ts:136-158); the first stage has no event (R3b map).
- **Assignments**: `routing.assignment` has `assignedAt`, `respondedAt`, `sellerUserId` (routing/db/schema.ts:104-131); events
  `routing.assignment.accepted/declined` (routing/contracts/events.ts:48-77).
- **Playbooks**: `account_plan` status active|paused|completed|stopped|abandoned, `statusReason`, `engagedAt`, `acceptedAt`,
  `sellerUserId` (playbooks/db/schema.ts:164-205); `plan_step` todo|in_progress|done|skipped with `doneAt`, `due_date` (230);
  services/crm-activity.ts:15-48 consumes `crm.activity.observed` reply/meeting, sets `engagedAt`, applies the stop rule
  (`reply_or_meeting|meeting|never`). **No outcome table, no `playbooks.outcome.recorded`, no `creditedStepIds`, no what-worked score, no
  `playbooks.learning.recorded`** (grep of src: none). Replies and meetings exist only as CRM observations and `engagedAt`.
- **Trust**: R3b trust shipped: `source_trust_history`, nightly schedule (entry/seed.ts:129), `intake.source.trust_changed` published;
  usable for the flywheel trust number. Retros/learnings (playbooks/retros-and-learnings.md) not built.
- **Permissions** tenancy/domain/permissions.ts: `analytics:read` 30 and 52 (sellers), viewer 95; `costs:read` owner/leader/operator. No
  permission for "every seller's numbers" (mockup 2775 only) and none for editing scorecard targets.
- **Scheduler**: `upsertSchedule` (entry/seed.ts:6), nightly handler pattern in entry/worker.ts. No Monday job; `weeklyDiagnosis` AI
  task does not exist in src/modules/ai-tasks.

## 3. What is missing (by area)

1. **Overview data**: per-stage entered-this-quarter from `journey_stage`, exits, same-point previous quarter, median days arrival to
   won, value at Opportunity/Won from `journey_deal`, pace from `quarter_target` x quarter elapsed. One endpoint, data-limited, no spend.
2. **Scorecard tabs + drawer**: seller aggregates (accepted, time to accept, steps on time, meetings, opportunities, won, pipeline,
   win rate), offer and practice tables, `metrics/{key}` drawer (definition text, top-8 breakdown, 6 accounts). Needs seller on the
   journey, meetings from `crm.activity`, step due/done counts from playbooks.
3. **Weekly scorecard + diagnosis**: `week`, `scorecard_target`, `diagnosis`, `fix`, pure colour/rolling-4 module, Monday job,
   `weeklyDiagnosis` task + rules fallback, targets settings, `analytics.diagnosis.created`. Marketing/meetings rows need Campaigns (R4).
4. **Flywheel**: quarter bucketing of cost per won, win rate, median days, decline share, weighted trust (needs `decline`, trust
   history), plan vs no-plan engaged rate, learnings; page + loop diagram + biggest movers; new route and nav entry.
5. **Playbook rates**: outcome table + `playbooks.outcome.recorded` with 14-day credit, `step_credit` consumer, `whatWorked`, per-
   playbook Reply/Meeting/Won rates for the list and page tiles.
6. **Cross-cutting**: `consumer_cursor` + "Updated <time>", rebuild, CSV export + audit per table, no MCP tool needed.

## 4. Conflicts

- **Two scorecards**: Overview scorecard (this quarter, by seller/offer/practice) vs weekly scorecard (rows by week, diagnosis, R4);
  the spec names one `GET /analytics/scorecard` for both. Overview needs per-seller targets ("Target {n}", mockup 3163) that no table holds;
  `scorecard_target` is per metric.
- **Fixed vs configurable stages**: Overview takes names/order from the API (screens §9); weekly rows hard-code reviewed, engaged,
  opportunity, won. Map by stage kind/trigger or default keys.
- **Money**: mockup values pipeline and won as count x offer price (3125-3128); Decision 26 and R3b use actual deal amounts. Deals with
  no amount; several deals per account; "pipeline" = open deals at Opportunity.
- **Pace**: mockup uses a fixed 4/13 (3121); the spec gives no formula. Exits have no target.
- **Win rate**: By seller = won / opportunities (mockup 3173), By offer/practice = won / matched (3177), funnel = won / sent.
- **Rate denominators**: playbook screens = replied of accounts that finished in 90 days; flywheel = outcomes per 10 steps done.
- **Outcomes not built**: flywheel and playbook rates assume `playbooks.outcome.recorded` (PLB-E6), absent in code.
- **Seller visibility**: Overview is `analytics:read` for every role yet By seller shows other people's numbers; the mockup gates with
  a "sellers" permission (2775) the spec lacks. A seller's `own_accounts` limit shrinks every tile.
- **Release tags**: weekly scorecard is R4; flywheel and Overview R3.

## 5. Suggested split

- **R3c-1 Overview** (analytics + web-ui, ~6 tasks): (1) seller and offer on the journey from `routing.assignment.accepted` + backfill;
  (2) pure domain: quarter bounds, pace, median days, change vs last quarter, scorecard rows; (3) `GET /analytics/overview` and
  `GET /analytics/scorecard?tab=` + `metrics/{key}`; (4) UI tiles + funnel bands + exits; (5) UI scorecard tabs + drawer + `Configure
  stages`; (6) spec and api-gaps updates. Ships on today's data (no outcomes needed).
- **R3c-2 Playbook outcomes and rates** (playbooks + analytics + web-ui, ~5 tasks): outcome table + `playbooks.outcome.recorded` with
  14-day credit; `step_credit` consumer + `whatWorked`; per-playbook rates endpoint; replace `NotYet` on PlaybookList/PlaybookView;
  What worked table. Independent of R3c-1.
- **R3c-3 Flywheel (and weekly scorecard if kept)** (analytics + ai-tasks + web-ui, ~6 tasks): `decline` + `consumer_cursor`, flywheel
  service + page + loop + movers; optionally `week`/`scorecard_target`/`diagnosis`/`fix`, Monday job, `weeklyDiagnosis`. Needs R3c-2.

## Owner questions

1. Overview money: actual deal amounts (Decision 26) or count x offer price as in the mockup? Recommend deal amounts, offer price only when a deal has no amount.
2. Pace: linear share of the quarter elapsed, Behind under 90% and Ahead from 105% of pace, as in the mockup? Recommend yes.
3. By seller "Target {n}": add a per-seller quarterly Won target (setting + permission), or drop the target and colour against the team average? Recommend drop the target in R3c-1.
4. Who sees By seller: everyone with `analytics:read` (sellers only themselves via `own_accounts`), or a new permission for every seller's numbers? Recommend no new permission; the data limit decides.
5. Is the weekly scorecard + Monday AI diagnosis in R3c or left to R4 as its release tag says? Recommend defer to R4; build the Overview scorecard and flywheel now.
6. Playbook Reply/Meeting rate denominator: accounts that finished in 90 days (screens/mockup) or outcomes per 10 steps (flywheel)? Recommend both: tiles use the screens definition, What worked uses per 10 steps.
7. Build the full outcomes model (`playbooks.outcome.recorded`, 14-day credit) now, or first derive replies/meetings from `account_plan.engagedAt` + `crm.activity`? Recommend the event + credit model; skip the what-worked score and manual outcomes until asked.
8. Flywheel has no mockup: new route `/t/:tenant/flywheel` with a nav item, or a section on Overview? Recommend a separate screen gated `analytics:read`, trend numbers first, loop diagram last.
