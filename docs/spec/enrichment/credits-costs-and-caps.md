# ENR-E3 Credits, costs and caps

Status: Draft · Release: R1 (caps and usage through INT), R3 (cost reporting through ANL)

## Why

Cost per source is half of the clarity Scout promises (goal 6). Every credit spent is recorded with
who asked for it and why, turned into money, and stopped at the caps the owner sets (D16).

## Rules

- **Check before spending.** Before a run, ENR calls INT `checkCap(capKey, amount)` with the estimate
  for every cap that applies:
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

## Stories

### ENR-E3-S1 Every credit is recorded once
As an owner, I want every credit spent recorded with who and why, so that cost per source is real.
- ENR-E3-S1-AC1 Every provider call in a completed, failed or partial run goes through `gateway.call`
  with the context fields; INT's usage for the month equals the sum of `credits_used` on ENR requests
  and search runs.
- ENR-E3-S1-AC2 An integration test runs one enrichment and checks exactly one set of cost lines
  appears in ANL.

### ENR-E3-S2 Respect caps
As an owner, I want spending to stop at the limits I set, so that a busy week can't run up a bill.
- ENR-E3-S2-AC1 A run whose estimate would pass the connection's monthly cap is blocked before any call
  is made.
- ENR-E3-S2-AC2 A run that reaches the cap part-way stops, keeps what it found, and is `partial`
  (ENR-E4).
- ENR-E3-S2-AC3 Crossing 80% publishes `integrations.usage.threshold_reached` (INT) once per month per
  cap.
- ENR-E3-S2-AC4 Two runs that each fit but together pass the cap: the second is blocked (INT's
  `checkCap` is atomic; integration test).
