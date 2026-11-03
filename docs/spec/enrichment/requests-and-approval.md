# ENR-E1 Requests and approval

Status: Shipped in R2b-2 · Release: R2 (person-started requests, agent flags and the approval queue;
D33). In R1 enrichment runs only through saved searches and scheduled pulls (ENR-E2).

R2b-2 shipped plan docs/plans/2026-11-03-r2b-2-enrichment.md. Its rulings for requests are below
("R2b-2 rulings"); where they differ from the Rules, the rulings win.

## Why

Enrichment costs money. Agents may spot a gap ("no technical buyer at this account") but must not
spend on their own (D7). A person sees the estimate and decides.

## Rules

- **Kinds:**

  | Kind | What it does | Typical provider |
  |---|---|---|
  | `company_firmographics` | Size, revenue, industry, location, tech, growth | Apollo company enrich |
  | `people_for_roles` | Find people for given buying roles and titles | Apollo people search |
  | `email_reveal` | Reveal email for named people | Apollo |
  | `website_read` | Read the company's site: description, offering, industry, clues to size and tech | Claude (`read_website`) |
  | `signals_refresh` | Hiring, news, funding, leadership since a date | Apollo job postings and news |

- **Status:** `flagged` → `approved` or `declined` → `running` → `completed` or `failed`;
  `cancelled` from `flagged` or `approved`. A person with `enrichment:approve` who starts a request in
  the web app approves it in the same step (they see the estimate first).
- **Estimate**: from `provider_price` for the operation times the expected count (for example,
  `people_for_roles` for 2 roles, up to 3 people each, with email reveal: up to 6 reveal credits).
  Shown as credits and money: "Up to 6 credits, about $0.60".
- **Who may approve**: owners and leaders by default; any user granted `enrichment:approve`. Agents
  and keys never.
- **Duplicates**: a second request of the same kind for the same account while one is open joins the
  open one (the second requester is added as a watcher) instead of creating another.
- **Agent flags** appear in the review queue as a badge on the account ("Enrichment requested by
  Yasir's agent") and in Enrichment, Requests. The flag's reason is shown.
- A flagged request not decided in 14 days expires (`cancelled`, reason `expired`) and the agent sees
  that in its feedback.

## R2b-2 rulings

Rulings 1 to 3 are the user's answers of 2026-11-03; the rest are Claude's calls, 2026-11-03. Rulings
2 and 3 (Vibe, the website) are in [providers-and-saved-searches.md](providers-and-saved-searches.md),
Rulings 4 and 5 (credits, money) in [credits-costs-and-caps.md](credits-costs-and-caps.md), and Rulings
8, 9 and 12 (the run, errors, arrival people) in [results-and-failures.md](results-and-failures.md).

- **Ruling 1 (user). Who runs what.**
   - A person with `enrichment:approve` (owners and leaders) who starts a request creates it
     `approved`, and it runs.
   - A person with only `enrichment:request` (sellers, operators) creates it `flagged`. It waits for
     approval.
   - An API key or OAuth grant always creates `flagged`.
   - Approve and decline are people only, with the 403 detail "Only a person can approve spend."
- **Ruling 6. Duplicates.** A second request of the same kind for the same account, while one is
   `flagged`, `approved` or `running`, joins it. The requester's principal id is added to `watchers`, and the API
   returns the open request with 200 and `joined: true`. If the joiner may approve and the open request
   is `flagged`, joining also approves it. Known limit: a join keeps the open request's provider and
   roles, so a joiner who asked for a different provider or other roles gets the open request as it is.
- **Ruling 7. Statuses.** `flagged` → `approved` | `declined` | `cancelled`. Then `approved` →
   `running` | `cancelled`, and `running` → `completed` | `partial` | `failed`. `partial` is a completed run that
   stopped early and kept what it found. `waiting_reason` (text, null) is set while an approved request
   waits on a usage limit, and cleared when it runs (and on cancel).
   - **Cancel:** `:cancel` is allowed from `flagged` or `approved`. It needs `enrichment:approve`, or
     the requester themselves.
   - **Expiry:** a request `flagged` for 14 days becomes `cancelled` with `decline_reason: 'expired'`.
     The same daily job fails requests stuck `approved` or `running` (results-and-failures.md, Ruling 9).
     The job is `enrichment.request.expire` and runs daily at `0 4 * * *` UTC. Its schedule is ensured
     (idempotently, `ensureSchedule`) whenever a request is created, so existing workspaces need no
     back-fill. `ensureSchedule` never changes an existing schedule's cron; a later cron change needs
     `upsertSchedule`.
   - **A wrong move** is 409 "This request is already {status}.", in status words: "waiting for
     approval", "approved", "running", "declined", "cancelled", "expired", "done" (completed or
     partial), "failed".
