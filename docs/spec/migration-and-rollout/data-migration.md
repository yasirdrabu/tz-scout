# MIG-E1 Migrate v1 data

Release R1 · Decision D17 (migrate today's data)

## What exists

v1's Postgres (38 tables in `public`, about 2,119 rows on 2026-10-23): one real tenant (Taazaa) with
about 100 accounts, their contacts and signals, 29 handed off to Ash and Mike in handoff batches, the
seller roster, eight offers in four buckets (two still drafts), six case studies, AI runs, imports,
and seeded demo data for segments, message tests, leads and scorecard weeks. The "Northwind Sample
Co." company is seed data and is **not** migrated.

## What is not migrated (spec's call, D26)

Seeded demo data is not migrated anywhere, including `legacy_v1`: everything in the Northwind tenant,
and in the Taazaa tenant every segment, message test (v1 Batch, Statement, StatementResult), lead,
form submission, meeting and scorecard week that was created by `prisma/seed.ts` rather than by a
person or a live integration. The dry run lists these rows as "seed only, skipped" by matching them
against the seed script's fixed values; a person can force one in with `--include <legacy_table>:<id>`.
Rows a person created or edited after seeding (for example an edited segment override) count as real.

## Rows whose module ships after R1: the `legacy_v1` schema (spec's call, D26)

R1 builds only the R1 modules. Real v1 rows whose target table belongs to a later release are copied,
unchanged, into a read-only Postgres schema `legacy_v1` (same table and column names as v1, plus
`tenant_id`), and nothing reads them in R1. Each later release includes a story in the owning module
to import its rows from `legacy_v1` through its public interface, using `platform.legacy_id_map` for
ids, then mark them imported.

| Target (from the mapping below) | Ships in | Lives in R1 |
|---|---|---|
| `playbooks` call reviews, proposals, brief sections beyond the handoff package | R2 | `legacy_v1.CallReview`, `Proposal`, `AccountMatch` text fields |
| `offers.win_analysis` | R3 | `legacy_v1.WinAnalysis` |
| `analytics.week`, `diagnosis`, `fix`, `scorecard_target` | R3 | `legacy_v1.Week`, `WeekMetric`, `Diagnosis`, `Fix`, `Settings.scorecard` |
| `campaigns.*` (message tests, ad scenarios, meetings, touches, campaign settings) | R4 | `legacy_v1.Batch`, `Statement`, `StatementResult`, `FunnelScenario`, `Meeting`, `MeetingTouch` |
| `offers.segment` | R4 | `legacy_v1.Segment`, `SegmentFactor` |

The R1 run is everything else in the mapping. The "analytics rebuild" in MIG-E1-S3 runs when Analytics
ships in R3, not at R1 cutover.

## Command

`scout migrate-v1 --from "<v1 DATABASE_URL>" --tenant-slug taazaa [--dry-run] [--only <table>]`

- Reads v1 read only. Writes through each module's public interface (not raw SQL into other modules'
  schemas), so module rules and validation apply.
- **Idempotent:** every created record is recorded in `platform.legacy_id_map (legacy_table, legacy_id,
  new_type, new_id)`. A rerun updates records already migrated and creates only what's missing.
- **Quiet:** runs with event publishing suppressed for derived events (no 2,000 webhooks, no handoffs).
  It must never trigger a CRM push. At the end it queues one tenant rescore (and, from R3, one
  analytics rebuild).
- `--dry-run` prints what would be created per mapping, with counts, and writes nothing.
- Order: tenancy → offers → accounts → intake → scoring → routing → crm → playbooks → campaigns →
  analytics → ai → platform audit.

## Mapping

