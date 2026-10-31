# SRC-E2 Arrivals and batches

Status: Draft · Release: R1

## Why

Agents, vendors and partners send accounts one at a time or in runs. Scout keeps exactly what they
said (D13), answers immediately with an id (D8, async by default), and lets them track every item.
A batch is a first-class record of a run: when it ran, how many it sent, what the agent was looking
for, notes and files.

## The arrival contract (`arrival.v1`)

Every way in (API, MCP, file import, webhooks, enrichment) produces this shape. Its parts are the
shared MCP shapes in [mcp/agent-tools.md](../mcp/agent-tools.md) (`AccountInput`, `PersonInput`,
`SignalInput`, `WarmIntroInput`), extended with fields files and vendors carry. The original request
body (or the original file rows with their header row) is stored alongside as `payload.raw`.

```json
{
  "account": {
    "name": "Miami-Dade County DTPW",
    "domain": "miamidade.gov",
    "website": "https://www.miamidade.gov/global/transportation/home.page",
    "linkedin_url": null,
    "country": "US", "region": "FL", "city": "Miami",
    "industry": "Public transportation",
    "employees": 3000,
    "revenue_cents": null,
    "notes": "Found while researching Florida CTCs.",
    "practice_hint": "ai-operating-platforms",
    "offer_hint": null,
    "external_ref": "yasir-agent-2026-10-25-0041",

    "description": "Florida's largest community transportation coordinator.",
    "employees_range": null, "revenue_range": null,
    "technologies": ["Trapeze PASS"], "keywords": ["paratransit", "microtransit"],
    "parent_domain": null,
    "custom_fields": { "abm_motion": "tier_1_one_to_one", "fleet_tier": "unverified" }
  },
  "people": [
    { "name": "Jarice Rodriguez",
      "title": "Chief of Paratransit Operations & Mobility Services",
      "buying_role": "business_owner", "email": null, "phone": null, "linkedin_url": null,
      "notes": "Leads STS; FPTA 2026 speaker." }
  ],
  "signals": [
    { "type": "trigger", "title": "Software-only re-solicitation approved (R-481-26)",
      "occurred_at": "2026-06-02", "url": "https://…", "detail": null, "confidence": 0.9 }
  ],
  "facts": { "contract_value_cents": 2090000000 },
  "warm_intro": { "introducer_name": "Ashkan Eskandari", "introducer_email": "ash@taazaa.com",
                  "relationship": "knows the CTC director from FPTA", "note": null },

  "research": {
    "hook": "…", "problem": "…", "pilot": "…", "price_cents": null, "value_hypothesis": "…",
    "incumbent": "Trapeze", "caveats": "Cone of silence once the RFP is out", "contact_route": "…",
    "next_action": "…", "researcher_score": 79, "researcher_tier": "A"
  },
  "sole_proprietor": false,
  "via_vendor": "apollo",
  "target_account_id": null
}
```

Field rules:
- **Identity.** API and MCP arrivals need `account.name` and one of `domain`, `website`,
  `linkedin_url` (strict validation; otherwise `rejected` / `invalid`). File imports, web forms and
  CRM webhooks may arrive without a website; those wait for a person (SRC-E3, `needs_website`).
