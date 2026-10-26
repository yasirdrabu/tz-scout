# API-E2 Async work and batches

Release R1

## Why

Async is the default (D8). An agent sends accounts, gets ids back in milliseconds, and follows up by
polling or webhook. Agents can send one account or a batch with run notes and files (answer 11).

## Rules

- Commands that start work return `202 Accepted` with the new resource and
  `"status_url": "https://scout.taazaa.ai/v1/arrivals/arr_..."`. The resource itself is the status;
  there is no separate operations resource.
- Arrival status values: `received` → `resolving` → `resolved` (with `account_id`, `created_account`
  true or false, `duplicate_of` if it matched) or `rejected` (with `reason`: `invalid`, `excluded`,
  `daily_cap_reached`, `duplicate_in_batch`). Resolved arrivals then follow the account's stage via
  `GET /accounts/{id}/status`.
- Target: an arrival is `resolved` within 10 seconds at p95 when no enrichment is needed.
- **Batch request:**

```json
POST /v1/batches
{
  "name": "Florida transit agencies, week 43",
  "run_at": "2026-10-24T18:00:00Z",
  "notes": "Searched county RFP portals for paratransit software notices.",
  "criteria": { "industries": ["Public transit"], "regions": ["FL"] },
  "metadata": { "agent_version": "1.4.0" },
  "items": [
    {
      "external_ref": "row-17",
      "account": { "name": "Miami-Dade County DTPW", "domain": "miamidade.gov" },
      "people": [{ "name": "Jarice Rodriguez", "title": "Chief of Paratransit Operations", "buying_role": "business_owner" }],
      "signals": [{ "type": "trigger", "title": "Software-only re-solicitation approved", "occurred_at": "2026-06-02", "url": "https://..." }],
      "facts": { "employees": 2400 },
      "warm_intro": null,
      "notes": "Trapeze is the incumbent, extended to 2029."
    }
  ]
}
```

  Response `202 { "batch_id": "bat_...", "status_url": ".../v1/batches/bat_...", "item_count": 1 }`.
- A batch is accepted whole or rejected whole for request-level problems (bad JSON, over 1,000
  items, over size). Item-level problems reject only that item; the batch still runs.
- Files attach after creation with `POST /batches/{id}/files` (multipart, up to 25 MB each, 10 per
  batch: CSV, XLSX, MD, PDF, TXT). Files are stored, linked to the batch, and visible to reviewers;
  they are not parsed unless sent through `/imports`.
- `GET /batches/{id}` returns counts by arrival status and by account stage, `completed_at` once every
  item is resolved or rejected, and the batch metadata. `intake.batch.completed` fires then.

## Stories

### API-E2-S1 Send one account
As an agent builder, I want to send one account and get an id at once, so that my agent doesn't wait
on scoring.
- API-E2-S1-AC1 `POST /arrivals` returns 202 with `arrival_id` within 300 ms p95.
- API-E2-S1-AC2 `GET /arrivals/{id}` moves to `resolved` with an `account_id` without further calls.

### API-E2-S2 Send a batch with context
As an AE running a research agent, I want to send 200 accounts with notes about the run, so that the
reviewer knows how they were found.
- API-E2-S2-AC1 Batch name, run date, notes, criteria and metadata are stored and shown on the batch
  page in the web app.
- API-E2-S2-AC2 Item results are listed with the caller's `external_ref`.

### API-E2-S3 Follow up later
As an agent, I want to ask what happened to everything I sent this month, so that I can report back
to my person.
- API-E2-S3-AC1 `GET /arrivals?since=2026-10-01` returns each arrival with `account_id` and current
  stage.
