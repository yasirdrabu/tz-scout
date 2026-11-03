# INT-E4 Usage caps

Release R1 (shipped in R2b-1 as one limit per provider; the usage page is R3a)

R2b-1 shipped plan docs/plans/2026-11-02-r2b-1-usage-caps.md. Ruling 1 is the user's answer of
2026-11-02; Rulings 2 to 11 and the build rulings after them are Claude's calls, 2026-11-02. Where
they differ from the Rules below, the rulings win.

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

## R2b-1 rulings

1. **(User) In-app notices only.** A notice is a banner on Settings, Integrations, the level on the
   service's Manage panel, and the `integrations.usage.threshold_reached` event. Email comes later,
   when Scout sends email.
2. **One limit per provider.** A limit sits on the provider, scoped by `provider_key`, in `usage_cap`
   (unit, period, limit, `overage_period_start`). Defaults, stored the first time a reservation or an
   owner change needs the row:

   | Provider | Limit | Unit | Period |
   |---|---|---|---|
   | `apollo` | 2,000 | credits | month |
   | `vibe` | 1,000 | credits | month |
   | `anthropic` | 20,000 | cost_cents | month |
   | `hubspot` | 50,000 | calls | day |

   Providers without a default have no limit. Read paths fall back to the defaults in memory.
3. **API-key limits are not in this version.** Arrival limits stay on sources
   (`source.daily_arrival_cap`). `api_key.monthly_enrichment_credit_cap` (default 0) is enforced in
   R2b-2, where keys could start spend. `api_key.daily_arrival_cap` stays unread. This differs from the
   Rules above, which put per-key limits here.
4. **Periods use the tenant's timezone.** A day starts at local midnight, a month on the 1st at local
   midnight. The reset is the start of the next period. Calls today also uses the tenant's day.
5. **Units per call.** `calls`: every call counts 1. `credits`: the call's `units` when its unit is
   credits. `cost_cents`: the call's `costCents`; the reservation is `opts.reserveCents` (the AI
   runner passes the worst case). Mock calls count units the same way, so limits work locally.
6. **Reserve, then settle.** A reservation is committed in its own transaction before the call
   (`usage_period.reserved`). The settle step runs with the call log after the call, success or not:
   `used += actual`, `reserved -= reservation`. A process that dies in between leaves the reservation
   held until the period ends, which is accepted. Two reservations that together pass the limit: the
   second is refused (ENR-E3-S2-AC4).
7. **Levels.** `warn` at `used + reserved` of 80% or more. `blocked` when a reservation would pass 100%,
   or once settled usage reaches 100%. Each level publishes `integrations.usage.threshold_reached`
   once per period, using flags on `usage_period`.
8. **Refusal.** A refused call writes a `call_log` row with outcome `blocked_by_cap` and makes no
   outside call. It throws `ScoutError` slug `blocked_by_cap`, status 429, `extensions.resets_at` and a
   `retry-after` header. The AI runner already falls back to rules on this slug. This slug is used
   instead of `cap_reached` above.
9. **Owner actions** need `integrations:manage` and are people only:
   `PUT /api/v1/integrations/{key}/cap {limit}` (a whole number of 1 or more; audit
   `integrations.cap.set` with before and after) and `POST /api/v1/integrations/{key}/cap:allow-overage`
   (sets `overage_period_start` to the current period start; `warn` still shows; audit
   `integrations.cap.overage`). Either takes effect for the next reservation.
10. **Waiting jobs (INT-E4-S3-AC2).** The worker catches `blocked_by_cap` from any job or consumer and
    puts the message back after min(reset - now, 15 minutes) without using up a run (like a closed
    workspace). A raised limit resumes the work within 15 minutes; a reset resumes it on time.
11. **Deferred.** The usage page (INT-E4-S4) moves to R3a (Costs). `integrations.usage.recorded` moves to
    R3a, where analytics first consumes it; `call_log` already holds every unit and cent.

Build rulings:

- Reservations apply to every gateway call, including Test connection.
- A `calls` limit counts failed and rate-limited calls (they reach the service). Credits and
  `cost_cents` count only on success.
- A call whose amount is only known after it runs is not refused up front, but is still added to usage
  (`recordUsage`).
- A settle failure never loses the call-log row. A lost settle leaves the reservation held until the
  period ends.
- Calls today, errors today and the response average leave out `blocked_by_cap` rows.
- A `calls` limit counts one per gateway call (one adapter operation), not one per HTTP request the
  adapter makes to the service; an operation that pages or retries inside the adapter still counts 1.
- R2b-2 enrichment callers must pass the amount up front (`units` with `unit: 'credits'`), so a call
  that would pass the limit is refused before it spends. A credits call without it is only counted
  afterwards (`recordUsage`) and is never refused.
- A job refused by a limit waits (Ruling 10) with up to 60 seconds of random delay added, so the jobs
  waiting on one limit do not all come back at the reset. Jobs that count their own runs (the HubSpot
  push and undo) take the run back, and are never marked failed by a refusal. The 15-minute activity
  poll queues no syncs while the CRM's limit is reached.
- The AI runner records a refused call as an `ai_run` with status `refused_by_cap`. A task with no
  rules (or `allowRules: false`) rethrows `blocked_by_cap`, so its job waits and a route returns 429.
- A new limit that puts the current period below a level it had reached clears that level's flag, so
  reaching it again publishes `integrations.usage.threshold_reached` again.

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

### INT-E4-S4 Usage page (R3a, Ruling 11)
As an owner, I want one page of usage this month by provider, key and source, so that I can see who
uses what.
- INT-E4-S4-AC1 Totals per provider with cost in the tenant's currency, a per-day chart, and a table
  per API key and per source.
