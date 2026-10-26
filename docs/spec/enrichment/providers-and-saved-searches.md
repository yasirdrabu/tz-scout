# ENR-E2 Providers and saved searches

Status: Draft · Release: R1

## Why

Today Apollo is the main way to find new companies and the people at them, Vibe runs through Claude
outside Scout, and the company website is a free source Claude can read. Each sits behind an adapter
with mock and live versions. Saved searches (today's "Pulls") run on a schedule and feed intake.

## Rules

### Providers

| Provider key | Operations | Credentials | Notes |
|---|---|---|---|
| `apollo` | company search, company enrich, people search, email reveal, job postings, news | API key per tenant (INT) | Today's `apollo.ts` behaviour; emails only revealed on request |
| `vibe` | none in Scout | none | Import only: Vibe exports come in through SRC file import with the Vibe layout; the batch carries `reported_cost` |
| `website` | website read | none (uses the AI connection) | Fetches the home page and up to 4 linked pages (about, services, industries, contact); 30-second limit; respects robots.txt |
| `mock` | all | none | Seeded sample companies and people |

- Each provider adapter implements: `estimate(operation, params)`, `run(operation, params)` returning
  results as `arrival.v1` items plus `creditsUsed`, and `health()`.
- A new provider is added in code (non-goal: no-code providers).
- Every provider is registered in SRC as a `vendor` source so its data carries provenance and trust.

### Saved searches

- Fields carried from today's pulls: name, provider, offer and practice it's for, filters (industries,
  employee range, revenue range, locations, keywords, hiring titles, technologies, buyer titles,
  exclude domains), max companies per run (default 25), schedule (`off`, `daily`, `weekly` on Monday),
  max credits per run (default 200, today's `APOLLO_MAX_CREDITS_PER_RUN`).
- Creating a saved search registers a `scheduled_pull` source under the provider's vendor source.
- A person with `searches:manage` creates and schedules searches; creating one is the approval for its
  runs within the per-run credit cap (no per-run approval).
- Each run creates an SRC batch (`criteria` = the filters) and submits each company, with people found
  for the buyer titles, as an arrival. Already-known companies attach and never return to the queue
  (SRC-E3-S4).
- The run shows its estimate before "Run now" and on the schedule page.

## Stories

### ENR-E2-S1 Provider adapters
As a developer, I want every provider behind the same interface with mock and live versions, so that
Scout runs end to end without keys.
- ENR-E2-S1-AC1 Apollo adapter tests against stubbed Apollo responses (today's `apollo.test.ts`
  fixtures) pass through the new interface.
- ENR-E2-S1-AC2 The website reader returns description, industry guess, size clues and technologies as
  facts with the page URL; with the Claude connection mode = mock it returns rule-based extraction labelled
  "Read by rules".
- ENR-E2-S1-AC3 `health()` results show on the integration's page in INT.

### ENR-E2-S2 Saved searches
As an operator, I want to save a search and run it on a schedule, so that new matching companies keep
arriving.
- ENR-E2-S2-AC1 Searches page lists saved searches with provider, offer, schedule, last run (found,
  new, credits) and next run; "Run now" shows the estimate first.
- ENR-E2-S2-AC2 A scheduled run publishes `jobs.enrichment.search.run`; the run's companies appear as a
  batch from the search's `scheduled_pull` source.
- ENR-E2-S2-AC3 A run never spends more than its credit cap; when it stops at the cap it is `partial`
  and says so.
