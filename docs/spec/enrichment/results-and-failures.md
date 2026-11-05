# ENR-E4 Results and failures

Status: Request results shipped in R2b-2 · Release: R1

R2b-2 shipped plan docs/plans/2026-11-03-r2b-2-enrichment.md. Its rulings for the run and its
failures are below ("R2b-2 rulings"); where they differ from the Rules, the rulings win.

## Why

Enrichment results must land on the account with the provider as their source, and a run that fails
part-way must keep what it got (today's fix: a pull that stops out of credits still scores what it
saved).

## Rules

- **Results as arrivals.** A request's results are submitted to SRC as one targeted arrival
  (`target_account_id`) from the provider's vendor source, with the requester's person or agent source
  recorded in the arrival's `notes` and the request id as `external_ref`. Saved-search results are
  normal arrivals in the run's batch. So facts, people and signals get provenance, conflicts are
  detected, and the provider's trust is earned like any source.
- **Nothing found** completes the request with `found = 0` and the message "Apollo found no one for
  technical buyer"; credits used (often 0) are still recorded.
- **Error kinds and handling:**

  | Error kind | Example | Handling |
  |---|---|---|
  | `auth` | key revoked | fail now; INT marks the connection unhealthy and tells owners |
  | `rate_limited` | 429 from provider | retry with the job backoff; doesn't count as an attempt for 3 tries |
  | `out_of_credits` | provider says no credits | stop; submit what was found; `partial`; tell owners |
  | `cap_reached` | INT blocks mid-run | stop; submit what was found; `partial` |
  | `timeout` | provider slow | retry with backoff |
  | `bad_request` | invalid filters | fail with the provider's message; no retry |
  | `unknown` | anything else | retry with backoff, then dead job (PLT) |

- Partial results are always submitted before the request is marked `failed` or `partial`.
- Every provider call is logged by INT (request summary, status, duration, credits) without personal
  data in the log body beyond ids.

## R2b-2 rulings

Claude's calls, 2026-11-03 (the numbering is the plan's; the other rulings are in
[requests-and-approval.md](requests-and-approval.md) and [credits-costs-and-caps.md](credits-costs-and-caps.md)).

- **Ruling 8. The run.** Approving enqueues job `enrichment.request.run {requestId}` in the same
  transaction and publishes `enrichment.request.approved`. The job does nothing unless the request is
  `approved` or `running` (a cancelled request's job may still be queued). Then:
  1. **Checks limits** (credits-costs-and-caps.md). When the limit allows, it clears `waiting_reason`
     and sets `running`, `started_at` and `connection_mode`, committed.
  2. **Checks the account and the source before spending.** An account with no domain or website
     fails as `bad_request` "Add the company’s website first." The provider's vendor source (found
     by key; the `website` one is made on first use) must take the arrival: a paused or archived
     source fails as `bad_request` "The {Provider} source is paused. An owner can turn it back on in
     Sources.", one at its daily arrival limit "The {Provider} source reached its daily arrival limit.
     Try again tomorrow." A redelivery of a run already `running` skips this check, since its arrival
     may already exist; if intake refuses the submit later, the request fails the same way and the
     credits are spent.
  3. **Calls the provider**, one `gateway.call` per operation. `people_for_roles` searches each role
     by the role's own titles (business owner: Owner, CEO, President, Founder; commercial buyer: VP
     Sales, Head of Procurement, CFO; technical buyer: CTO, VP Engineering, IT Director, Head of IT;
     any other role: its label), plus the lead offer's target titles only when the offer's
     `targetBuyingRoles` includes that role. At most 3 people a role; a person found again for another
     role is not revealed again and gains that role.
  4. **Submits the results** as one inline, targeted arrival from the vendor source
     (`channel: 'enrichment'`), with `target_account_id`, `account.external_ref` = the request id (a
     retry is a duplicate), `account.notes` "Requested by {requester label}", and the sending context
     `actor {kind: 'system', id: 'enrichment'}`, `access {sourceId: vendor source, dataLimit: all}`. A
     redelivery whose first try already sent the arrival reuses it.
  5. **Finishes.** It sets `completed` with `result {arrival_ids, credits_used, cost_cents, found}`.
     `found` counts what changed: people and signals added, plus company fields that differ from what
     the account held before the run, plus website facts. With nothing found, `result.message` reads
     "{Provider} found no one for {role labels joined by "and"}" (`people_for_roles`), "{Provider}
     found no one for the people asked about" (`email_reveal`) or "{Provider} found nothing new"
     (other kinds). A website read with Claude on mock, or at its limit, adds `message` "Read by rules"
     and `read_by: 'rules'`. Then it publishes `enrichment.request.completed`.
