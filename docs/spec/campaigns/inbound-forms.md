# CMP-E4 Inbound forms as arrivals

Release R1 (v1 path alias), R2 (per-form endpoint) · Endpoint and intake owned by SRC-E6
(`sources-and-intake/inbound-webhooks.md`); this file records how v1's lead validation maps onto the
shared steps, and the campaign attribution Campaigns relies on.

## Why

In v1, a form fill created a `Lead` that ran seven validation checks on its own path. In Scout,
**every form fill is an arrival** and goes through the same steps as every other source (decision D3).
One review queue, one funnel, one set of rules. Existing forms keep working during the move.

## How the v1 checks map

| v1 check | Where it lives now |
|---|---|
| Work email (not free provider, domain resolves) | Sources and intake: resolve step; a free-provider email with no company is held as "needs review" with the reason |
| Company size in target range | Scoring and matching: fit |
| Revenue band in target range | Scoring and matching: fit |
| Industry in target list and not excluded | Scoring and matching: fit and exclusions |
| Role and seniority match target titles | Accounts: the person's buying role; Scoring: buyer on file |
| Timeline from form answer | Accounts: a fact of kind `form_answer` (SRC-E6), read by Scoring as a timing signal |
| Not an existing customer or open deal | CRM sync: the CRM check before review (CRM-E7-S2) |
| Research note | Playbooks: the brief |

All pass, any fail and any unknown no longer route automatically: the account lands in the review
queue with its scores and reasons, and a person decides (decision D6).

## Rules

- Each web form is a source of kind `web_form` with its own token, and posts to
  `POST /api/v1/inbound/forms/{sourceId}` (SRC-E6). Today's form body is accepted unchanged.
- **Campaign attribution:** the form body may also carry `utm_source`, `utm_medium`, `utm_campaign`,
  `utm_content`, `campaign_id` and `statement_id`. SRC keeps them as `form_answer` facts on the
  arrival; Campaigns reads them through Accounts to tie a form fill to a message test or ad campaign.
- **v1 path alias (R1):** `POST /api/webhooks/form/{company-slug}` with the v1 shared secret keeps
  working until every form is moved. It forwards to the tenant's default web form source. Each use is
  logged.
- SMS consent from the form is stored on the person (Accounts) and read by reminders (CMP-E5).

## Stories

### CMP-E4-S1 Keep the old webhook working
As an owner, I want existing forms to keep working through the move, so that no lead is lost.
- CMP-E4-S1-AC1 A post to the v1 path creates one arrival from the tenant's default web form source,
  with the body exactly as posted, and answers 202 with `arrival_id`.
- CMP-E4-S1-AC2 Each use of the v1 path is logged so we know when it can be turned off.

### CMP-E4-S2 Campaign attribution
As a CRO, I want to know which campaign and statement a form fill came from, so that ads are judged on
pipeline, not clicks.
- CMP-E4-S2-AC1 `campaign_id`, `statement_id` and `utm_*` sent with a form fill are visible on the
  account's source path and available to Campaigns and Analytics.
- CMP-E4-S2-AC2 A form fill attributed to a statement counts toward that statement's message test in
  the library (form fills per statement).