| v1 model | Goes to | How |
|---|---|---|
| Company | `tenancy.tenant` | Taazaa only; slug, name, currency kept |
| User, Membership | `tenancy.user`, `tenancy.membership` | Roles: OWNER → Owner, OPERATOR → Operator, SALES → Seller. `isAdmin` → platform admin. Zach also gets Leader. |
| Settings | split | `weights`, `maxActiveSegments` → offers settings; `buyers` match weights → scoring settings; `buyers.takeOverOwnership` → CRM setting; `testDefaults`, `funnelDefaults`, `sequence` → campaigns settings; `scorecard` → `analytics.scorecard_target`; `roundRobinIndex` dropped (assignment is by a person now) |
| IntegrationConnection | `integrations.connection` | Provider, mode and notes. **Credentials are not copied**; the new rotated keys are entered in the app (see release plan). v1 had no usage records, so no historic `integrations.usage.recorded` events or automatic cost lines are created; costs start at cutover. |
| AuditLog | `platform.audit_log` | Actor kind user; v1 action name kept in `legacy_action` |
| AiRun | `ai.run` | All fields; `mock` → model "rules" |
| Bucket | `offers.practice` | Four practices; keywords kept |
| Offering | `offers.offer` | All fields; `bucketId` → practice; status kept (drafts stay drafts); `signalRules` → scoring signal rules for that offer; `readiness` → offer readiness |
| CaseStudy, OfferingCaseStudy | `offers.case_study`, offer links | As is |
| Segment, SegmentFactor | `offers.segment`, factors | Overrides kept |
| WinAnalysis | `offers.win_analysis` | As is |
| Batch, Statement, StatementResult | `campaigns.message_test`, `statement`, `statement_result` | Batch renamed to message test |
| FunnelScenario | `campaigns.ad_scenario` | Rates kept as decimals |
| Account | `accounts.account` + facts + `intake` arrival | Firmographics (industry, employees, revenue, location, tech, keywords, growth, founded) become facts with source = v1 `source` (apollo, vibe, hubspot, manual) and `observed_at` = `enrichedAt`. One synthetic arrival per account from a "Migrated from v1" batch under the original source, payload = the v1 row as JSON, so every account has provenance. `excludedReason`/`excludedOverride` → account exclusion. `buckets` → `accounts.account.practice_ids` (each v1 bucket id mapped to its new practice id). `research` → research facts plus brief sections in Playbooks (labelled as imported research). |
| Account `importIds`, LeadImport | `intake.batch` (kind csv_import) + arrivals | One batch per v1 import with file name, mapping, stats and creator; one arrival per imported row (`rows` JSON), resolved to its account |
| Contact | `accounts.person` | Names, title, seniority, email with `emailStatus` as an email-quality fact, phones, LinkedIn; `isPrimary` → primary flag; buying role left "Unknown" for a person to set, except titles matching an offer's target titles → "Business owner" suggestion |
| Signal | `accounts.signal` | As is, with source and external id |
| AccountMatch | not copied as scores | Scores, tier and best offer are **recomputed** by the post-migration rescore. `whyNow`, `angle`, `opener`, `contactTitle`, `sequence`, `callPrep` → Playbooks brief and follow-up sequence for that account and offer, with `aiRunId` |
| Account `sellerId`, `status` | `routing` | Accounts with a seller → an accepted assignment to the seller's user (assigned by Zach, at `pushedAt` or `updatedAt`); status maps NEW → Unvetted, WORKING → Reviewed, others to the nearest default status, listed in the dry run |
| Account `hubspot*` fields | `crm.link`, `crm.handoff`, `crm.follow_through` | Company, owner, note (with `hubspotNoteHash` as fingerprint), task and sequence task links; a completed handoff per pushed account at `pushedAt`; `followUp` → follow-through baseline and latest |
| HandoffBatch | `crm.handoff_batch`, `crm.handoff_message` | Names and messages kept |
| Seller | `crm.owner` (roster) + `tenancy.membership.crm_owner_ids` | Every Seller row becomes a roster entry (`hubspotOwnerId`, name, email, active). For sellers on the team (`onTeam`), `hubspotOwnerId` is written to the matching membership's `crm_owner_ids` as `{ hubspot: "<id>" }`, matched by `userId` or email. Team sellers without a user (Ash, Mike, Andy) get a membership with role Seller and status invited, carrying their `crm_owner_ids`, so assignments and handoffs work before they first sign in. This replaces v1's Seller table. |
| ProspectSearch | `enrichment.saved_search` (plus one `scheduled_pull` source each in `intake.source`) | Apollo and Vibe pulls with filters and schedule (R1, D33, D34); they start paused until the provider's key is entered |
| CallReview, Proposal | `playbooks` (call reviews, proposals on the account) | As is, with `aiRunId` and CRM note links |
| FormSubmission + Lead | `intake.arrival` + `accounts.person` | Arrival status `resolved` (or `rejected` when no account can be found). Payload = `FormSubmission.payload` exactly; source = the tenant's default web form source (or "Outbound" for `source = outbound`). Resolved to `accountId` if set, else by domain. Lead status → review status: NEW, VALIDATING → Unvetted; REVIEW → Needs review; VALIDATED → Reviewed; NOT_QUALIFIED → Declined, reason "Not qualified (v1 checks)". Overrides → audit entries. |
| LeadCheck | arrival legacy notes | Kept as JSON on the arrival (`legacy_checks`) for history; not re-used by scoring |
| Meeting, MeetingTouch | `campaigns.meeting`, `campaigns.touch` | Linked to the lead's account and person |
| DealLink | `crm.deal` + `crm.link` | Stage, amount in cents, won flag → status |
| Week, WeekMetric, Diagnosis, Fix | `analytics.week`, `diagnosis`, `fix` | Counts and edits kept |

