# SRC-E3 Resolve pipeline and duplicate checks

Status: Draft · Release: R1

## Why

All sources take the same path (D3). One pipeline turns an arrival into an account: the same checks,
the same duplicate rules, the same provenance, whoever sent it.

## The pipeline

Runs as job `jobs.intake.resolve` (one per arrival), consumed in the worker, ordered by normalised
domain so two arrivals for the same company never resolve at the same time. Target: received to
resolved in under 5 seconds p95 when nothing waits for a person.

1. **Validate** against the contract version. Fail: `rejected` / `invalid` with the paths. In a batch,
   an item with the same `external_ref` or normalised domain as an earlier item is `rejected` /
   `duplicate_in_batch`.
2. **Normalise.**
   - Free-text industry is mapped to an `industry_key` by the synonym table, then AI task
     `arrival_normalise` if no rule matches (mock: left unmapped).
   - Domain from `domain`, else `website`, else the first person's work email; lowercase, strip
     `www.` and paths, reduce to the registrable domain with the public suffix list
     (`www.miamidade.gov/...` → `miamidade.gov`).
   - Free email domains (the existing list in `leadChecks.ts`) never become an account domain.
   - Names trimmed, legal suffixes kept for display but ignored for matching (`Inc`, `LLC`, `Ltd`,
     `Corp`, `Co`, `GmbH`).
   - Country to ISO 3166 alpha-2; employee and revenue ranges parsed into min and max.
3. **Waiting checks** (the arrival stays `resolving` with `waiting_on` set and
   `intake.arrival.waiting` is published):
   - No domain, website or LinkedIn URL, no `target_account_id`, not a sole proprietor →
     `needs_website` (today's "held rows": a person types the website and the arrival continues from
     step 2). Only file imports, forms and CRM webhooks can reach this; the API requires one.
   - Only a person with a personal email and `sole_proprietor` not set → `needs_company`; a person
     sets the company or marks it a sole proprietor.
4. **Find the account** (skipped when `target_account_id` is set) by calling ACC `findMatches`:

   | Match | Confidence | Action |
   |---|---|---|
   | Same domain, or a domain alias of an account | certain | attach |
   | Same company LinkedIn URL | certain | attach |
   | Same `(source, external_id)` seen before on an account | certain | attach |
   | Same normalised name and same country, account has no domain | likely (0.90) | attach |
   | Name similarity 0.85 or more (trigram) and same state or city | possible | wait `possible_duplicate` with candidates |
   | Nothing above | none | create |

   A shell account matches on the person's email only.
5. **Create or attach** by calling ACC `upsertFromArrival(arrival, accountId?)`. ACC records facts,
   people and signals with provenance, raises conflicts, applies exclusions, and returns the account id
   and whether it was created.
6. **Warm intro**: store the `warm_intro` row and its points (SRC-E5).
7. **Exclusion**: if ACC reports the account is ruled out (ACC-E7) and not overridden, the arrival is
   `rejected` / `excluded` with `account_id` set and the rule's label as `detail`; the account is kept
   and marked "Ruled out" so a person can override. Otherwise publish `intake.arrival.resolved` with
   the fields in the index. Scoring reacts to it and to
   ACC's events; REV sets the initial review status only if the account has none yet (an account
   already in review or assigned keeps its status and shows "new information from <source>").
8. **Batch counters** update; the last item of a batch to resolve or be rejected publishes
   `intake.batch.completed`.

**Inline resolution.** A targeted arrival submitted with `inline: true` (ACC's `add_person` and
`add_signal`) runs steps 1, 2, 5 and 7 inside the request transaction instead of as a job, so the
caller gets the person or signal id back at once. The arrival is still stored as received.

Each step's outcome is written to the arrival row, so a failure part-way leaves a clear state and the
job can be retried safely (steps check whether they already happened).

## Stories

### SRC-E3-S1 One pipeline for every source
As a leader, I want every account to pass the same checks whatever its source, so that the queue is
consistent and comparable.
- SRC-E3-S1-AC1 An arrival from the API, MCP, a file import, a webhook and an enrichment run with the
  same content produce the same account state (integration test with five sources).
- SRC-E3-S1-AC2 p95 from `received` to `resolved` is under 5 seconds at 500 arrivals a minute on the
  reference VM.
- SRC-E3-S1-AC3 A resolve job killed at any step and retried produces one account, no duplicate
  people, facts or signals.

### SRC-E3-S2 Duplicate checks
As a leader, I want an account that arrives twice to be one account with both sources on it, so that
reps never work the same company twice.
- SRC-E3-S2-AC1 Two arrivals with `miamidade.gov` and `https://www.miamidade.gov/x` resolve to one
  account; the second is `attached`.
- SRC-E3-S2-AC2 An arrival with a domain that is an alias of a merged account attaches to the
  survivor.
- SRC-E3-S2-AC3 "Keystone Ridge Properties LLC" (no domain, US) attaches to "Keystone Ridge
  Properties" (no domain, US); with a domain mismatch it does not.
- SRC-E3-S2-AC4 A possible duplicate waits with up to 5 candidates; the box lets a person pick
  "Same as <candidate>" or "New company"; either choice resumes the pipeline and is audited.

### SRC-E3-S3 Arrivals waiting for a person
As an operator, I want arrivals that can't be resolved alone to wait for me with a clear reason, so
that nothing is silently dropped.
- SRC-E3-S3-AC1 The "Waiting for you" page lists arrivals with `waiting_on` set, by reason, with a
  field to fix each (website, company, duplicate choice); fixing resumes the pipeline.
- SRC-E3-S3-AC2 Callers see these arrivals as `resolving` with `waiting_on`; a batch is not completed
  while any of its items wait.
- SRC-E3-S3-AC3 An arrival waiting 30 days is rejected `invalid` with detail "Nobody supplied the
  missing website within 30 days", and the source gets feedback.

### SRC-E3-S4 Existing accounts keep their place
As a seller, I want new information on my account to show up without resetting it, so that a pull or
an agent never puts a sent account back in the queue.
- SRC-E3-S4-AC1 An arrival that attaches to an assigned account does not change its review status or
  owner; the account shows "New from <source>, <date>" until the owner opens it.
- SRC-E3-S4-AC2 `isFirstFromSource` is true only for the first arrival from that source to that
  account; funnel and trust count only first arrivals.
