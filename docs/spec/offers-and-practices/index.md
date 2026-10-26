# OFF: Offers and practices

Module code OFF · Schema `offers` · Releases R1 to R4

## Purpose

Hold what a tenant sells and the proof behind it: practices (lines of business), offers inside them,
case studies, the buying signals that matter for each offer, how ready each offer is to sell, the
segments it targets, and what past wins say about it. Everything other modules match accounts
against comes from here.

Renames from v1: "bucket" is now **practice**; "offering" is now **offer**.

## What it owns

| Table | Key fields |
|---|---|
| `practice` | `id` (`prc_`), `tenant_id`, `slug`, `name`, `description`, `keywords` (text[], used to file imported sheets), `status` (`active`, `archived`), `default_playbook_id` (id in Playbooks, nullable), `brief_template_key` |
| `offer` | `id` (`off_`), `tenant_id`, `practice_id`, `slug`, `name`, `promise` (one line), `description`, `status` (`draft`, `approved`, `archived`), `price_min_cents`, `price_max_cents`, `gross_margin` (decimal), `typical_deal_cents`, `expansion_rate` (decimal), `expansion_value_cents`, `sales_cycle_days`, `target_titles` (text[]), `target_buying_roles` (text[] of the tenant's buying-role keys, e.g. `business_owner`, `commercial_buyer`, `technical_buyer`), `company_size_min`, `company_size_max`, `revenue_min_cents`, `revenue_max_cents`, `industries` (text[]), `regions` (text[]), `excluded_domains` (text[]), `excluded_categories` (text[]), `proof_points` (text[]), `approved_by`, `approved_at`, `origin` (`manual`, `ai_draft`), `draft_source` (json: url or file name, AI run id) |
| `case_study` | `id`, `tenant_id`, `title`, `client_name`, `industry`, `result`, `link_url`, `public` (bool: may be quoted to buyers), `archived_at` |
| `offer_case_study` | `offer_id`, `case_study_id` |
| `signal_rule` | `id`, `tenant_id`, `offer_id`, `type` (intent, leadership, funding, news, risk, hiring, growth, workforce, tech), `label`, `weight` (points 0 to 100), `match` (text[] keywords), `min_value` (decimal, nullable), `why` (text), `enabled`, `origin` (`default`, `manual`, `win_analysis`) |
| `readiness` | `offer_id`, `score`, `band` (`ready`, `fix_first`, `rework`), `offer_score`, `market_score`, `factors` (json), `fixes` (text[]), `computed_at` |
| `readiness_override` | `offer_id`, `factor_key`, `value` (0 to 10), `note`, `by`, `at` |
| `segment` | `id`, `tenant_id`, `offer_id`, `name`, `buyer`, `problem`, `status` (`proposed`, `shortlisted`, `active`, `rejected`), `origin` (`ai`, `manual`), `audience_size`, `cost_per_click_cents`, `case_study_count`, `score`, `market_half`, `fit_half` |
| `segment_factor` | `segment_id`, `key`, `value` (0 to 10), `reason`, `override_value`, `override_note`, `override_by` |
| `won_deal` | `id`, `tenant_id`, `crm`, `crm_deal_id`, `account_id` (nullable), `name`, `amount_cents`, `closed_at`, `created_at_crm`, `days_to_close`, `industry`, `employees`, `mapped_offer_id`, `mapping` (`auto`, `manual`). Read model built from `crm.deal.changed`. |
| `win_analysis` | `id`, `tenant_id`, `practice_id` (nullable), `run_at`, `deal_count`, `total_cents`, `median_cents`, `median_days_to_close`, `patterns` (json), `suggested_rules` (json), `ai_run_id` |

## Depends on

| Module | For |
|---|---|
| Tenancy and access | permissions (owner approves offers) |
| AI tasks | `offer_draft`, `offer_readiness`, `win_analysis`, `segments` |
| Integrations | reading a URL or file for drafts goes through the shared fetch with the tenant's limits |

Market facts for readiness (accounts matched, act now count, buyers found) come from Scoring and
Accounts through a read model fed by `scoring.account.scored` events, not direct queries.

## Epics

| Epic | File | Release |
|---|---|---|
| OFF-E1 Practices | [practices.md](practices.md) | R1 |
| OFF-E2 Offers and AI drafts | [offers-and-ai-drafts.md](offers-and-ai-drafts.md) | R1 (AI drafts R2) |
| OFF-E3 Case studies and proof | [case-studies-and-proof.md](case-studies-and-proof.md) | R1 |
| OFF-E4 Signal rules per offer | [signal-rules.md](signal-rules.md) | R1 |
| OFF-E5 Offer readiness | [offer-readiness.md](offer-readiness.md) | R2 |
| OFF-E6 Win analysis | [win-analysis.md](win-analysis.md) | R3 |
| OFF-E7 Segments | [segments.md](segments.md) | R4 |

## Events published

| Event | Data |
|---|---|
| `offers.offer.approved` | `offerId`, `practiceId`, `approvedBy` |
| `offers.offer.changed` | `offerId`, `practiceId`, `changed` (field names), `affectsMatching` (bool: fit criteria, signal rules or status changed) |
| `offers.offer.archived` | `offerId`, `practiceId` |
| `offers.practice.changed` | `practiceId`, `changed` |
| `offers.win_analysis.completed` | `winAnalysisId`, `dealCount`, `medianCents` |

Signal rule edits publish `offers.offer.changed` with `affectsMatching: true` (Scoring rescores).

## Events consumed

| Event | Does |
|---|---|
| `crm.deal.changed` (status won) | upsert `won_deal`; auto-map to an offer by name keywords; queue readiness recompute |
| `scoring.account.scored` | update the per-offer market counts used by readiness |
| `accounts.account.merged` | repoint `won_deal.account_id` |

## API endpoints

JSON field names are snake_case.

| Method and path | Scope | Does |
|---|---|---|
| `GET /v1/practices` | `offers:read` | List practices |
| `GET /v1/offers?practice_id&status` | `offers:read` | List offers; approved only unless the principal has `offers:manage` |
| `GET /v1/offers/{id}` | `offers:read` | One offer with case studies and signal rules |
| `POST /v1/offers`, `PATCH /v1/offers/{id}` | `offers:manage` | Create, edit |
| `POST /v1/offers/{id}:approve`, `:archive` | `offers:manage` | Approve also requires the owner role |
| `PUT /v1/offers/{id}/signal-rules` | `scoring:manage` | Replace an offer's signal rules |
| `GET /v1/case-studies` | `offers:read` | Agent principals see only buyer-visible case studies |

## MCP tools

| Tool | Does |
|---|---|
| `list_offers` | Input optional `practice`. Output shape fixed in `mcp/agent-tools.md`: `practices[]` with `practice_id`, `name`, `offers[]` (`offer_id`, `slug`, `name`, `promise`, `target_titles`, `industries`, `company_size`, `price_range`). Approved offers only. Lets an agent aim its research and set `offer_hint`. |

## Open questions

- Should offers be shared across tenants (Taazaa's catalogue offered to Tobi)? No: strictly per
  tenant (D20). A tenant can copy from a template library later.