## Verification

The command ends with a report, and fails (non-zero exit) on any hard check:

| Check | Kind |
|---|---|
| Accounts in v1 (Taazaa) = accounts in Scout | hard |
| Contacts = people; signals = signals; offers, case studies, practices equal | hard |
| Every v1 account with `hubspotCompanyId` has a company link and a completed handoff (29 at last count) | hard |
| Every v1 handoff batch exists with the same accounts and messages | hard |
| Every v1 arrival source (form, import row, account) has an arrival with the original payload | hard |
| No CRM write happened during the migration (integration call log has zero writes) | hard |
| Tier distribution after rescore vs v1 tiers | report only; accounts that changed tier are listed for a person to look at |
| Rerun of the command creates zero new records | hard (run twice in CI against a v1 snapshot) |

## Stories

### MIG-E1-S1 Dry run
As Yasir, I want a dry run against a copy of v1, so that I see exactly what will move before anything
does.
- MIG-E1-S1-AC1 `--dry-run` prints counts per mapping row and the status mappings it will apply, and
  writes nothing.

### MIG-E1-S2 Migrate and verify
As Zach, I want every account, contact, signal and handoff in Scout as it was, so that the team loses
nothing.
- MIG-E1-S2-AC1 All hard checks pass.
- MIG-E1-S2-AC2 Running the command a second time creates nothing new and reports "No changes".

### MIG-E1-S3 Rescore and rebuild after migration
- MIG-E1-S3-AC1 After the R1 migration, a tenant rescore runs once and the report lists accounts whose
  tier changed. When Analytics ships (R3), its release runs one analytics rebuild for the tenant.

### MIG-E1-S4 Park later-release rows in `legacy_v1`
As Yasir, I want v1 rows for modules that don't exist yet kept safely, so that nothing real is lost
before those modules ship.
- MIG-E1-S4-AC1 Every real (non-seed) row in the tables listed under "Rows whose module ships after R1"
  exists in `legacy_v1` with its v1 values; the schema is read-only to the application role.
- MIG-E1-S4-AC2 The dry run lists seed-only rows as skipped, with counts per table.
- MIG-E1-S4-AC3 Each later release's import story (PLB R2, OFF and ANL R3, CMP and OFF segments R4)
  moves its rows out of `legacy_v1` through the module's public interface, records ids in
  `platform.legacy_id_map`, and a rerun creates nothing new.
