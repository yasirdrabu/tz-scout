# MCP-E2 Agent tools

Release R1 (submission and status tools), R2 (`get_account_brief`, `flag_for_enrichment`)

## Guidance for every tool

- **Verb-first names,** one job each. Descriptions are written for a model: what the tool does, when
  to use it, when not to, and what to call next.
- **Results are short and explainable.** Return ids the agent will need next, a one-line `summary` in
  plain words, and `next` with suggested tool calls. Never return whole records when the agent only
  needs status.
- **Ids are prefixed** (`acc_`, `arr_`, `bat_`) so agents don't mix them up.
- **Async is explicit.** Submission tools say "accepted, check with get_account_status or
  get_batch_status"; they never pretend the account is scored yet.
- **Contact details** appear only if the principal has `people:read`.
- **Errors** are sentences the model can act on, plus a machine `code`.
- All inputs are validated with the same Zod schemas as the API; the JSON schemas below are summaries.

## Shared shapes

`AccountInput`:

| Field | Type | Req | Notes |
|---|---|---|---|
| `name` | string | yes | Company name, or a person's name for a sole proprietor |
| `domain` | string | one of domain, website, linkedin_url | `acme.com` |
| `website` | string (url) | | |
| `linkedin_url` | string (url) | | |
| `country`, `region`, `city` | string | | |
| `industry` | string | | Free text; Scout normalises it |
| `employees` | integer | | |
| `revenue_cents` | integer | | |
| `notes` | string (max 4,000) | | What the agent found and why it matters |
| `practice_hint` | string | | Practice name or id the agent thinks fits |
| `offer_hint` | string | | Offer slug or id |
| `external_ref` | string | | The agent's own id, for de-duplication and follow-up |

`PersonInput`: `name` (req), `title`, `buying_role` (one of the tenant's buying roles, e.g.
`commercial_buyer`, `technical_buyer`, `business_owner`, `influencer`, `procurement`, `champion`),
`email`, `phone`, `linkedin_url`, `notes` (decision-making note).

`SignalInput`: `type` (`research`, `trigger`, `pain`), `title` (req), `detail`, `occurred_at` (date,
req), `url` (source link, strongly recommended), `confidence` (0 to 1).

`WarmIntroInput`: `introducer_name` (req), `introducer_email`, `relationship` (free text), `note`.

## Tools

### submit_account

Description for the model: "Send one company to Scout for review. Include what you know: people with
their buying roles, dated signals with links, and notes on why now. Scout stores it, removes
duplicates, scores it and puts it in a person's review queue; nothing is sent to a CRM until a person
approves. Returns at once with an arrival id. Use get_account_status later to follow it. For more than
5 companies, use submit_batch."

Input: `account` (AccountInput, req), `people` (PersonInput[], max 25), `signals` (SignalInput[], max
50), `facts` (object of field to value, optional), `warm_intro` (WarmIntroInput, optional).