- **Ruling 10. Feedback.**
    - **Decline:** a decline of a request with a `requesting_source_id` records `enrichment_declined`
      feedback for that one source (not the rest of the account's source chains), through intake's
      `recordSourceFeedback`.
    - **Expiry:** an expiry records the new kind `enrichment_expired`, labelled "Enrichment request
      expired".
    - **No arrival yet:** when the source has no resolved arrival for the account (an agent flagged an
      account it never sent), the feedback row has a null `arrival_id`. The column, and
      `arrivalId` on `intake.feedback.recorded`, are nullable from R2b-2. The event stays at version 1:
      it has no consumer yet (final review M3, accepted). Bump it, or say so in the webhook docs, before
      outbound webhooks ship.
- **Ruling 11. Queue chip.** Routing keeps table `routing.enrichment_open (tenant_id, account_id,
    request_id, requested_by_label, closed_at, created_at; PK tenant + request)`.
    - A routing consumer inserts a row on `flagged` or `approved`, and closes it on `declined`,
      `completed`, `failed` or `cancelled`. Cancel is its own event, `enrichment.request.cancelled
      {requestId, accountId, reason}`. A closed row stays as a tombstone (`closed_at`), so a late
      `flagged` or `approved` cannot reopen it.
    - `QueueRow.enrichment_requested` is true while an open row exists for the account, and
      `enrichment_requested_by` is its label (the newest open row's, by when routing stored it). Two
      open kinds make one chip, which clears only when both close.
    - The chip text stays "Enrichment requested". The peek shows "Enrichment requested by {label}".
      The "Waiting on enrichment" review status is deferred.
- **Ruling 13. No MCP server exists**, so `flag_for_enrichment` ships as the REST route only (`POST
    /api/v1/accounts/{id}/enrichment-requests` with a key). The mapping from `what` to a kind under
    "MCP tools" below is kept for when the server is built; no code is written for it now.
- **Ruling 14. Deferred:** saved searches (ENR-E2-S2); `provider_price` and its Settings screen;
    `integrations.usage.recorded` and ANL cost lines (R3a), so ENR-E3-S1-AC2 waits for R3a; API-key
    enrichment credit limits (keys never spend; they only flag); "Find" on committee gaps (R2b-3 wires
    it to the Enrich dialog); the "Waiting on enrichment" review status; owner email notices.

**Request JSON:** `{id, account_id, account_name, kind, kind_label, provider_key, provider_name,
status, status_text, requested_by_label, reason, estimate {credits, cost_cents, text}, created_at,
decided_by_label, decided_at, decline_reason, result, error, waiting_reason, sample}`. The list takes
`limit` (default 50, at most 200), pages newest first, and returns only requests for accounts the
caller can see.

**Kind labels:**

| Kind | Label |
|---|---|
| `company_firmographics` | Company facts |
| `people_for_roles` | People for buying roles |
| `email_reveal` | Reveal emails |
| `website_read` | Read the website |
| `signals_refresh` | Fresh signals |

**`status_text`:**

| Status | Text |
|---|---|
| `flagged` | "Waiting for approval" |
| `approved` | "Starting", or `waiting_reason` when set |
| `running` | "Running", or `waiting_reason` when set (a wait on a limit mid-run), else a retry's `error.message` while the job backs off |
| `completed` | "Found {n}", or the nothing-found message when `found` is 0 |
| `partial` | "Found {n}. {message}" |
| `failed` | `error.message` |
| `declined` | "Declined: {reason}" |
| `cancelled` | "Cancelled", or "Expired after 14 days" |

**Errors on create:** a seller's or key's request with no reason is 400 at `reason` "Say why this is
worth the spend."; a decline with no reason is 400 "Say why you're declining."; an account the caller
can't see is 404; a role key or person id that doesn't belong to the account is 400.

**Build rulings (Claude's calls, 2026-11-03):**

- The request stores `decided_by_label` beside `decided_by`, so the list shows the decider's name
  without a lookup.
- `enrichment.request.flagged` and `.approved` carry `requestedByLabel`, for the queue chip.
- The Enrich button shows on the assigned account view too, not only in review: sellers work assigned
  accounts, and Ruling 1 lets them ask (screens.md §4).

## Stories

### ENR-E1-S1 Start an enrichment
As a leader, I want to enrich an account with a clear estimate first, so that I only spend when it's
worth it.
- ENR-E1-S1-AC1 From the account page ("Enrich", or "Find" on a committee gap) the person picks the
  kind and provider, sees the estimate, and confirms; the request is created `approved` and runs.
- ENR-E1-S1-AC2 With the provider's integration on mock, the run returns seeded results and the
  estimate is labelled "Sample".

### ENR-E1-S2 Agents flag, people decide
As an agent, I want to ask for enrichment and say why, so that a person can decide quickly.
- ENR-E1-S2-AC1 `flag_for_enrichment` creates a `flagged` request and returns its id and status
  "waiting for a person to approve"; it never runs on its own.
- ENR-E1-S2-AC2 `POST /api/v1/enrichment-requests/{id}:approve` from an API key or OAuth grant is refused
  with `403` and the message "Only a person can approve spend."

### ENR-E1-S3 Approval queue
As a leader, I want one list of enrichment requests waiting for me, so that agents aren't blocked for
long.
- ENR-E1-S3-AC1 Enrichment, Requests lists flagged requests with account, kind, requester, reason,
  estimate and age; Approve and Decline (reason required) are one click each.
- ENR-E1-S3-AC2 Approving or declining publishes the event and records feedback for the requesting
  source (declines only).
- ENR-E1-S3-AC3 Requests older than 14 days expire as in Rules (unit test on the expiry job).

## MCP tools

`flag_for_enrichment`, as defined in [mcp/agent-tools.md](../mcp/agent-tools.md): input `account_id`,
`what`, `roles_wanted`, `provider_hint`, `reason`; output `request_id`, `status: flagged`, `summary`
with the estimate. Mapping to request kinds:

| `what` | Kind | Notes |
|---|---|---|
| `people` | `people_for_roles` (with email reveal for the people found) | `roles_wanted` become the roles; titles come from the account's best offer (OFF) |
| `company_facts` | `company_firmographics` | A reviewer may switch it to `website_read` before approving |
| `signals` | `signals_refresh` | Since the account's newest signal |

`provider_hint` (`apollo` or `vibe`) preselects the provider; the approver may switch it before
approving.
