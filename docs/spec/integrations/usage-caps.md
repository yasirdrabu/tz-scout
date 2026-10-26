# INT-E4 Usage caps

Release R1

## Why

Vendor credits, AI tokens and per-agent volume cost money and can flood reps. Caps per integration
and per API key stop that (D16): warn at 80%, block at 100%.

## Rules

- A cap has a scope (a connection or an API key), a unit (credits, tokens, calls, records,
  cost_cents, arrivals), a period (day or month, in the tenant's timezone) and a limit.
- Defaults on new tenants: Apollo 2,000 credits a month; Vibe 1,000 credits a month; Claude
  $200.00 (20000 cents) a month; HubSpot 50,000 calls a day (below HubSpot's own limit). Per API key:
  500 arrivals a day (from TEN key settings), 0 enrichment credits a month.
- Before a call with a known cost, the gateway reserves the expected units; after the call it records
  the actual units. If the reservation would pass the block level, the call is refused with
  `cap_reached` and nothing is spent.
- At the warn level: owners get one notice per cap per period. At the block level: owners get a
  notice, calls in that scope are refused, and API callers get 429 with `type` ending `/cap-reached`
  and the reset time.
- Owners can raise a cap or allow one more period of overage from the notice; both are audited.
- Arrival caps are checked by intake via `checkCap`; an arrival over cap is rejected with reason
  `daily_cap_reached` (it is still stored as received, per D13).

## Stories

### INT-E4-S1 Set caps
As an owner, I want to set caps per integration and per key, so that spend has a ceiling.
- INT-E4-S1-AC1 Caps can be edited on the integration's Manage panel and on the key's page.
- INT-E4-S1-AC2 Each cap shows used, limit, and the reset date.

### INT-E4-S2 Warn at 80 percent
As an owner, I want a warning before a cap is hit, so that I can decide in time.
- INT-E4-S2-AC1 Given usage crosses 80% of a cap, then exactly one `integrations.usage.threshold_reached`
  with level `warn` is published that period and owners are notified.

### INT-E4-S3 Block at 100 percent
As an owner, I want calls stopped at the cap, so that nothing overspends while I'm away.
- INT-E4-S3-AC1 Given a cap is reached, then calls in its scope are refused before reaching the
  provider and the call log shows `blocked_by_cap`.
- INT-E4-S3-AC2 Jobs refused by a cap wait (not dead-lettered) and resume after the reset or a raised
  limit.

### INT-E4-S4 Usage page
As an owner, I want one page of usage this month by provider, key and source, so that I can see who
uses what.
- INT-E4-S4-AC1 Totals per provider with cost in the tenant's currency, a per-day chart, and a table
  per API key and per source.