Output:
```json
{
  "arrival_id": "arr_01JBX2...",
  "status": "received",
  "summary": "Received Miami-Dade County DTPW. Scout will match it to an account and score it in a few seconds.",
  "next": [{ "tool": "get_account_status", "args": { "arrival_id": "arr_01JBX2..." } }]
}
```
Scopes: `arrivals:write`. Errors: `cap_reached` ("You've sent 500 accounts today, the limit for this
connection. It resets at midnight Eastern."), `validation`.

### submit_batch

Description: "Send many companies at once (up to 1,000) with notes about how you found them. Use this
for research runs. Returns a batch id; use get_batch_status to see progress."

Input: `name` (req), `run_at` (datetime), `notes`, `criteria` (object), `items` (array of
`{ account, people, signals, facts, warm_intro }`, req, 1 to 1,000).

Output: `{ "batch_id": "bat_...", "item_count": 42, "summary": "Batch of 42 received.", "next": [{ "tool": "get_batch_status", "args": { "batch_id": "bat_..." } }] }`.
Scopes: `arrivals:write`.

### get_batch_status

Description: "See how a batch you sent is doing: how many are matched, new, rejected, and how far each
has got (reviewed, assigned, in the CRM, won)."

Input: `batch_id` (req), `include_items` (boolean, default false), `cursor`.

Output:
```json
{
  "batch_id": "bat_...",
  "completed": true,
  "counts": { "resolved": 40, "rejected": 2, "new_accounts": 31, "already_known": 9 },
  "stages": { "arrived": 22, "reviewed": 10, "assigned": 6, "declined": 2 },
  "rejections": [{ "external_ref": "row-9", "reason": "excluded", "detail": "Software vendor, excluded by the tenant's rules." }],
  "summary": "40 of 42 accepted. 6 already assigned to sellers."
}
```
Scopes: `arrivals:read`.

### list_my_submissions

Description: "List what your source has sent, newest first, with each account's current stage. Use
this to report back on results."

Input: `since` (date), `stage` (optional filter), `limit` (default 25, max 100), `cursor`.
Output: `{ "items": [{ "arrival_id", "account_id", "account_name", "stage", "review_status", "owner_name", "last_activity_at" }], "next_cursor" }`.
Scopes: `arrivals:read`.

### get_account_status

Description: "Get where one account stands: its stage, review status, who owns it and when something
last happened. Pass either the account id or the arrival id you got when you sent it."

Input: `account_id` or `arrival_id` (one required).

Output:
```json
{
  "account_id": "acc_...",
  "name": "Miami-Dade County DTPW",
  "stage": "assigned",
  "review_status": "reviewed",
  "tier": "act_now",
  "owner_name": "Ashkan Eskandari",
  "last_activity_at": "2026-10-24T15:10:00Z",
  "declined_reason": null,
  "summary": "Assigned to Ashkan on Oct 22. First email sent Oct 24."
}
```
Scopes: `status:read`.

### find_accounts

Description: "Search accounts you're allowed to see, by name, domain, practice, offer, tier, stage or
signal type. Use it before submitting to check whether Scout already knows a company."

Input: `query` (text), `domain`, `practice`, `offer`, `tier` (`act_now`, `good_fit`, `watch`,
`not_fit`), `stage`, `signal_type`, `limit` (default 10, max 50), `cursor`.
Output: `{ "items": [{ "account_id", "name", "domain", "tier", "priority", "best_offer", "stage" }], "next_cursor", "summary" }`.
Scopes: `accounts:read`.

### get_account_brief

Description: "Get the full brief for an account: overview, why now with dated signals, buying
committee and gaps, approach, value angle, risks and the playbook steps. Use this to prepare outreach
or to decide what research is missing."

Input: `account_id` (req), `sections` (optional list).
Output: `{ "account_id", "sections": [{ "key": "why_now", "title": "Why now", "text": "...", "citations": ["sig_...", "fct_..."], "written_by": "claude|rules|person" }], "committee": [...], "gaps": [...], "plan": { "playbook": "Public sector RFP", "steps": [...] } }`.
Scopes: `playbooks:read` (people's contact details need `people:read`).

### explain_score

Description: "Explain why an account has its score and tier, factor by factor, and what would raise
it. Use this to decide what extra research to send."

Input: `account_id` (req), `offer_id` (optional; default best offer).
Output:
```json
{
  "account_id": "acc_...",
  "offer": "Modernization Blueprint",
  "priority": 79, "fit": 85, "intent": 70, "tier": "act_now",
  "factors": [
    { "name": "Industry match", "points": 20, "max": 20, "reason": "Public transit is a target industry." },
    { "name": "Recent trigger", "points": 18, "max": 25, "reason": "Re-solicitation approved Jun 2, 2026. Fades over 45 days." }
  ],
  "warm_intro_points": 0,
  "would_raise": ["A technical buyer on file", "A research signal in the last 30 days"]
}
```
Scopes: `accounts:read`.

### add_person

Description: "Add a person at an account with their buying role and a note on how they influence the
decision. Use when you find someone missing from the buying committee."

Input: `account_id` (req), `person` (PersonInput, req).
Output: `{ "person_id": "per_...", "summary": "Added Alonzo Joseph as commercial buyer.", "committee_gaps": ["technical_buyer"] }`.
Scopes: `people:write`. Duplicate people (same email or same name at the account) return the existing
`person_id` with `"already_known": true`. Under the hood this is a targeted SRC arrival with
`inline: true` (D23): it is stored as received, credited to the caller's source, and resolved within
the call; the output also carries `arrival_id`.

### add_signal

Description: "Add a dated signal to an account, with a link to where you found it. Signals drive the
'why now' and the score."

Input: `account_id` (req), `signal` (SignalInput, req).
Output: `{ "signal_id": "sig_...", "arrival_id": "arr_...", "summary": "Added. The account will be rescored in a few seconds." }`.
Scopes: `signals:write`. Like `add_person`, this is a targeted SRC arrival with `inline: true`.

### flag_for_enrichment

Description: "Ask a person to approve enriching an account from a data provider (for example to find
the technical buyer's email). You can't spend credits yourself; a person approves or declines."

Input: `account_id` (req), `what` (`people`, `company_facts`, `signals`; req), `roles_wanted` (buying
roles, optional), `provider_hint` (`apollo`, `vibe`, optional), `reason` (req, max 500).
Output: `{ "request_id": "enr_...", "status": "flagged", "summary": "Flagged for approval. Estimated cost 12 credits." }`.
Scopes: `enrichment:request`.

### list_offers

Description: "List the practices and offers this company sells, with who they're for. Use this to aim
research at the right companies and to set offer_hint."

Input: `practice` (optional).
Output: `{ "practices": [{ "practice_id", "name", "offers": [{ "offer_id", "slug", "name", "promise", "target_titles", "industries", "company_size", "price_range" }] }] }`.
Scopes: `offers:read`.

### get_source_performance

Description: "See how the accounts you sent have done: how many were reviewed, assigned, engaged,
became opportunities or were won, why any were declined, and how your trust score has moved. Use it
to aim your next research run."

Input: `source_id` (optional; defaults to the caller's own source; another source needs
`analytics:read` and a data limit that includes it), `from`, `to` (optional dates; default last 90
days).
Output: `{ "source_id", "name", "trust": 0.66, "trust_trend": [{ "week", "trust" }], "funnel": [{ "stage", "count", "rate_from_previous" }], "decline_reasons": [{ "reason", "count" }], "summary": "Of 120 accounts, 41 were reviewed and 3 became opportunities. Most declines: wrong company size." }`.
Scopes: own source always; others `analytics:read`. Backed by `GET /v1/analytics/sources/{id}/performance` (ANL).

## Stories

### MCP-E2-S1 Research and submit
As an AE using Claude, I want my agent to check whether Scout knows a company, then submit it with
people and signals, so that good research lands in the review queue with no copy and paste.
- MCP-E2-S1-AC1 An agent can call `find_accounts`, then `submit_account`, then `get_account_status`
  and see the account resolved with a tier.
- MCP-E2-S1-AC2 Every submitted signal keeps its link and date, visible on the account page.

### MCP-E2-S2 Follow up
As an agent, I want to report back on what my person sent, so that they know what turned into
pipeline.
- MCP-E2-S2-AC1 `list_my_submissions` returns only my source's accounts with their current stage.

### MCP-E2-S3 Helpful errors
- MCP-E2-S3-AC1 Every tool error has a `code` and a sentence that says what to do next.
