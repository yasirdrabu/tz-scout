# ENR-E3 Credits, costs and caps

Status: Request caps shipped in R2b-2 · Release: R1 (caps and usage through INT), R3 (cost reporting
through ANL)

R2b-2 shipped plan docs/plans/2026-11-03-r2b-2-enrichment.md. Its rulings for credits and money are
below ("R2b-2 rulings"); where they differ from the Rules, the rulings win.

## Why

Cost per source is half of the clarity Scout promises (goal 6). Every credit spent is recorded with
who asked for it and why, turned into money, and stopped at the caps the owner sets (D16).

## Rules

- **Check before spending.** Before a run, ENR calls INT `checkCap(ctx, providerKey, amount)` with the
  estimate (it returns `{status, used, limit, resetsAt}`; R2b-1) for every cap that applies:
  - the provider connection's monthly credit cap;
  - the requesting key's enrichment credit cap, only when a key itself starts spend. API keys default
    to **0** enrichment credits, so in this version keys never spend; a request an agent flagged and a
    person approved counts against the connection cap and is attributed to the approving person and
    the flagging source.
  Results: `ok`, `warn` (at or past 80%; the run goes ahead and owners are told), `blocked` (would
  pass 100%).
- **Every outside call goes through INT `gateway.call`**, with context `{ requestId | searchRunId,
  accountId, requestingSourceId, principal }`. The gateway enforces rate limits, writes the call log,
  records usage (credits, and money from the connection's price per credit), and publishes
  `integrations.usage.recorded`. ENR keeps no ledger of its own; `request.result.credits_used` is a
  copy for display.
- **Blocked** requests stay `approved` with "Waiting for budget: Apollo monthly limit reached"; an
  owner can raise the cap (INT) or cancel. They resume automatically when the cap allows (monthly reset
  or raise).
- **Cost lines** come from `integrations.usage.recorded` in ANL, attributed with the context above.
  ENR's own events carry credits and cost only so callers and webhooks can show them; ANL must not
  build cost lines from them (no double counting).
- **Estimates** use `provider_price` per tenant and operation (credits per operation); seeded with
  Apollo defaults the owner should confirm (Settings shows "Check these against your Apollo plan").

## R2b-2 rulings

Claude's calls, 2026-11-03 (the numbering is the plan's; the other rulings are in
[requests-and-approval.md](requests-and-approval.md) and [results-and-failures.md](results-and-failures.md)).

- **Ruling 4. Kinds, operations and credits** are code constants (`domain/prices.ts`). There is no
  `provider_price` table and no Settings screen for it in this version; both are deferred, which
  differs from "Estimates" in the Rules above.

  | Kind | Apollo operations | Credits | Estimate |
  |---|---|---|---|
  | `company_firmographics` | `organizations/enrich` | 1 | 1 |
  | `people_for_roles` | `mixed_people/api_search` (0), then `people/match` per person | 1 per person found | roles × 3 |
  | `email_reveal` | `people/match` per named person | 1 | number of people |
  | `signals_refresh` | `organizations/enrich` (once, for the organization id), `organizations/job_postings`, `news_articles/search` | 1 + 1 + 1 | 3 |
  | `website_read` | `website.read` | 0 | 0 credits; Claude worst case in cents |

  Vibe uses the same kinds, operations and credits in its sample data. `signals_refresh` looks the
  company up once, so job postings and news need no lookup of their own; when the lookup finds no
  company, the run stops there (1 credit) and finds nothing new.
- **Ruling 5. Money on estimates.** Money is `credits × cents_per_credit`. `cents_per_credit` comes
  from the connection's settings when set (a whole number of 0 or more); otherwise the defaults are
  apollo 10 and vibe 10. Currency comes from the tenant. A website read's money is the `read_website`
  task's worst case (5 cents).
  - Copy: "Up to {n} credits, about {money}", or "Up to 1 credit, about $0.10".
  - With 0 credits: "Free. Claude usage up to {money}" (website).
  - On mock, append " · Sample".
- **Check before spending.** The run calls `checkCap` with the stored estimate's credits for the
  provider's one limit (usage-caps.md); there are no per-key limits, since keys never spend. When
  blocked, the request stays `approved` with `waiting_reason` "Waiting for budget: {Provider} monthly
  limit reached", committed in its own transaction, and the job waits for the limit (INT-E4-S3-AC2)
  without using up a try.
- **A paused budget (R3a Ruling 9).** While the provider's cost category is over 110% of its monthly
  budget, `checkCap` reads blocked with `paused`, and the request waits with "Waiting for budget: {Category}
  is over its monthly budget" ("Data vendors" for Apollo and Vibe). The same reason is kept when the
  gateway refuses a call part-way; a request that already found something finishes `partial` with
  "Stopped: {Category} is over its monthly budget." When the budget is raised the pause clears and the
  job runs on its next delivery (within 15 minutes).
- **Every operation is one `gateway.call`** with `{module: 'enrichment', unit: 'credits', units: <worst
  case for this call>, measure: <credits the provider reported>, requestSummary: {requestId,
  accountId}}`, so the limit reserves the worst case and settles what was spent.
- **The result's money.** `result.cost_cents` = `credits_used × cents_per_credit` (the same rate as the
  estimate), plus Claude's cost for a website read. `integrations.usage.recorded` and ANL cost lines
  are R3a, so ENR-E3-S1-AC2 waits for R3a.
- **Retries re-spend.** A job retried after a provider error (or a redelivery after a crash) runs the
  paid calls again: their credits count against the limit again, and `result.credits_used` counts
  only the final attempt. Accepted for this version; INT's call log has every call.
- **The vendor source is checked before any paid call.** A paused or archived provider source, or one
  at its daily arrival limit, fails the request before anything is spent (results-and-failures.md).

## Stories

### ENR-E3-S1 Every credit is recorded once
As an owner, I want every credit spent recorded with who and why, so that cost per source is real.
- ENR-E3-S1-AC1 Every provider call in a completed, failed or partial run goes through `gateway.call`
  with the context fields; INT's usage for the month equals the sum of `credits_used` on ENR requests
  and search runs.
- ENR-E3-S1-AC2 An integration test runs one enrichment and checks exactly one set of cost lines
  appears in ANL. Waits for R3a, where `integrations.usage.recorded` and ANL cost lines are built.

### ENR-E3-S2 Respect caps
As an owner, I want spending to stop at the limits I set, so that a busy week can't run up a bill.
- ENR-E3-S2-AC1 A run whose estimate would pass the connection's monthly cap is blocked before any call
  is made.
- ENR-E3-S2-AC2 A run that reaches the cap part-way stops, keeps what it found, and is `partial`
  (ENR-E4).
- ENR-E3-S2-AC3 Crossing 80% publishes `integrations.usage.threshold_reached` (INT) once per month per
  cap.
- ENR-E3-S2-AC4 Two runs that each fit but together pass the cap: the second is blocked (INT's
  `reserve` locks the period row, so the hold is atomic; `checkCap` is the read-only check; integration
  test).