- **Ruling 9. Errors.** Classified as below. Partial results are always submitted before the final
  status. A failure sets `failed` with `error {kind, message}` and publishes
  `enrichment.request.failed`; failing writes state and returns normally, never a throw.

  | Kind | Detected by | Handling |
  |---|---|---|
  | `cap_reached` | the gateway's `blocked_by_cap` | Before any result: the request waits (`waiting_reason`) and the job waits. After some results: submit them, `partial`, "Stopped at the {Provider} monthly limit." A budget pause (R3a) waits with "Waiting for budget: {Category} is over its monthly budget", or ends `partial` with "Stopped: {Category} is over its monthly budget." |
  | `auth` | status 401 | Fail now. INT `markConnectionFailing` sets the connection `failing` with the message. "{Provider} rejected the key. An owner needs to update it in Integrations." |
  | `out_of_credits` | `/insufficient credits/i` or Apollo's credits error | With results: submit them, `partial`, "{Provider} is out of credits." With nothing found: `failed` with the same message (a partial keeps something) |
  | `rate_limited` | `RateLimitedError` or 429 | Rethrow for the job backoff, "{Provider} asked us to slow down." Every try counts toward the 5 deliveries |
  | `timeout` | abort or timeout | Rethrow for the job backoff, "{Provider} took too long to answer." |
  | `bad_request` | 400, 403 or 422; or the gateway refusing the connection | Fail with the provider's message, no retry. A turned-off connection (`connection_disabled`): "{Provider} is turned off. An owner can turn it on in Integrations."; live but not ready (`connection_not_ready`): "{Provider} is set to live but is not ready. An owner needs to save a key and test it in Integrations."; no adapter (`adapter-missing`): "{Provider} is not available yet." |
  | `unknown` | anything else | Rethrow. After the last try the job dead-letters and the request stays `running` with "Something went wrong. Try again." until the daily job fails it (below) |

  While a retryable error backs off, the request stays `running` and its status text is the error's
  message.

  **Stuck requests (final review I1).** The daily `enrichment.request.expire` job also fails every
  request `approved` or `running` whose `updated_at` is 24 hours old or more: its job dead-lettered or
  was lost. It becomes `failed` with `error {kind: 'unknown', message: 'This enrichment stopped without
  finishing. Try again.'}`, `waiting_reason` cleared, and publishes `enrichment.request.failed` (credits
  0: what the lost run spent is not known), so the queue chip clears, the account notice stops polling
  and a new request of the kind is no longer joined to it. This includes a request with a
  `waiting_reason`: one really waiting on a limit is delivered again at least every ~16 minutes and each
  try rewrites `updated_at`, so it is never this stale, while one whose job died during the wait would
  otherwise stay open for ever.

  **Intake refusing the arrival (final review I2).** Besides the paused source and the daily arrival
  limit (Ruling 8), any other 4xx from intake (a body `arrival.v1` will not take) fails the request
  once as `bad_request` "Scout couldn't store what {Provider} found. {intake's first problem, else its
  title}", with no retry, since a retry would spend the credits again. To keep that rare:
  - a request reveals at most 25 people, as one arrival takes: `email_reveal` is refused over 25
    (400 at `person_ids` "Pick up to 25 people."), and `people_for_roles` stops revealing at 25
    (a person found again for another role still gains that role);
  - a signal with an empty title (an Apollo article with none) is dropped before the submit.

  **Signals refresh and limits (final review M2).** When a limit stops a signals refresh after the
  organization lookup and before anything was found, the request waits as usual and keeps the
  organization id in `params.org_id` (internal; not in the request JSON), so the next try does not pay
  for the lookup again.

  Differences from the Rules above: `rate_limited` uses up a try (the Rules' "doesn't count as an
  attempt for 3 tries" is not built); a 403 is `bad_request`, not `auth`: Apollo answers 403 when the
  key may not use one endpoint (people search needs a master key) while it still works for the
  others, so a retry can't help and the connection isn't marked failing. The cost: a real loss of
  permission shows as a request failure, not a connection alert. The vendor-source refusals in
  Ruling 8 also use kind `bad_request`.
- **Ruling 12. Arrival people** gain optional `email_status` (`verified`, `guessed`, `unavailable`,
  `bounced`, the accounts fact values) and `seniority` (text up to 40). Intake writes them as the
  person facts `email_status` and `seniority`, with the arrival's provenance (ENR-E4-S1-AC1).

## Stories

### ENR-E4-S1 Results land with provenance
As a leader, I want enriched data to show which provider it came from and when, so that I can trust or
question it.
- ENR-E4-S1-AC1 After a `people_for_roles` request, new people show the provider as source and the
  request in their history; a revealed email has `email_status` from the provider.
- ENR-E4-S1-AC2 A provider value that disagrees with an existing one opens a conflict (ACC-E3), not an
  overwrite.

### ENR-E4-S2 Failures keep what was found
As an operator, I want a run that fails part-way to keep its results and tell me why, so that credits
aren't wasted.
- ENR-E4-S2-AC1 A run stubbed to fail with `out_of_credits` after 7 of 25 companies submits 7 arrivals,
  marks the run `partial`, and publishes `enrichment.search.completed` with `partial: true`.
- ENR-E4-S2-AC2 An `auth` failure marks the connection unhealthy in INT and the request page says
  "Apollo rejected the key. An owner needs to update it in Integrations."
- ENR-E4-S2-AC3 Each error kind follows its handling in the table (unit tests with a stub provider).
