# Campaigns

Module code CMP · Schema `campaigns` · Release R4 (except CMP-E4, R1)

## Purpose

Paid and inbound marketing, carried from v1 Modules 3, 4 and 6, now as **one source among many**
(decision in README). It covers:

- **Message tests:** statements in the buyer's words, run as small ad sets, judged pass or fail.
- **Ad funnel model:** the eight-stage cost model from impressions to won, with scenarios.
- **Ad sources and spend:** each ad channel is a source; daily spend becomes cost lines.
- **Inbound forms:** website and CRM forms. **Form fills are arrivals.** They are taken in by Sources
  and intake like any other source; the v1 lead validation checks are now done by the shared steps
  (duplicate check, enrichment, scoring, review). Campaigns only adds which campaign and statement
  the form fill came from.
- **Booking and reminders:** booking link, confirmations, reminders, rebook sequence.

## Owns (data)

| Table | Key fields | Notes |
|---|---|---|
| `campaigns.message_test` | `id` (`mts_`), `tenant_id`, `segment_id`, `offer_id`, `name`, `status` (draft, approved, running, complete), `channel` (meta, linkedin), `budget_cents`, `duration_hours`, `target_ctr` (decimal), `target_cpc_cents`, `min_impressions`, `launched_at`, `ends_at`, `completed_at` | Was "Batch" in v1; renamed so it isn't confused with intake batches. |
| `campaigns.statement` | `id` (`stm_`), `message_test_id`, `segment_id`, `text`, `kind` (problem, outcome), `decision` (pending, keep, drop, rewrite, retest), `in_library`, `rewrite_of_id`, `external_ad_set_id` | |
| `campaigns.statement_result` | `statement_id`, `impressions`, `clicks`, `spend_cents`, `fetched_at` | |
| `campaigns.ad_scenario` | `id` (`scn_`), `tenant_id`, `offer_id`, `name`, `inputs` (rates as decimals, money in cents), `created_by` | Ad funnel scenarios |
| `campaigns.ad_spend_day` | `tenant_id`, `channel`, `date`, `campaign_external_id`, `message_test_id`, `spend_cents`, `impressions`, `clicks` | Daily pull from ad channels |
| `campaigns.meeting` | `id` (`mtg_`), `tenant_id`, `account_id`, `person_id`, `type` (discovery, sales), `status` (booked, held, no_show, rebooked, cancelled), `scheduled_at`, `booked_at`, `held_at`, `case_study_id`, `rebook_of_id`, `external_meeting_id` | |
| `campaigns.touch` | `id` (`tch_`), `tenant_id`, `meeting_id`, `person_id`, `kind` (booking_link, confirmation, reminder_24h, reminder_1h, pre_call_note, rebook_1, rebook_2, rebook_3), `channel` (email, sms), `due_at`, `sent_at`, `status` (scheduled, sent, skipped, failed), `subject`, `body` | |

## Depends on

- **Offers and practices** (sync): segments, offers, case studies.
- **AI tasks** (sync): statements, rewrites.
- **Integrations** (sync): Meta, LinkedIn, Google Ads, booking, messaging clients.
- **Accounts** (sync): person contact details and consent for reminders.

## Epics

| Epic | File | Release |
|---|---|---|
| CMP-E1 Message tests | [message-tests.md](message-tests.md) | R4 |
| CMP-E2 Ad funnel model | [ad-funnel-model.md](ad-funnel-model.md) | R4 |
| CMP-E3 Ad sources and spend | [ad-sources-and-spend.md](ad-sources-and-spend.md) | R4 |
| CMP-E4 Inbound forms as arrivals | [inbound-forms.md](inbound-forms.md) | R1 (v1 path alias), R2 (per-form endpoint, owned by SRC-E6) |
| CMP-E5 Booking and reminders | [booking-and-reminders.md](booking-and-reminders.md) | R4 |

## Events published

All internal (not public webhook types).

| Event | Data |
|---|---|
| `campaigns.test.launched` / `.completed` | `messageTestId`, `segmentId`, `offerId`, `channel` |
| `campaigns.statement.decided` | `statementId`, `decision`, `verdict` (pass, fail, not_enough_data) |
| `campaigns.ad_spend.recorded` | `channel`, `date`, `amountCents`, `currency`, `sourceId`, `messageTestId` (nullable), `adSpendDayId` |
| `campaigns.meeting.booked` / `.held` / `.no_show` / `.cancelled` | `meetingId`, `accountId`, `personId`, `type`, `scheduledAt` |

## Events consumed

| Event | Does |
|---|---|
| `crm.deal.changed` (won) | Send offline conversions to ad channels for accounts whose first source is an ad source |
| `routing.assignment.accepted` | Start the booking sequence when the tenant turns on "Send booking link on assignment" for inbound form accounts |
| `accounts.account.merged` | Repoint meetings |

## API endpoints

| Method and path | Scope | Does |
|---|---|---|
| `GET /api/v1/message-tests`, `GET /api/v1/message-tests/{id}` | `campaigns:read` | Tests with statements and verdicts |
| `GET /api/v1/statements/library?segment_id=` | `campaigns:read` | Winning statements |
| `GET /api/v1/meetings?account_id=` | `accounts:read` | Meetings for an account |
| `POST /api/v1/inbound/booking/{connectionId}` | booking provider signature | Booking provider events (follows the inbound webhook pattern in public-api/index.md) |

Form fills come in through Sources and intake's `POST /api/v1/inbound/forms/{sourceId}` (SRC-E6); this
module owns no form endpoint.

## MCP tools

None in this version.

## Open questions

- Which ad channel goes live first after R4: Meta (v1 plan) or LinkedIn (closer to B2B buyers)?
