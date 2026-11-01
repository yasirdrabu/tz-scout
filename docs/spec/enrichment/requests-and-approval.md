# ENR-E1 Requests and approval

Status: Draft · Release: R2 (person-started requests, agent flags and the approval queue; D33). In R1
enrichment runs only through saved searches and scheduled pulls (ENR-E2).

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
