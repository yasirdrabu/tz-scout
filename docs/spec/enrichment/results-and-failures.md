# ENR-E4 Results and failures

Status: Draft · Release: R1

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