- **People** accept `name` (split into first and last by ACC) or `first_name` and `last_name`; one
  `buying_role` or a `buying_roles` list (keys from the tenant's list, ACC-E2); `notes` is the
  decision note. Max 25 people.
- **Signals** accept the coarse `type` from the MCP shape (`research`, `trigger`, `pain`, stored as the
  signal's kind) or a fine type from ACC-E4 (`funding`, `hiring`, ...) in `fine_type`; `occurred_at` is
  required; `confidence` 0 to 1. Max 50 signals.
- **Facts** are either an object of field to value (observed now, no link) or a list of
  `{ key, value, observed_at, url, note }` with provenance detail. Keys are ACC fact keys or custom
  field keys (ACC-E6); unknown keys stay in the raw payload and are listed as "not used" on the
  arrival page. Max 200.
- **Warm intro** `relationship` is free text, mapped to a relationship key (SRC-E5); a
  `relationship_key` may be sent instead. An introducer whose email matches a tenant user is linked to
  that user.
- **Research** fields become facts of kind `research` and feed the brief.
- `sole_proprietor: true` with a person and no company makes a **shell account** (ACC-E1); `name` is
  the person's name.
- `target_account_id` attaches the arrival to that account without duplicate checks; used by ENR and
  by `add_person` / `add_signal`. The principal must be able to see that account.
- `account.external_ref` is de-duplicated per source: the same ref from the same source returns the
  existing arrival.
- Max payload 256 KB per arrival.

## Batch fields

`name` (required), `run_at` (when the run happened; defaults to now), `notes`, `criteria` (free JSON:
what the agent was asked to find, filters used), `metadata` (free JSON; Scout reads
`metadata.reported_cost` `{ credits, cost_cents, currency }` for vendor runs it can't meter), up to
10 files (25 MB each), and 1 to 1,000 items sent in the one `POST /api/v1/batches` call. A batch is
`completed` when every item is resolved or rejected.

## Arrival status (what callers see)

`received` → `resolving` → `resolved` (with `account_id`) or `rejected` (with `reason`).

- While `resolving`, an arrival may be waiting for a person; the response then carries `waiting_on`:
  `needs_website`, `needs_company` or `possible_duplicate` (SRC-E3). It stays `resolving` until the
  person acts.
- Reject reasons (fixed list): `invalid`, `excluded`, `daily_cap_reached`, `duplicate_in_batch`. Each
  comes with a `detail` sentence.
  - `excluded`: the arrival resolved to an account ACC rules out (ACC-E7). The account is still kept,
    marked "Ruled out", and a person can override; `account_id` is set.
  - `duplicate_in_batch`: a later item in the same batch with the same `external_ref` or the same
    normalised domain as an earlier item.
- After `resolved`, `GET /api/v1/arrivals/{id}` also shows the account's stage, review status and owner
  name as far as the principal's scopes allow (from REV), plus any feedback (SRC-E1-S4).

## Stories

### SRC-E2-S1 Send one account
As an agent, I want to send one account and get an id straight away, so that I can move on and check
back later.
- SRC-E2-S1-AC1 `POST /api/v1/arrivals` with a valid body returns `202` with `arrival_id` and
  `status_url` within 300 ms p95; the arrival row and `intake.arrival.received` are committed in one
  transaction.
- SRC-E2-S1-AC2 The stored `payload.raw` is exactly what was sent; nobody can edit an arrival.
- SRC-E2-S1-AC3 The same `Idempotency-Key`, or the same `external_ref` from the same source, returns
  the original arrival instead of a new one.
- SRC-E2-S1-AC4 An invalid body returns `400` problem details with every failing path; nothing is
  stored.
- SRC-E2-S1-AC5 The source chain is taken from the key's `source_id`, never from the body.
- SRC-E2-S1-AC6 Before storing, intake calls INT `checkCap` for the source's daily arrival cap; over
  the cap a single arrival gets `429` with `Retry-After` (SRC-E1-S2).

### SRC-E2-S2 Send a batch
As an agent or vendor, I want to send a run of accounts as one batch with notes and files, so that the
run can be tracked and judged as a whole.
- SRC-E2-S2-AC1 `POST /api/v1/batches` creates the batch with its fields and 1 to 1,000 items; the
  response lists an `arr_` id per item in the order sent.
- SRC-E2-S2-AC2 `POST /api/v1/batches/{id}/files` attaches files (25 MB each, 10 per batch); each is stored
  with its SHA-256 and listed on the batch page.
- SRC-E2-S2-AC3 Items past the source's daily cap are stored and rejected `daily_cap_reached`; items
  repeating an earlier item are rejected `duplicate_in_batch`.
- SRC-E2-S2-AC4 When every item is resolved or rejected, `intake.batch.completed` is published with
  counts and `reported_cost`.
- SRC-E2-S2-AC5 The Batches page lists batches with source chain, run date, counts (new accounts,
  already known, waiting, rejected), and links to the accounts it produced.

### SRC-E2-S3 Track what I sent
As an agent, I want to ask about my batch or my recent submissions, so that I can report back to the
person who runs me.
- SRC-E2-S3-AC1 `GET /api/v1/batches/{id}` and `get_batch_status` return counts (`resolved`, `rejected`,
  `new_accounts`, `already_known`), counts by stage, and rejections with `external_ref`, reason and
  detail; `GET /api/v1/batches/{id}/items` pages through every item.
- SRC-E2-S3-AC2 `list_my_submissions(since, stage)` returns the principal's own arrivals only, with
  account name, stage, review status, owner name and last activity.
- SRC-E2-S3-AC3 A principal with data limit `own_source` gets `404` for an arrival or batch from
  another source.

### SRC-E2-S4 Arrival page in the web app
As a leader, I want to open any arrival and see exactly what was sent and what Scout did with it, so
that every decision is explainable.
- SRC-E2-S4-AC1 The arrival page shows the raw payload, the parsed fields, the source chain with trust,
  the duplicate candidates considered and the result, and any unused fields.
- SRC-E2-S4-AC2 The account page lists every arrival that touched the account, newest first.

## MCP tools

Defined in [mcp/agent-tools.md](../mcp/agent-tools.md); this module implements them.

| Tool | Notes for this module |
|---|---|
| `submit_account` | Builds an `arrival.v1` from `account`, `people`, `signals`, `facts`, `warm_intro` and submits it |
| `submit_batch` | `POST /api/v1/batches` semantics, up to 1,000 items in one call |
| `get_batch_status` | Counts, stages and rejections as in SRC-E2-S3 |
| `list_my_submissions` | Own source's arrivals with stage |
