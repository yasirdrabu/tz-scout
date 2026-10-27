# Taazaa Scout R1a Accounts and Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every account Scout learns about enters through one intake path (one arrival, a batch, or a CSV, Excel or Markdown file), is de-duplicated, and lands as an account with people, facts, signals, practices and its sources recorded, ready for scoring in R1b.

**Architecture:** Three new modules on the R0 platform: Offers and practices (`offers` schema), Accounts (`accounts` schema) and Sources and intake (`intake` schema). Intake stores each arrival exactly as received, then a `jobs.intake.resolve` job runs the resolve pipeline, which calls Accounts' public interface (`findMatches`, `upsertFromArrival`). Accounts calls Offers only to resolve practice hints. `/v1` routes sit above all three and are the only entry points: there are no screens in this plan.

**Tech Stack:** As R0 (Node 22+, TypeScript strict, Next.js 15 route handlers, Drizzle, Postgres 17, NATS JetStream, Zod 4, Vitest). New dependencies: `tldts` (registrable domain from the bundled public suffix list), `exceljs` (streaming `.xlsx` reader), `i18n-iso-countries` (country names and alpha-3 codes to alpha-2; call `registerLocale(en)`).

**Spec:** `docs/spec/accounts/` (ACC-E1, E3 facts only, E4, E5, E7, E8), `docs/spec/sources-and-intake/` (SRC-E1 registry and caps, E2, E3, E4, E5 basic), `docs/spec/offers-and-practices/` (OFF-E1, E2 manual offers, E3), `docs/spec/public-api/` (API-E1 idempotency, pagination and errors; API-E2 arrivals and batches), `docs/spec/tenancy-and-access/roles-and-data-scopes.md` (TEN-E3-S1-AC2, TEN-E3-S3-AC1), `docs/spec/architecture/*`, `docs/spec/migration-and-rollout/release-plan.md` (R1). v1 reference code is at commit `c3c2124` (`git show c3c2124:<path>`); v1's test fixtures are inline in its test files.

## Scope

In: the three modules, their events and jobs, every service behind a `/v1` endpoint (agent endpoints from the spec, plus people-only endpoints the front end will call), tenant defaults, seed data, and the data-limit filter with the TEN-E3-S1-AC2 suite deferred from R0.

Out, by owner plan:
- **R1b:** scoring, signal rules (OFF-E4), review statuses and their validation, `source_feedback` (SRC-E1-S4), counts by stage (SRC-E2-S3-AC1 stage part), primary re-pick on best-offer change (ACC-E1-S3-AC3), "New from <source>" on assigned accounts (SRC-E3-S4-AC1), practice suggested from best offer (OFF-E1-S2-AC2).
- **R1c:** CRM, HubSpot qualified leads (SRC-E6), `crm_status` consumers (ACC-E7-S1-AC2), a registered `MergeGuard`, the cross-module merge test (ACC-E5-S1-AC4).
- **R1d:** MCP tools, Apollo and Vibe pulls, INT usage caps (`checkCap`), per-minute rate limits (API-E1-S4), OpenAPI (API-E4), v1 data migration, throughput at 500 arrivals a minute on the VM (SRC-E3-S1-AC2).
- **R2:** conflicts (ACC-E3-S3, S4), custom fields (ACC-E6), committee gaps in `add_person` responses, warm-intro confirmation and rules screen. **R3:** trust scores and the trust re-pick (SRC-E1-S3, ACC-E3-S2-AC2).
- **Front end:** the user provides every screen. ACs that are only about a screen (for example SRC-E1-S1-AC3, SRC-E2-S4-AC1, ACC-E4-S2) are met here by the endpoint the screen will call.

## Design

The modules are bounded contexts. Each keeps its own schema, its own published language (`contracts/`: events, DTO types, ports) and a facade (`index.ts`) that is the only thing other modules import.

| Aggregate | Owner | Invariants it guards | Consistency boundary |
|---|---|---|---|
| Account (account, people, roles, facts, signals, aliases, summary row) | Accounts | One active account per domain per tenant; one active person per email per account; a signal is stored once (three dedup keys); current values are a projection of facts; exclusion is re-evaluated whenever its inputs change | An account-level advisory lock taken by Accounts itself on every write path |
| Arrival | Intake | Payload immutable (database trigger); status moves only from `received` to `resolving` to `resolved` or `rejected`; each pipeline step is recorded and idempotent | The resolve lock (domain, else name and country, else shell email) |
| Batch | Intake | Counts equal the sum of its items; completed exactly once, when no item is received, resolving or waiting | Row lock on the batch while counters update |
| Source | Intake | Agent has a person parent; scheduled pull has a vendor parent; one person source per user; paused or archived sources store nothing | Single-row writes |
| Offer, Practice | Offers | `draft → approved → archived`; approval requirements; a buyer-definition edit returns an approved offer to draft; a practice with approved offers can't be archived | Single-row writes |

Layers inside a module:
- `domain/`: pure rules and value logic (normalising, matching, picking, approval checks). No database, no network. Unit tested.
- `services/`: application services. Each is a small transaction script that loads rows with Drizzle, calls domain rules, writes rows and publishes events through the outbox in `ctx.tx`. Shared steps are their own services (facts, people, signals, exclusion, summary), never copied.
- `db/`: Drizzle tables and migrations for this schema only.
- `contracts/`: events, jobs, DTO types and ports other modules implement or call.

SOLID in practice here:
- **Single responsibility:** `upsertFromArrival` only orchestrates; facts, people, signals, exclusion and summary each have one service.
- **Open for extension:** import layouts are a list of `{ detect, toArrivals }` strategies; a new layout is a new file in the list.
- **Small interfaces:** ports have one or two methods (`SourceInfoProvider`, `SourceValidator`, `MergeGuard`, `SourceAccessProvider`).
- **Dependency inversion:** lower modules define ports and higher modules implement them. One composition root, `src/entry/compose.ts`, registers the implementations for the worker and the web app.

There is no repository layer over Drizzle. Services query their own module's tables directly; the domain stays pure, so a repository layer would add indirection without a second implementation to justify it.

## Rulings (decisions this plan makes where the spec leaves a gap)

1. **Daily arrival cap counted inside intake** (INT-E4 `checkCap` is R1d). The count is per closest source: the key's source for API calls; for file imports, the person source. A per-source advisory lock around count-and-insert makes the cap exact. **File imports by a person are not capped**: the 10,000-row file limit bounds them, and a person importing a list chose to. Cost if wrong: one condition.
2. **Trust is 0.60 for every source until R3.** `getTrust` already applies the effective-trust formula (0.4 person, 0.3 agent, 0.3 vendor, re-weighted over the levels present), so callers don't change later.
3. **`initialReviewStatusKey` is not validated** against Review's list until R1b. Defaults by kind as in SRC-E1.
4. **Files are stored in Postgres** (`intake.file_blob`, `bytea`, keyed by `storage_key`), so nightly backups cover them.
5. **Name similarity is computed in TypeScript** (pg_trgm's algorithm) over candidates pre-filtered in SQL by the same normalised state or city. No Postgres extension.
6. **`ModuleContext` gains `access`.** Every principal path (`v1Route`, `tenantAction`) must set it, and a test checks each one. Only worker and scheduler contexts leave it unset, and unset means "system, whole tenant".
7. **Batch items that fail validation are stored and rejected `invalid`** (D13). Only an invalid batch envelope (missing `name`, 0 or more than 1,000 items, over 10 MB) is a `400` with nothing stored.
8. **The 30-day waiting expiry is a per-tenant schedule** (`intake.waiting.expire`, daily 04:00 UTC), created by intake's `tenancy.tenant.created` consumer and by seed.
9. **API-key `PATCH` on accounts and people goes through intake** as an inline targeted arrival carrying `facts`, so provenance, caps and trust apply (D3, D23). A person's `PATCH` calls `editAccount` / `editPerson` and pins (ACC index).
10. **Idempotency keys are scoped per principal**, as the spec says: platform migration 0008 adds `principal_id` to `idempotency_key`'s primary key.
11. **Unconfirmed warm-intro points round down** (5 becomes 2).
12. **`arrival_normalise` is narrower than the AI catalog row**: input `{ industry?, relationship? }`, output `{ industryKey, relationshipKey }`. `csv_column_mapping` takes 5 sample rows (SRC-E4) and returns a `reason` per column (catalog). Task 21 updates `ai-tasks/task-catalog.md` to match.

## Global Constraints

- Everything in R0's Global Constraints still holds. That includes RLS with the `tenant_isolation` policy, imports only through `index.ts` or `contracts/*`, prefixed ULIDs, `<schema>.<entity>.<verb>` events, problem+json errors, snake_case JSON and no em dashes in copy.
- **Every table in `offers`, `accounts` and `intake` has `tenant_id text not null` and forced RLS**, including child and join tables the spec lists without it (`account_alias`, `person_role`, `person_alias`, `account_summary`, `offer_case_study`, `batch_file`, `file_blob`, `warm_intro`).
- New id prefixes in `src/platform/ids.ts`: `src_`, `arr_`, `bat_`, `imp_`, `map_`, `wi_`, `blob_` (intake); `acc_`, `per_`, `fct_`, `sig_` (accounts); `prc_`, `off_`, `cs_` (offers).
- Each new schema needs: `bootstrap.sql` (create, usage, grants, default privileges); `MODULE_ORDER` (`platform, tenancy, integrations, ai, offers, accounts, intake`) and the order asserted in `tests/integration/platform/migrate.test.ts`; `drizzle/<schema>.config.ts` (copy `drizzle/ai.config.ts`); a `COPY` line for its migrations in `infra/docker/Dockerfile`; the RLS catalog test's schema list; and `src/entry/registry.ts`.
- Money in integer cents; rates and trust as decimals; scores integers 0 to 100.
- Arrival payloads never change after insert. A `before update` trigger on `intake.arrival` raises if `payload` or `payload_hash` changes.
- Limits:
  - Arrivals: 256 KB payload; at most 25 people, 50 signals and 200 facts.
  - Batches: 1 to 1,000 items, 10 MB; files up to 25 MB each, 10 per batch.
  - Imports: files up to 20 MB and 10,000 rows.
  - Request bodies: 5 MB, except batches.
  - Pagination: `limit` 1 to 200, default 50.
- Default daily arrival cap: 500 per source, settable from 0 to 10,000. Every source starts at trust 0.60.
- Warm-intro relationship default points: `customer_referral` 15, `partner_referral` 10, `board_or_investor` 12, `employee_network` 8, `event_meeting` 5, `other` 3. Points clamp to 0 to 20; unconfirmed intros count half, rounded down; the highest of several intros counts.
- `Idempotency-Key`: up to 255 characters, kept 24 hours, per principal. The same key with the same body returns the stored status and body with `Idempotent-Replayed: true`. A different body returns `409` `idempotency-mismatch`.
- Lock order, outermost first: per-source cap lock, then resolve lock, then account lock. When a merge locks two accounts, it takes the lower id first.
- AI tasks used in the pipeline always have a `rules` fallback, and their calls happen before any lock is taken. A missing Claude key never fails an arrival or an import.

## Review Focus

1. **Concurrent arrivals for the same company.** This covers two batches with the same domain, two file rows with the same name and no domain, an alias-domain arrival racing a primary-domain arrival, and an inline `add_person` racing a resolve job. Expected: one account and no duplicate people. Tests in Tasks 6 and 14.
2. **A messy CSV:** UTF-8 BOM, semicolon delimiter, quoted cells with line breaks, blank rows, duplicate headers and trailing empty columns. Expected: correct rows; duplicate headers become `Email` and `Email (2)`; blank rows skipped. Test in Task 16.
3. **Odd website values:**

   | Input | Expected |
   |---|---|
   | `HTTP://WWW.Example.CO.UK/about?x=1` | `example.co.uk` |
   | `example.com.` | `example.com` |
   | `example.com:8080` | `example.com` |
   | `mailto:a@b.com` | `null` |
   | `192.168.0.1` | `null` |
   | `not a url` | `null` |
   | `gmail.com` | `null` |

   Test in Task 11.
4. **The cap at the tenant's midnight across the 1 November 2026 change from daylight to standard time** in `America/New_York`. Expected: the count resets at local midnight and `Retry-After` points there. Tests in Tasks 11 (day maths) and 12 (cap).
5. **A batch of mixed valid and invalid items, including two items sharing an `external_ref`.** Expected: `202` with one `arr_` id per item in order. Invalid items are `rejected` / `invalid` with their paths in `detail`, and the second shared ref is `duplicate_in_batch`. The rest resolve and the batch completes. Tests in Tasks 12 (submission) and 14 (completion).

---

## File Structure

```
src/platform/access.ts                    DataLimit type and Access (tenancy re-exports DataLimit)
src/platform/idempotency.ts               Idempotency-Key claim, replay and store
src/entry/compose.ts                      Registers port implementations (worker and web)
src/modules/offers/
  index.ts contracts/events.ts db/schema.ts db/migrations/ domain/approval.ts
  services/practices.ts services/offers.ts services/case-studies.ts defaults.ts
src/modules/accounts/
  index.ts contracts/{events,types,ports}.ts db/schema.ts db/migrations/
  domain/{names,seniority,primary,current-value,signals,exclusions,similarity,fact-keys}.ts
  services/{lock,facts,people,signals,exclusion,summary,practices,upsert,match,read,edit,merge,visibility,search,settings}.ts
  jobs.ts consumers.ts defaults.ts
src/modules/intake/
  index.ts contracts/{arrival,events,jobs}.ts db/schema.ts db/migrations/
  domain/{normalise,free-email,industry,warm-intro,day}.ts
  services/{sources,caps,submit,resolve,waiting,status,visibility,warm-intros,files,imports,mappings}.ts
  import/parse.ts import/layouts/{index,research,vibe}.ts import/synonyms.ts import/rows-to-arrivals.ts
  tasks/{arrival-normalise,csv-column-mapping}.ts
  jobs.ts consumers.ts defaults.ts
src/app/v1/                               route handlers (Tasks 3, 19, 20, 21)
tests/integration/helpers/run-outbox.ts   runs pending outbox jobs and events through registered handlers
tests/unit/{offers,accounts,intake}/   tests/integration/{offers,accounts,intake,v1}/
tests/fixtures/imports/                   fixture files created in Tasks 16 and 22 (v1 fixtures are inline)
```

Each module's folder name matches its schema name (`offers`, `accounts`, `intake`), so `migrationsFolder` needs no special case.

---

### Task 1: Platform: access, idempotency, response statuses, errors and the outbox test helper

**Files:**
- Create: `src/platform/access.ts`, `src/platform/idempotency.ts`, `src/platform/db/migrations/0008_idempotency_principal.sql` (+ snapshot), `src/app/v1/_lib/pagination.ts`, `tests/integration/helpers/run-outbox.ts`
- Modify: `src/platform/context.ts`, `src/platform/errors.ts`, `src/platform/db/schema.ts`, `src/modules/tenancy/domain/data-limit.ts` and `contracts/members.ts` (import `DataLimit` from platform, keep re-exports), `src/app/v1/_lib/v1-route.ts`, `src/server/page-context.ts`
- Test: `tests/unit/platform/pagination.test.ts`, `tests/unit/platform/errors.test.ts`, `tests/integration/v1/idempotency.test.ts`, `tests/integration/v1/route-access.test.ts`

**Interfaces:**
- `type Access = { userId?: string; sourceId?: string; childSourceIds?: string[]; dataLimit: DataLimit }`; `ModuleContext.access?: Access`.
- `ScoutError` gains `headers?: Record<string, string>` and `extensions?: Record<string, unknown>`. `toProblem` merges `extensions` into the body, and `problem()` in `v1Route` sets the headers. Every problem body includes `correlation_id` (API-E1-S1-AC2).
- Handlers may return `{ status: number; body: object; headers?: Record<string, string> }`. Helpers: `accepted(body)` gives 202, `created(body)` gives 201.
- `v1Route(opts: { permission?: Permission; idempotent?: boolean; peopleOnly?: boolean }, handler)`:
  - `peopleOnly` refuses non-user principals with 403 and the copy the route passes, default `Only a person can do this.`
  - With `idempotent` on a `POST`, the route claims `(tenant_id, principal_id, key)` inside the handler's transaction. The claim inserts placeholder values (`request_hash` set, `response_status` 0, `response_body` `{}`) with `on conflict do update … where created_at < now() - interval '24 hours'`, so an expired row is taken over and a live one is left alone. A concurrent second request waits on the row, then replays it. The stored hash is the sha256 of the JSON body; for multipart it's the sha256 of the uploaded file's sha256 plus the sorted form fields. The final status and body are stored.
  - `v1Route` always sets `ctx.access` from the principal: `userId`, `sourceId`, `dataLimit`. From Task 12 on, it also fills `childSourceIds` through the accounts `SourceAccessProvider` port, and for a signed-in person (cookie session) sets `sourceId` to `personSourceFor(userId)`.
  - `v1Route` also takes `platformAdminOnly?: boolean`, which refuses anyone without `principal.platformAdmin` (`can()` alone passes platform admins on every permission, so it can't express this).
  - `tenantAction` in `page-context.ts` sets `access` the same way.
- Pagination: `encodeCursor`, `decodeCursor` (a bad cursor is a 400 `validation` with path `cursor`), `pageLimit(url)` (`Limit must be between 1 and 200.`) and `page(rows, limit, cursorOf)`.
- `runOutbox(tenantId, opts?: { until?: () => Promise<boolean>; maxRounds?: number })` reads unsent outbox rows for the tenant in `seq` order. It runs every matching job handler and consumer from `src/entry/worker.ts` through the same `processed_event` guard the worker uses, marks the rows sent, and repeats until none are left. Tests use it instead of NATS.

- [ ] **Step 1: Write failing tests.**
  - Unit:
    - `pageLimit`: 50 by default, 200 for `?limit=200`, 400 for `0` and `999`.
    - `page`: with 51 rows and a limit of 50, the cursor decodes to the 50th row's values.
    - `toProblem`: puts `extensions.resets_at` into the body.
  - Integration:
    - Two concurrent POSTs with the same key and body create one outbox row; one response has `Idempotent-Replayed: true`, and both have the same status (202) and body.
    - Same key with a different body: 409 `idempotency-mismatch`.
    - The same key from two different keys in the same tenant: both succeed.
    - A route returning `accepted(...)` answers 202.
    - Every `v1Route` handler and `tenantAction` receives `ctx.access` with the principal's `dataLimit`.
    - A `peopleOnly` route called with an API key gets 403.
- [ ] **Step 2:** Run `npm run test:unit -- platform` and `npm run test:int -- v1/idempotency v1/route-access`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(platform): access in context, per-principal idempotency, response statuses and outbox test runner`.

### Task 2: Offers module: practices, offers and case studies

**Files:**
- Create: `src/modules/offers/{index.ts,contracts/events.ts,db/schema.ts,db/migrations/*,domain/approval.ts,services/practices.ts,services/offers.ts,services/case-studies.ts}`, `drizzle/offers.config.ts`
- Modify: `bootstrap.sql`, `migrate.ts`, `migrate.test.ts`, `Dockerfile`, `registry.ts`, RLS catalog test (and extend it per Global Constraints: every table in the listed schemas must have `tenant_id` and forced RLS, except `__migrations` and the platform-wide allowlist)
- Test: `tests/unit/offers/approval.test.ts`, `tests/integration/offers/{practices,offers,case-studies}.test.ts`

**Interfaces:**
- Tables: `practice`, `offer`, `case_study` and `offer_case_study`, with the fields from `offers-and-practices/index.md`.
  - Skip signal rules, readiness, segments and won deals.
  - Add a `sort` integer to `practice`, used as a tie-break.
  - `slug` is unique per tenant on `practice` and on `offer`.
- Events: `offers.offer.approved`, `offers.offer.changed` (`affectsMatching`), `offers.offer.archived`, `offers.practice.changed`, with data as in the OFF index.
- Domain:
  - `approvalProblems(offer): string[]`. The copy lines: `Add a promise before approving.`, `Add at least one target title or buying role before approving.`, `Add industries or a company size range before approving.`, `Add a typical deal size before approving.`, `Add the sales cycle in days before approving.`
  - `affectsMatching(patch, before): boolean`
  - `BUYER_DEFINITION_FIELDS` (`industries`, `companySizeMin`, `companySizeMax`, `revenueMinCents`, `revenueMaxCents`, `regions`, `targetTitles`, `targetBuyingRoles`, `excludedDomains`, `excludedCategories`)
  - `BUYER_DEFINITION_WARNING = 'This sends the offer back to draft until an owner approves it.'` (OFF-E2-S2-AC3; returned by `updateOffer` when it applies)
- Services:
  - Practices: `createPractice`, `updatePractice`, `archivePractice` (blocked with `Move or archive these offers first: <names>.`), `listPractices`.
  - `resolvePractice(ctx, hint)` matches in this order: id, slug, name (case-insensitive), then a keyword contained in the hint. A tie goes to the longest keyword, then `sort`. Archived practices never match.
  - Offers: `createOffer` (needs `name`, `practiceId` and `promise`), `updateOffer` (returns `{ offer, warning? }`), `approveOffer`, `archiveOffer`, `getOffer`, `listOffers`.
  - Case studies: `createCaseStudy` (`public` defaults to false), `updateCaseStudy`, `archiveCaseStudy`, `linkCaseStudy`, `unlinkCaseStudy`, `listCaseStudies`.
  - `matchCaseStudies(ctx, offerId, industry, limit, { buyerVisibleOnly? })` leaves out archived case studies.
  - The owner check uses a new tenancy function, `memberRole(ctx, userId): Promise<Role | null>` (add it to `src/modules/tenancy/services/members.ts` and `index.ts` in this task; R0's `memberAccess` is keyed by membership and has no role). API keys can't approve: `Only an owner can approve an offer.`

- [ ] **Step 1: Write failing tests.**
  - Unit: each line of `approvalProblems` copy; `affectsMatching` is true for `industries` and false for `promise`.
  - Integration:
    - OFF-E1-S1-AC1: a duplicate slug throws `That short name is taken.`
    - OFF-E1-S1-AC2: archiving a practice that has an approved offer is blocked, and the copy names the offer.
    - OFF-E1-S2-AC1: `prc_…`, `ai-operating-platforms`, `AI Operating Platforms` and `Yasir AI Operating Platform agent` all give the same id. `null` and `unknown` give null. A hint matching two practices gives the one with the longer keyword.
    - OFF-E2-S1-AC1, AC2 (through the service), AC3.
    - OFF-E2-S2-AC1: a leader gets the owner copy. AC2. AC3: an approved offer edited on `industries` returns the warning and is draft again.
    - OFF-E3-S1-AC1 (`public` defaults false), AC2, AC3.
    - OFF-E3-S2-AC1: the logistics case study comes first, then the most recent; an archived one is left out.
    - RLS isolation between tenants. The extended catalog test passes.
- [ ] **Step 2:** Run `npm run test:unit -- offers` and `npm run test:int -- offers platform/rls`. Expected: FAIL.
- [ ] **Step 3:** Implement, and generate the migration with `npx drizzle-kit generate --config drizzle/offers.config.ts`. Add the RLS policy by hand, as in R0.
- [ ] **Step 4:** Run the tests and `npm run test:int -- platform/migrate`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(offers): practices, offers and case studies`.

### Task 3: Offers on /v1 and Taazaa's catalogue

**Files:**
- Create:
  - `src/modules/offers/defaults.ts`
  - Routes under `src/app/v1/`: `practices/route.ts`, `practices/[id]/route.ts`, `offers/route.ts`, `offers/[id]/route.ts`, `offers/[id]/case-studies/route.ts`, `case-studies/route.ts`, `case-studies/[id]/route.ts`
- Modify: `src/entry/seed.ts`
- Test: `tests/integration/v1/offers.test.ts`, `tests/integration/offers/seed.test.ts`

**Interfaces:**
- Defaults:
  - `TAAZAA_PRACTICES`: the four practices from `c3c2124:src/lib/buckets.ts` `DEFAULT_BUCKETS`.
  - `TAAZAA_OFFERS`: every offer in `c3c2124:prisma/seed.ts` with the same values, filed under its bucket's practice, plus `DRAFT_OFFERS` from `buckets.ts`. Status is `approved` where v1 says `APPROVED`.
  - `TAAZAA_CASE_STUDIES`: the case studies named in that seed's `cases` lists, linked the same way.
  - `seedOffers(ctx)` upserts by slug.
- Routes (paths after `/v1`; `[id]` segments carry `off_…:approve`, split on `:`):

  | Method and path | Permission | Notes |
  |---|---|---|
  | `GET /practices` | `offers:read` | |
  | `POST /practices`, `PATCH /practices/{id}`, `POST /practices/{id}:archive` | `offers:manage` | |
  | `GET /offers?practice_id&status` | `offers:read` | Approved only, unless the principal has `offers:manage` |
  | `GET /offers/{id}` | `offers:read` | |
  | `POST /offers`, `PATCH /offers/{id}` | `offers:manage` | Returns `warning` when it applies |
  | `POST /offers/{id}:approve`, `POST /offers/{id}:archive` | `offers:manage` | |
  | `PUT /offers/{id}/case-studies` | `offers:manage` | Replaces the linked ids |
  | `GET /case-studies` | `offers:read` | Agents get public ones only |
  | `POST /case-studies`, `PATCH /case-studies/{id}`, `POST /case-studies/{id}:archive` | `offers:manage` | |

- [ ] **Step 1: Write failing tests.**
  - A read-only key gets only approved offers, in snake_case.
  - Approving with an API key returns 403 with the owner copy.
  - An agent's `GET /v1/case-studies` leaves out non-public case studies.
  - `PATCH` on an approved offer's `industries` returns `warning`.
  - Seed (integration): running it twice leaves 4 practices and the same offer count, with `Modernization Blueprint` approved under `ai-operating-platforms`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run test:int -- v1/offers offers/seed`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(offers): /v1 offers, practices and case studies, Taazaa catalogue seed`.

### Task 4: Accounts schema, contracts and tenant defaults

**Files:**
- Create: `src/modules/accounts/{index.ts,contracts/events.ts,contracts/types.ts,contracts/ports.ts,db/schema.ts,db/migrations/*,defaults.ts,consumers.ts}`, `drizzle/accounts.config.ts`, `src/entry/compose.ts`
- Modify: `bootstrap.sql`, `migrate.ts`, `migrate.test.ts`, `Dockerfile`, `registry.ts` (imports `compose.ts`), `src/app/v1/_lib/v1-route.ts` and `src/server/page-context.ts` (import `compose.ts`), `src/entry/worker.ts`, RLS catalog test
- Test: `tests/integration/accounts/defaults.test.ts`, `tests/integration/v1/compose.test.ts`

**Interfaces:**
- Tables: `account`, `account_alias`, `person`, `person_role`, `person_alias`, `fact`, `signal`, `buying_role`, `exclusion_rule`, `account_summary` (ACC index, each with `tenant_id`), plus:
  - `exclusion_list` (`tenant_id`, `kind`, `value`). `kind` is `vendor_keyword`, `parent_domain`, `parent_name` or `do_not_contact_domain`.
  - Extra `account` columns: `industry_key`, projected from an `industry_key` fact; `match_name`, from `matchName(name)`; `hq_state_key`, a normalised region code.
- Indexes:
  - Partial unique `account (tenant_id, domain)` for active rows with a domain.
  - Partial unique `person (tenant_id, account_id, lower(email))` for active rows with an email.
  - `account (tenant_id, match_name, hq_country)`.
  - `account_alias (tenant_id, kind, lower(value))`.
  - GIN on `account_summary.source_ids` and `practice_ids`.
  - `account_summary (tenant_id, priority desc nulls last, created_at)`.
- Skip `conflict` and `custom_field` (R2).
- Events: the ACC index list without the two conflict events.
- `contracts/types.ts`:
  - `AccountView`, `PersonView`, `SignalView`, `FactView`.
  - `SourceChain = { personSourceId?: string; agentSourceId?: string; vendorSourceId?: string }`.
  - `ArrivalForAccounts`: normalised account fields, people, signals (with `occurredAt` optional only for `research`), a facts list, research, `practiceHint`, `soleProprietor`, `arrivalId`, `receivedAt`, `sourceChain`, `externalIds`.
  - `isKnownFactKey(key)` and `FACT_KEYS`.
- `contracts/ports.ts`:
  - `SourceInfoProvider` (`getTrust`, `sourcesForAccount`). Default: 0.60 for every source, and no sources.
  - `MergeGuard`. Default: allow.
  - `SourceAccessProvider { childSources(ctx, sourceIds): Promise<string[]>; personSourceFor(ctx, userId): Promise<string | undefined> }`. Defined here, not in intake, so Accounts never imports intake (D29). Intake implements it in Task 12; `v1Route`, `tenantAction` and accounts visibility use it. Default: no children, and `personSourceFor` returns undefined.
  - Each port has its `register*` and getter.
- `src/entry/compose.ts` registers every port implementation that exists. In this task that's none yet; Task 12 adds intake's. It's imported by `registry.ts`, which every background role loads, and by `v1-route.ts` and `page-context.ts`.
- Consumer `accounts.tenant_defaults` on `tenancy.tenant.created` adds:
  - The 8 default buying roles: `business_owner`, `commercial_buyer`, `technical_buyer`, `influencer`, `champion`, `procurement`, `blocker` and `user`, with labels from `accounts/buying-committee.md`.
  - The 5 exclusion rules, all enabled.
  - The v1 vendor phrases (`VENDOR_TEXT` in `c3c2124:src/integrations/prospects/vibe.ts`) as `vendor_keyword` rows.
  - `seedAccountDefaults(ctx)` does the same thing for seed.

- [ ] **Step 1: Write failing tests.**
  - The consumer, run through `runOutbox`, gives 8 buying roles and 5 rules. Running it again changes nothing.
  - RLS isolation between tenants.
  - With no provider registered, `getTrust` returns 0.6.
  - A `/v1` test route sees the same registered port instance as the worker registry. Register a stub in `compose` and assert it's used.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, including `platform/rls` and `platform/migrate`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): schema, contracts, ports and tenant defaults`.

### Task 5: Accounts domain rules (pure)

**Files:**
- Create: `src/modules/accounts/domain/{names,seniority,primary,current-value,signals,exclusions,similarity,fact-keys}.ts`
- Test: `tests/unit/accounts/*.test.ts`

**Interfaces:**
- Names:
  - `splitName(full)` returns `{ firstName, lastName | null }`.
  - `matchName(name)`: lowercases, turns punctuation (including hyphens) into spaces, collapses spaces, and drops trailing legal suffixes (`inc`, `llc`, `ltd`, `corp`, `co`, `gmbh`).
- `seniorityFromTitle(title)` returns one of `'owner' | 'founder' | 'chief' | 'president' | 'vp' | 'head' | 'director' | 'manager' | 'other'`. `SENIORITY_RANK` orders them in that list's order, with owner highest. The v1 rule in `c3c2124:src/integrations/prospects/vibeExport.ts` `seniority` returns numbers and has no owner, founder or manager. The new categories add those, and v1's ordering cases still hold.
- `pickPrimary(people, targetTitles)` returns an id or null. A pinned person wins. Otherwise a target-title match wins, then seniority rank, then a verified email.
- `pickCurrent(facts, trust)` returns `{ currentId, supersededIds }`. List keys (`technologies`, `keywords`) take the union; free-text keys take the newest.
- Signals:
  - `SIGNAL_TYPES`: the nine types, with labels, kinds and explainers from `c3c2124:src/lib/matching.ts` `SIGNAL_EXPLAINER`.
  - `kindFor(type)`.
  - `fineTypeFromTitle(kind, title)`: only returns a type whose kind is `kind`.
  - `signalDedupKeys(s)`.
- Exclusions:
  - `evaluateExclusions(input, rules, lists)`. The input is `{ industryKey, description, keywords, name, parentDomain, parentName, domain, crmStatus }`. The first enabled rule matches, in ACC-E7 order:
    - `software_vendor`: `industryKey === 'software'`, or a `vendor_keyword` phrase appears in the description or keywords.
    - `unit_of_parent`: `parentDomain` is in the `parent_domain` list, or `parentName` is set. ("The parent is itself excluded" waits for R2.)
    - `existing_customer` and `open_deal`: `crmStatus`.
    - `domain_listed`: the domain is in the `do_not_contact_domain` list.
- `trigramSimilarity(a, b)`: the pg_trgm algorithm.
- `regionKey(country, region)`: `Florida` and `FL` both give `US-FL`.

- [ ] **Step 1: Write failing tests.**
  - ACC-E1-S3-AC2: the primary rule.
  - ACC-E3-S2-AC1: the five picking cases.
  - ACC-E4-S1-AC1: the three duplicate keys. AC2: the fine-type rules (`raised a Series B` gives `funding` under `trigger` and null under `pain`; `named CIO` gives `leadership`).
  - ACC-E7-S1-AC1: the 3 vendor and 2 parent cases from `c3c2124:tests/unit/vibe.test.ts`, translated as in Task 16:
    - Their NAICS codes `5112`, `5132`, `5182` and `54151`, or LinkedIn category, give `industryKey: 'software'`.
    - Their description text supplies `parentName`.
    - Each test states the translated input.
  - `matchName('Keystone Ridge Properties LLC') === matchName('Keystone Ridge Properties')`.
  - `matchName('Miami-Dade County') === matchName('Miami Dade County')`.
  - `trigramSimilarity('Keystone Ridge Properties', 'Keystone Ridge Property')` is above 0.85, `trigramSimilarity('Keystone Ridge Properties', 'Harbor Point Holdings')` is below 0.2, and `trigramSimilarity('abc', 'xyz')` is 0.
  - v1's seniority ordering cases.
- [ ] **Step 2:** Run `npm run test:unit -- accounts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): domain rules for names, people, current values, signals and exclusions`.

### Task 6: Accounts write services and upsertFromArrival

**Files:**
- Create: `src/modules/accounts/services/{lock,facts,people,signals,exclusion,summary,practices,upsert}.ts`
- Modify: `src/modules/accounts/index.ts`
- Test: `tests/integration/accounts/upsert.test.ts`

**Interfaces:**
- `lockAccount(ctx, accountId)`: `pg_advisory_xact_lock(hashtext(tenant_id || ':acc:' || accountId))`. `lockAccounts(ctx, ids)` takes them in sorted order.
- `recordFacts(ctx, accountId, personId | null, facts, chain, arrivalId?)` returns the fact ids. `reproject(ctx, accountId, keys?)` re-picks current values with `pickCurrent` and the trust from `sourceInfoProvider`, then writes the account and person columns, `industry_key`, `match_name` and `hq_state_key`.
- `matchOrAddPerson(ctx, accountId, input, chain, arrivalId)` returns `{ personId, existing }`. It matches by email, then LinkedIn, then same first and last name. A research-sheet email with no name match attaches to the person whose name fits the email's local part. Roles are recorded with `origin: 'stated'`.
- `storeSignal(ctx, accountId, input, chain, arrivalId, receivedAt)` returns `{ signalId, existing }`. It applies the dedup keys and fills the arrival date for undated research signals.
- `applyExclusion(ctx, accountId)` re-evaluates and writes `excluded_reason_key`, and publishes `accounts.account.exclusion_changed` when the result changes.
- `writeSummary(ctx, accountId, { addSourceIds? })` updates the name fields, `practice_ids`, `last_signal_at` and the union of `source_ids`. The scoring, review and CRM columns are left for later plans.
- `setPractices(ctx, accountId, practiceIds, by: 'hint' | 'person')`: a hint only adds; a person may also remove. Publishes `accounts.account.updated` with `changedKeys: ['practice_ids']` when something changed.
- `upsertFromArrival(ctx, arrival, accountId?)` returns `{ accountId, created, personIds, existingPersonIds, signalIds, existingSignalIds, factIds, excluded }`. It is a transaction script. It creates or loads the account, takes `lockAccount`, then calls the services above in this order:
  1. Facts
  2. Re-project
  3. Aliases: domain, name and `external_id`
  4. People
  5. Signals
  6. Research tier projection
  7. `setPractices(hint)`, after `resolvePractice`
  8. Exclusion
  9. Summary, adding the chain's source ids inline, so no intake event is consumed
  10. Events (ACC-E1-S1-AC1)

  Shell accounts follow ACC-E1-S2: the name is "<First Last>", `is_shell = true`, and the person gets roles `business_owner` and `commercial_buyer`. Reads inside it don't apply visibility.

- [ ] **Step 1: Write failing tests.**
  - ACC-E1-S1-AC1:
    - The call creates the account, 2 people, 3 facts and 1 signal in one transaction.
    - The outbox holds the account and person events, plus one event for each fact and signal.
  - ACC-E1-S1-AC2: a second call with the account id and the same email and signal returns them as existing.
  - ACC-E1-S1-AC3: every row carries the arrival id and chain.
  - ACC-E1-S2-AC1: the shell account is created.
  - Practices: a practice hint adds a practice; a later arrival without a hint keeps it.
  - Research tier: `researcher_tier` `A` with a signal dated 2026-06-02 sets both research tier columns.
  - Undated research signals: one sent with `receivedAt` 2026-10-26 is stored as 2026-10-26.
  - Exclusion: a software vendor arrival gives `excluded.key = 'software_vendor'`.
  - Trust: `employees` facts from chains with trust 0.6 and 0.8 (stubbed provider) make the 0.8 value current.
  - `source_ids` holds the chain's sources right after the call.
  - Concurrency (Review Focus 1, part): two concurrent `upsertFromArrival` calls with the same account id and the same no-email person (same name) give one person.
- [ ] **Step 2:** Run `npm run test:int -- accounts/upsert`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): write services and upsertFromArrival`.

### Task 7: findMatches and merged-id resolution

**Files:**
- Create: `src/modules/accounts/services/match.ts`
- Test: `tests/integration/accounts/match.test.ts`

**Interfaces:**
- `findMatches(ctx, candidate)` returns `{ accountId, confidence, reason }[]`, at most 5. The candidate is `{ domain?, linkedinUrl?, externalIds?, name?, country?, region?, city?, shellEmail? }`. Rows come in SRC-E3 table order.
  - `likely`: the same `match_name` and country, on an account with no domain.
  - `possible`: similarity of at least 0.85, and the same `hq_state_key` or city.
- `resolveAccountId(ctx, id)` returns `{ id, mergedInto? } | null` by following `merged_id` aliases.
- The reasons are the copy listed in SRC-E3's match table.

- [ ] **Step 1: Write failing tests.**
  - Certain matches: SRC-E3-S2-AC1 at this level; an alias domain; a LinkedIn page; `(apollo, 123)`.
  - SRC-E3-S2-AC3: `Keystone Ridge Properties LLC`, US, no domain, gives likely. With a different domain on each side, there is no likely row.
  - Possible: `Keystone Ridge Property` in `Florida` against the account `Keystone Ridge Properties` in `FL` (different `match_name`, so the likely rule doesn't fire) gives possible. The same pair in different states gives nothing.
  - Shell accounts: ACC-E1-S2-AC2 (the shell email matches), moved here from Task 6.
  - Archived accounts never match.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): find matching accounts and follow merged ids`.

### Task 8: Account reads and people's edits

**Files:**
- Create: `src/modules/accounts/services/read.ts`, `src/modules/accounts/services/edit.ts`
- Test: `tests/integration/accounts/read-edit.test.ts`

**Interfaces:**
- Reads. Each one follows `resolveAccountId` and applies `visibleAccounts` (Task 10) once that exists; until then the visibility check is a stub that returns true.
  - `getAccount` sets `mergedInto` when it was asked for a merged id.
  - `getAccounts`, `getSignals(ctx, accountId, { since?, includeArchived? })`, `getFacts(ctx, accountId, { key?, includeHistory? })`, `listPeople(ctx, accountId)`.
  - `getAccountForScoring` returns the ACC index row's fields.
  - `checkExclusion`.
- Edits (people only: `ctx.access.userId` is required, otherwise `Only a person can edit this here.`). Each edit takes `lockAccount` first.
  - `editAccount(ctx, accountId, patch)` and `editPerson(ctx, personId, patch)`: each changed field becomes a fact pinned by the editor. `ctx.access.sourceId`, the editor's person source, is the person level of its chain. `reproject` runs, and `accounts.account.updated` or `accounts.person.updated` is published. Role edits use `origin: 'set_by_person'`.
  - `pinPrimary(ctx, accountId, personId | null)`.
  - `archiveSignal(ctx, signalId, reason)`.
  - `overrideExclusion(ctx, accountId, note)` (the note is required: `Add a note saying why.`; the change is audited) and `removeExclusionOverride`.
  - `convertShell(ctx, accountId, { name, domain })`.
- The primary contact is re-picked inline on person changes. Target titles come from the best offer, which arrives with R1b, so until then the list is empty.

- [ ] **Step 1: Write failing tests.**
  - `getAccountForScoring` field coverage.
  - A person removes a practice through `setPractices(..., 'person')`.
  - An `editAccount` pin survives a later fact from a source with higher trust.
  - ACC-E7-S2-AC1: an override needs a note, and writes an audit row plus `exclusion_changed` with `override: true`.
  - `archiveSignal` hides the signal from scoring reads; `includeArchived` shows it again.
  - ACC-E1-S2-AC3: `convertShell` keeps the old name as an alias.
  - An API-key context calling `editAccount` gets the people-only copy.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): reads and pinned edits`.

### Task 9: Merges

**Files:**
- Create: `src/modules/accounts/services/merge.ts`
- Test: `tests/integration/accounts/merge.test.ts`

**Interfaces:**
- `mergeAccounts(ctx, survivorId, mergedId)`:
  - People only. Others get `Only a person can merge accounts.` (403).
  - Calls `lockAccounts([a, b])`, then `mergeGuard().check`. A refusal is a 409 `conflict` with the guard's reason.
  - Moves to the survivor: people (de-duplicated; a duplicate person becomes a `person_alias` of kind `merged_id`), facts, signals (dedup applies), aliases, the union of practices and the union of the summary's `source_ids`.
  - Adds the merged account's domain, name and id as aliases.
  - Runs `reproject` and `applyExclusion` on the survivor.
  - Archives the merged account with reason `merged`.
  - Publishes `accounts.account.merged` and `accounts.account.archived`, and writes an audit row.

- [ ] **Step 1: Write failing tests.**
  - ACC-E5-S1-AC2 at this level: the merged domain now matches the survivor.
  - ACC-E5-S1-AC3: `getAccount(mergedId)` returns the survivor with `mergedInto`.
  - Duplicate people collapse into one.
  - The survivor's summary `source_ids` is the union of both accounts'.
  - A guard that refuses makes the merge fail with its copy, and nothing changes.
  - An API-key context gets 403.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): merge accounts`.

### Task 10: Visibility, search and exclusion settings

**Files:**
- Create: `src/modules/accounts/services/{visibility,search,settings}.ts`, `src/modules/accounts/jobs.ts`
- Modify: `src/modules/accounts/services/read.ts` (replace the visibility stub), `src/entry/worker.ts`
- Test: `tests/integration/accounts/visibility.test.ts`, `tests/integration/accounts/search.test.ts`, `tests/integration/accounts/settings.test.ts`

**Interfaces:**
- `visibleAccounts(ctx): Promise<SQL>` is an async builder of a Drizzle condition on `account_summary` (child sources are expanded through the async port). `filterVisibleAccountIds(ctx, ids): Promise<string[]>` returns the subset of `ids` the principal can see; intake uses it. Unset `access` (system) or `all` means everything. Otherwise:
  - `own_source`: `source_ids` overlaps `[sourceId, ...childSourceIds]`.
  - `sources {ids}`: overlaps those ids plus their children. The ids are expanded through the accounts `SourceAccessProvider` port (implemented in Task 12); tests stub it.
  - `practices {ids}`: `practice_ids` overlaps, or `practice_id` is in the ids.
  - `own_accounts`: `owner_user_id = userId`, or `source_ids` contains the user's person source (`access.sourceId`).
  - `any_of`: the OR of its parts.
- `search(ctx, query)` returns `{ data, nextCursor }`, with every ACC-E8 filter and sort.
  - Filters on scoring, review and CRM columns are accepted and match nothing until R1b and R1c fill them.
  - Text search covers name, domain and aliases with `ILIKE`.
- Exclusion settings (`settings:manage`):
  - `listExclusionRules(ctx)`, `setExclusionRule(ctx, key, enabled)`, `setExclusionList(ctx, kind, values)`.
  - Each change enqueues `jobs.accounts.exclusions.recheck { cursor? }`, which calls `applyExclusion` on 100 accounts per message and enqueues the next page. The small page keeps account locks short, so resolves aren't held up.

- [ ] **Step 1: Write failing tests.**
  - TEN-E3-S1-AC2 suite on `search` and `getAccount`:
    - `own_source` (ACC-E8-S2-AC2).
    - `own_source` of a person whose agent sent the account.
    - `sources` naming a person source sees its agent's accounts.
    - `practices`.
    - `own_accounts` sees the account the seller imported through their person source.
    - `any_of`.
  - Filters: alias text, `excluded: true`, and paging over 120 accounts (50, 50, 20, no repeats).
  - Settings:
    - Turning off `software_vendor` and running the recheck through `runOutbox` clears that exclusion.
    - Adding the account's domain to `do_not_contact_domain` sets `domain_listed`.
  - ACC-E8-S1-AC2 (slow, CI only): over 10,000 summaries, p95 under 500 ms across 20 runs.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): data limits, search and exclusion settings`.

### Task 11: Intake schema, arrival contract and normalising rules

**Files:**
- Create: `src/modules/intake/{index.ts,contracts/arrival.ts,contracts/events.ts,contracts/jobs.ts,db/schema.ts,db/migrations/*}`, `src/modules/intake/domain/{normalise,free-email,industry,warm-intro,day}.ts`, `drizzle/intake.config.ts`
- Modify: `bootstrap.sql`, `migrate.ts`, `migrate.test.ts`, `Dockerfile`, `registry.ts`, RLS catalog test, `package.json`
- Test: `tests/unit/intake/{arrival-contract,normalise,warm-intro,day}.test.ts`, `tests/integration/intake/schema.test.ts`

**Interfaces:**
- Tables. These are the SRC index tables, minus `source_trust_history`, `arrival_outcome` and `source_feedback`. Every table has `tenant_id`.
  - `source`
  - `arrival`, with these extra columns:
    - `closest_source_id`: the agent, else the person, else the vendor.
    - `channel`.
    - `waiting_since`.
    - `resolution_input`: a person's decision.
    - `normalised`: the step 2 output.
    - `lock_key`.
    - `steps`: which steps are done.
  - `batch`
  - `batch_file`
  - `file_blob`
  - `file_import`
  - `column_mapping`
  - `warm_intro`
  - `warm_intro_rule`
  - `relationship_default`
- Indexes and trigger:
  - Unique `arrival (tenant_id, closest_source_id, external_ref)` where `external_ref is not null`. A rejected `duplicate_in_batch` row stores `external_ref = null`; the ref stays in `payload.raw`.
  - `arrival (tenant_id, closest_source_id, received_at)`, for the cap.
  - `arrival (tenant_id, status, waiting_on)`.
  - `arrival (tenant_id, batch_id)`.
  - `arrival (tenant_id, account_id)`.
  - The immutability trigger from Global Constraints.
- `ArrivalV1Schema(opts: { strict: boolean })`:
  - Fixed-shape objects are `.strict()`. `facts` is either a `z.record` or the list form; unknown keys are kept.
  - `strict: true` is for the API and MCP: it requires name plus one identity, and `occurred_at` on every signal.
  - `strict: false` is for files, webhooks and vendors: no identity is required, and research signals may be undated.
  - Copy: `Must be a domain like acme.com.`, `Add the company name.`, `Add a website, domain or LinkedIn page.`, `Add the date it happened.`, `At most 25 people.`, `At most 50 signals.`, `At most 200 facts.`
- `BatchV1Schema`: the envelope plus items. Item-level `external_ref` and `notes`, as in the `async-and-batches.md` example, are moved into `account` before validation.
- Events: every SRC index event except `trust_changed`, `warm_intro.confirmed` and `feedback.recorded`.
- Jobs:
  - `intake.resolve { arrivalId }`, timeout 30 s.
  - `intake.import.run { importId }`, timeout 5 min.
  - `intake.waiting.expire {}`.
- Intake has no `contracts/ports.ts`: the ports it implements are defined by tenancy (`SourceValidator`) and accounts (`SourceInfoProvider`, `SourceAccessProvider`).
- Domain:
  - `normaliseDomain` (Review Focus 3).
  - `domainFromEmail`, `isFreeEmailDomain` (the list from `c3c2124:src/lib/leadChecks.ts`).
  - `countryCode` (`United States`, `USA` and `us` all give `US`).
  - `parseRange` (`501-1000`, `10001+`, `75M-200M`, `[201-500]`).
  - `industryKey(text)`: v1 NAICS prefixes and offer industry words map to keys. NAICS `5112`, `5132`, `5182`, `54151` and the LinkedIn category "Software Development" give `software`.
  - `relationshipKey(text)`.
  - `warmIntroPoints({ relationshipKey, introducerRule?, defaults, confirmed })`: unconfirmed points are halved and rounded down.
  - `strongest(intros)`.
  - `isConfirmed({ declaredBy: 'person' | 'person_key' | 'agent' | 'vendor' })`: true for a person and for a key with `warm_intro:declare` on a person source.
  - `tenantDayStart(now, timezone)` and `nextTenantDay(now, timezone)`.

- [ ] **Step 1: Write failing tests.**
  - Contract:
    - The SRC-E2 example parses.
    - The `async-and-batches.md` batch example parses.
    - `account.colour` fails at its path.
    - Strict mode rejects a name-only account and an undated signal, each with its copy. Lenient mode accepts both, and an undated research signal.
    - 26 people fail.
    - Unknown `facts` keys are kept.
  - Normalise: the Review Focus 3 table, the Miami-Dade URL, `[201-500]`, and `USA`.
  - Warm intro:
    - SRC-E5-S2-AC2 rules. Unconfirmed 8 gives 4, and 5 gives 2.
    - `knows the CTC director from FPTA` maps to `employee_network`; `met at FPTA 2026` maps to `event_meeting`.
    - A person key with `warm_intro:declare` counts as confirmed.
  - Day (Review Focus 4):
    - `tenantDayStart(2026-11-01T03:30:00Z, 'America/New_York')` is `2026-10-31T04:00:00Z`.
    - `nextTenantDay(2026-11-01T12:00:00Z, 'America/New_York')` is `2026-11-02T05:00:00Z`.
  - Integration: updating an arrival's `payload` raises an error, and updating its `status` works.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, including `platform/rls` and `platform/migrate`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): schema, arrival contract and normalising rules`.

### Task 12: Sources, ports, caps and submission

**Files:**
- Create: `src/modules/intake/services/{sources,caps,submit}.ts`, `src/modules/intake/defaults.ts`, `src/modules/intake/consumers.ts`
- Modify:
  - `src/modules/intake/index.ts`, `src/entry/compose.ts` and `src/entry/worker.ts`.
  - Tenancy (`src/modules/tenancy/index.ts` plus its services):
    - Export `tenantTimezone(ctx)`.
    - Export `revokeKeysForSource(ctx, sourceId)`.
    - Update the stale `NEEDS_SOURCE_LATER` copy in `services/api-keys.ts` to `Pick the source this key sends for.`
- Test: `tests/integration/intake/{sources,submit,caps}.test.ts`

**Interfaces:**
- Sources:
  - `registerSource(ctx, input)`. Its copy: `An agent needs an owner. Pick the person who runs it.`, `A scheduled pull needs a vendor.`, `This person already has a source.`
  - `updateSource(ctx, id, patch)`. Pausing stores nothing more for that source. Archiving revokes the source's keys through tenancy (SRC-E1 "keys are revoked"). The cap must stay in range: `The daily limit must be between 0 and 10,000.`
  - `listSources(ctx)`: in tree order, visible to the principal (own source and its children, or all), with arrivals in the last 30 days and trust 0.60.
  - `childSources(ctx, ids)`, `personSourceFor(ctx, userId)`.
- Port implementations, registered in `compose.ts`: `SourceValidator` (tenancy's port), and `SourceInfoProvider` (`getTrust` per Ruling 2; `sourcesForAccount` from resolved arrivals) and `SourceAccessProvider` (both accounts' ports).
  - `v1Route` and `tenantAction` now fill `access.childSourceIds`, and for a signed-in person set `access.sourceId` to `personSourceFor(userId)`. Test both: a cookie-session `/v1` request from a seller carries their person source.
  - `tenantAction` also fills `access.sourceId` with `personSourceFor(userId)`.
- Consumer `intake.tenant_defaults` on `tenancy.tenant.created` creates:
  - The vendor sources `apollo` (Apollo), `vibe` (Vibe Prospecting) and `hubspot_qualified` (HubSpot marketing qualified, kind `crm`), each with `settings.key`.
  - The six relationship defaults.
  - The expiry schedule.
- `checkArrivalCap(ctx, sourceId)` (Ruling 1) takes `pg_advisory_xact_lock` on `cap:<sourceId>`, counts `received_at >= tenantDayStart`, and returns `{ allowed, resetsAt }`.
- `submitArrival(ctx, body, opts)` returns `{ arrivalId, status, duplicateOfRequest, inlineResult? }`.
  - `opts` is `{ channel, batchId?, inline?, raw? }`.
  - The chain comes from `ctx.access.sourceId` plus its parent, plus `via_vendor` matched by vendor `settings.key`.
  - Source status: paused gives 403 `This source is paused`; archived gives 403 `This source is archived. Ask an owner for a new key.`
  - Over the cap, a single arrival gets `ScoutError({ slug: 'cap-reached', status: 429, title: 'This source has sent its daily limit of arrivals.', headers: { 'retry-after': <seconds> }, extensions: { resets_at } })`, and nothing is stored.
  - A `target_account_id` the principal can't see gives 404 `not-found` (Accounts `getAccount` returns null).
  - It inserts with `on conflict do nothing` on the `external_ref` index, then selects the existing row and returns `duplicateOfRequest: true`.
  - It stores `payload = { raw, contractVersion: 1 }`, publishes `intake.arrival.received`, and enqueues `jobs.intake.resolve` unless the call is inline.
- `submitBatch(ctx, body, opts)` returns `{ batchId, items: [{ arrivalId, externalRef, status }] }`.
  - Follows Ruling 7.
  - An item that repeats an earlier ref or normalised domain is rejected `duplicate_in_batch`, with its `external_ref` stored as null.
  - Items over the cap are rejected `daily_cap_reached`, with `This source reached its daily limit. Send this one again after <local time>.`
  - Publishes `intake.batch.created`.

- [ ] **Step 1: Write failing tests.**
  - Sources:
    - SRC-E1-S1-AC1, AC2.
    - SRC-E1-S1-AC4 through `runOutbox`.
    - Archiving revokes the source's key; a request with that key then gets 401.
  - Caps:
    - SRC-E1-S2-AC1, AC2. With a cap of 2, the third single arrival gets 429 with `Retry-After` at the next tenant day. In a batch of 3, the third is rejected.
    - Two concurrent submits at count 1 with a cap of 2: exactly one is stored.
    - SRC-E1-S2-AC3, AC4.
    - A person's import of 600 rows is not capped.
  - Submission:
    - SRC-E2-S1-AC1, AC2, AC3. AC3 includes two concurrent singles with the same ref: one row, and the second response has `duplicateOfRequest: true`.
    - SRC-E2-S1-AC5.
  - Review Focus 5, submission side: items 2 and 4 are invalid, and items 3 and 5 share a ref.
  - Tenancy: `createApiKey` with an unknown `source_id` fails.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): sources, caps and arrival submission`.

### Task 13: AI tasks for intake

**Files:**
- Create: `src/modules/intake/tasks/arrival-normalise.ts`, `src/modules/intake/tasks/csv-column-mapping.ts`, `src/modules/intake/import/synonyms.ts`
- Test: `tests/unit/intake/synonyms.test.ts`, `tests/integration/intake/tasks.test.ts`

**Interfaces:**
- `arrivalNormaliseTask` (Ruling 12):
  - `rules` and `mock` both return `{ industryKey: null, relationshipKey: null }`.
  - `normaliseWithAi(ctx, input)` wraps `runTask`. On any `ScoutError` it returns the null result, so it never throws.
- `csvColumnMappingTask`:
  - Input: headers and 5 sample rows.
  - Output: `{ columns: { header, target, confidence, reason }[] }`.
  - `rules` and `mock` are `synonymMapping` (port the lead-sheet header guesses from `c3c2124:src/lib/leadSheet.ts`).
  - Targets outside the allowed list become null. Columns under 0.6 confidence are left unmapped.
- `suggestMapping(ctx, headers, sampleRows)` returns `{ mapping, origin: 'ai' | 'synonyms' }`. The origin is `synonyms` whenever the run mode is `rules` or `mock`.

- [ ] **Step 1: Write failing tests.**
  - Synonyms: `Website`, `Company`, `First Name`, `Email` and `Job Title` map to their targets.
  - With no Claude connection, `normaliseWithAi` returns nulls, and `suggestMapping` returns `synonyms`.
  - With a live adapter stub that throws, `normaliseWithAi` returns nulls.
  - With a stub returning a target that isn't allowed, that target becomes null.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): AI tasks for normalising and column mapping, with rules fallbacks`.

### Task 14: The resolve pipeline

**Files:**
- Create: `src/modules/intake/services/resolve.ts`, `src/modules/intake/services/warm-intros.ts`, `src/modules/intake/jobs.ts`
- Modify: `src/entry/worker.ts`
- Test: `tests/integration/intake/resolve.test.ts`

**Interfaces:**
- `resolveHandler` for `jobs.intake.resolve` calls `resolveArrival(ctx, arrivalId)`, which runs SRC-E3 steps 1 to 8. Each step records itself in `arrival.steps` and skips if already done.
  1. Validate, in the lenient or strict mode the channel calls for.
  2. Normalise, including `normaliseWithAi`. This runs and is saved to `arrival.normalised` before any lock. Inline mode uses the rules only and never calls Claude, so `add_person` and `add_signal` stay fast.
  3. Waiting checks:
     - `needs_website` or `needs_company`: set `waiting_since`, publish `intake.arrival.waiting`, and stop.
     - A stored `resolution_input` answers the question and continues.
  4. Take the resolve lock with `pg_advisory_xact_lock(hashtext(tenant || ':res:' || lock_key))`. `lock_key` is the normalised domain, else `name:<matchName>|<country>`, else `email:<shell email>`, else the arrival id. Then `findMatches`:
     - A `possible` match waits as `possible_duplicate` with its candidates, sets `waiting_since` and publishes `intake.arrival.waiting`, unless `resolution_input` decides.
     - A `target_account_id` skips matching.
  5. `upsertFromArrival`.
  6. Warm intro: `recordWarmIntro(ctx, arrivalId, accountId, input, declaredBy)` stores the row and points.
  7. Exclusion. If the account is excluded and not overridden, the arrival is rejected `excluded` with `account_id` set and the rule's label as `detail`. Otherwise publish `intake.arrival.resolved`, with:
     - `isFirstFromSource`: no earlier resolved arrival from the same `closest_source_id` to this account.
     - `initialReviewStatusKey`: from the closest source.
     - `effectiveTrust`.
     - `warmIntro`, `practiceHint` and `offerHint`.
  8. Batch counters: take the row lock `select … for update` on the batch, then update `counts`. When nothing in the batch is received, resolving or waiting, publish `intake.batch.completed` once, with `reportedCost` from `metadata.reported_cost`.
- `rejectArrival(ctx, arrivalId, reason, detail)` is the one path for every rejection: it updates batch counters and handles completion.
- Inline mode (targeted only) runs steps 1, 2, 5 and 7 in the caller's transaction. It returns `InlineResult = { arrivalId, accountId, personIds, signalIds, alreadyKnown }`.
- `getWarmIntro(ctx, accountId)` returns the strongest intro.

- [ ] **Step 1: Write failing tests.**
  - Duplicate checks:
    - SRC-E3-S2-AC1: run through `submitArrival` and `runOutbox`.
    - SRC-E3-S2-AC2: an arrival for an alias of a merged account attaches to the survivor.
  - Idempotent retries:
    - SRC-E3-S1-AC3: a test hook throws after step 5; the retry still gives one account, one set of people, facts and signals, and one `resolved` event.
  - First arrivals from a source:
    - SRC-E3-S4-AC2: true, then false for the same agent; true for a second agent under the same person.
  - Exclusion: a software vendor arrival is rejected `excluded`, with `detail` set to `Software vendor`.
  - Warm intros:
    - An agent-declared intro gives `employee_network` at 4 points.
    - `getWarmIntro` returns the 8-point confirmed one when both exist.
  - Batch completion:
    - Review Focus 5, completion side: the valid items resolve, and `intake.batch.completed` is published once.
    - Its counts are `resolved`, `rejected`, `newAccounts` and `alreadyKnown`.
  - Concurrency (Review Focus 1):
    - Two agents' batches with `acme.com` resolved concurrently give one account.
    - Two lenient arrivals named `Keystone Ridge Properties`, US, with no domain, resolved concurrently, give one account.
    - An alias-domain arrival racing a primary-domain arrival gives one account and no duplicate people.
    - An inline `add_person` racing a resolve job for the same account gives one person.
  - No Claude key: an arrival with an unknown industry resolves, with `industry_key` null.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): resolve pipeline`.

### Task 15: Waiting arrivals, status reads, visibility and merges

**Files:**
- Create: `src/modules/intake/services/{waiting,status,visibility}.ts`
- Modify: `src/modules/intake/jobs.ts`, `src/modules/intake/consumers.ts`, `src/entry/worker.ts`
- Test: `tests/integration/intake/{waiting,status,merge}.test.ts`

**Interfaces:**
- Waiting:
  - `listWaiting(ctx, { reason?, cursor?, limit? })`.
  - Resolving one: `supplyWebsite(ctx, arrivalId, website)`, `supplyCompany(ctx, arrivalId, { name, website? } | { soleProprietor: true })` and `chooseDuplicate(ctx, arrivalId, { kind: 'same_as', accountId } | { kind: 'new_company' })`. Each writes `resolution_input`, records an audit entry, and enqueues a resolve job.
  - `skipWaiting(ctx, batchId)` rejects each waiting item `invalid` with `Skipped by <name>.` through `rejectArrival`.
- `waitingExpireHandler` rejects arrivals whose `waiting_since` is more than 30 days old, through `rejectArrival`. The detail depends on why it was waiting:
  - `needs_website`: `Nobody supplied the missing website within 30 days`
  - `needs_company`: `Nobody supplied the company within 30 days`
  - `possible_duplicate`: `Nobody decided whether this was a duplicate within 30 days`
- `visibleArrivals(ctx)` follows TEN-E3-S1-AC2:
  - `own_source` and `sources`, with children: the chain overlaps.
  - `practices` and `own_accounts`: the arrival is resolved and Accounts' `filterVisibleAccountIds` keeps its `account_id`. Lists under these limits read pages of candidate arrivals and filter each page, repeating until `limit` rows are kept or the rows run out, so paging stays correct whatever the number of visible accounts.
  - `any_of`: the OR of its parts.
- Status reads:
  - `getArrival(ctx, id)` returns status, `waiting_on`, reason, detail, account id, `created_account` (true when the resolution was `created`), `duplicate_of` (the account id when `attached`), chain, raw payload and `unusedKeys` (from `isKnownFactKey`).
  - `listArrivals(ctx, { batchId?, accountId?, status?, since?, cursor?, limit? })`. `accountId` serves SRC-E2-S4-AC2.
  - Batches: `listBatches(ctx, { cursor, limit })`, `getBatch(ctx, id)` and `listBatchItems`.
  - `accountForArrival(ctx, arrivalId)`.
  - Every read applies `visibleArrivals` and returns null when the arrival is hidden.
- Consumer `intake.account_merged` on `accounts.account.merged`, ordered by `survivorId`, repoints `arrival.account_id`, `warm_intro.account_id` and the ids inside `duplicate_candidates`.

- [ ] **Step 1: Write failing tests.**
  - Waiting arrivals:
    - SRC-E3-S3-AC1 and AC2: supplying the website resumes the arrival and completes its batch.
    - AC3: an arrival waiting since 31 days ago is rejected with the right copy for each reason, and its batch counts update.
    - SRC-E3-S2-AC4: `chooseDuplicate` with `same_as` attaches the arrival; with `new_company` it creates a new account. Both are audited.
    - `supplyCompany({ soleProprietor: true })` makes a shell account.
  - Status reads:
    - SRC-E2-S3-AC1: `getBatch` returns counts and rejections.
    - AC3: an arrival and a batch from another source come back as null.
    - The `practices` and `own_accounts` limits on `listArrivals`.
    - `listArrivals({ accountId })` returns arrivals newest first.
  - Merges: after a merge runs through `runOutbox`, `getWarmIntro(survivor)` and `sourcesForAccount(survivor)` include the merged account's.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): waiting arrivals, status reads, visibility and merge repointing`.

### Task 16: File parsing and import layouts

**Files:**
- Create: `src/modules/intake/import/parse.ts`, `src/modules/intake/import/layouts/{index,research,vibe}.ts`, `src/modules/intake/import/rows-to-arrivals.ts`, fixtures under `tests/fixtures/imports/` built from v1's inline test data
- Modify: `package.json` (`exceljs`)
- Test: `tests/unit/intake/{parse,layouts,rows-to-arrivals}.test.ts`

**Interfaces:**
- `parseFile({ fileName, contentType?, bytes }, { sheet? })` returns a `ParsedFile`.
  - CSV and Markdown:
    - Port `c3c2124:src/lib/leadSheet.ts`.
    - Detect the delimiter.
    - Handle quotes and line breaks in cells.
    - Strip the BOM.
    - Suffix duplicate headers (` (2)`).
    - Skip blank rows.
    - Keep each row's original number.
  - Excel uses the streaming `WorkbookReader`: `sheets` lists every sheet, and dates become `YYYY-MM-DD`.
  - Limits: `This file is over 20 MB. Split it and import the parts.` and `This file has more than 10,000 rows. Split it and import the parts.`
- `LAYOUTS: ImportLayout[]` with `ImportLayout = { key: 'research' | 'research_master' | 'vibe_export'; detect(headers): boolean; toArrivals(parsed, ctx: { now; fileName }): ArrivalDraft[] }`.
  - `research` ports `c3c2124:src/lib/research.ts`: `RESEARCH_FIELDS`, the four layouts, master files and practice filing from the agent column or file name.
  - `vibe` ports `c3c2124:src/integrations/prospects/vibe.ts` and `vibeExport.ts`. It covers the event rules, people and seniority, and the NAICS and LinkedIn category as `industry` text, which `industryKey` maps. The `PARENT_TEXT` match becomes a `parent_name` fact.
- `rowsToArrivals(parsed, mapping, { fileName })` returns `{ arrivals: { body, raw }[]; skipped: { row, reason }[] }`.
  - Rows are grouped by domain: the website column, else the work-email domain.
  - A personal-email row with no company is skipped with `Personal email and no company`.
  - A company with no website is kept, so it waits for one.

- [ ] **Step 1: Write failing tests.**
  - Port `c3c2124:tests/unit/leadSheet.test.ts` (parsing).
  - Review Focus 2.
  - A two-sheet `.xlsx` fixture, built in the test with `exceljs`, lists both sheets and parses the second.
  - A Markdown table.
  - Both limit messages.
  - SRC-E4-S2-AC1: port `c3c2124:tests/unit/research.test.ts`.
  - SRC-E4-S2-AC2: port `c3c2124:tests/unit/vibeExport.test.ts` and `vibe.test.ts`.
  - Grouping: two `@acme.com` rows with no website give one arrival with two people.
  - Skipping: a `gmail.com` row with no company is skipped with its row number.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): parse files and recognise research and Vibe layouts`.

### Task 17: Saved mappings, imports and batch files

**Files:**
- Create: `src/modules/intake/services/{mappings,files,imports}.ts`
- Modify: `src/modules/intake/jobs.ts`, `src/entry/worker.ts`
- Test: `tests/integration/intake/{mappings,imports,files}.test.ts`

**Interfaces:**
- Mappings:
  - `headerSignature(headers)`.
  - `chooseMapping(ctx, { sourceId, headers, sampleRows })` returns `{ mapping, origin: 'layout' | 'saved' | 'synonyms' | 'ai', needsConfirm }`. The order is layout, then saved, then `suggestMapping`. `needsConfirm` is false only for layout or saved when every required field is mapped.
  - `saveMapping`, `listMappings(ctx, sourceId)`, `deleteMapping`.
- Files:
  - `attachFile(ctx, batchId, file)`: the batch must be visible to the caller (otherwise 404). Errors: `Files can be up to 25 MB each.` and `A batch can have up to 10 files.`
  - `readFile`.
- Imports:
  - `createImport(ctx, { fileName, contentType, bytes, sheet?, vendorSourceId? })` parses before writing anything. It then creates the batch with `ctx.access.sourceId` as the source (an API key's own source, or a signed-in person's person source), so an agent's import keeps its chain and its cap (Ruling 1 exempts only person sources), attaches the file and stores the `file_import`. The status is `needs_sheet`, `needs_confirm` or `queued`; `queued` enqueues `jobs.intake.import.run`.
  - `previewImport(ctx, importId, mapping?)` returns the first 5 arrivals.
  - `confirmImport(ctx, importId, mapping)` saves the mapping and enqueues the run.
  - `importRunHandler` submits each arrival with channel `file`.
  - `getImport(ctx, id)` returns stats plus live batch counts: created, attached, waiting (with ids), rejected and skipped rows.

- [ ] **Step 1: Write failing tests.**
  - Files and sheets:
    - SRC-E4-S1-AC1: three imports give three batches, each with its sha256.
    - SRC-E4-S1-AC3: a multi-sheet file gives `needs_sheet`.
    - SRC-E2-S2-AC2: attaching a file records its sha256. A 26 MB file and an 11th file are refused. Another source's batch gives 404.
  - Mappings:
    - SRC-E4-S2-AC3: a saved mapping is reused when the headers come in a different order.
    - SRC-E4-S3-AC1: in mock mode the origin is `synonyms`.
    - SRC-E4-S3-AC2: the preview returns 5 arrivals.
    - SRC-E4-S3-AC3: a mapping is saved, listed and deleted.
  - Running an import:
    - SRC-E4-S4-AC1: a research fixture imports with no confirm, and after `runOutbox` `getImport` shows the right counts.
    - SRC-E4-S4-AC2: `skipWaiting` completes the batch.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): saved mappings, imports and batch files`.

### Task 18: Intake on /v1 for agents

**Files:**
- Create: `src/app/v1/sources/route.ts`, `src/app/v1/arrivals/route.ts`, `src/app/v1/arrivals/[id]/route.ts`, `src/app/v1/batches/route.ts`, `src/app/v1/batches/[id]/route.ts`, `src/app/v1/batches/[id]/items/route.ts`, `src/app/v1/batches/[id]/files/route.ts`, `src/app/v1/imports/route.ts`, `src/app/v1/imports/[id]/route.ts`
- Test: `tests/integration/v1/{arrivals,batches,imports,intake-limits}.test.ts`

**Interfaces:**
- The routes from the SRC index and `async-and-batches.md`. Paths are after `/v1`; responses are snake_case.

  | Method and path | Permission | Response |
  |---|---|---|
  | `POST /arrivals` | `arrivals:write`, idempotent | 202 `{ arrival_id, status_url }`. 200 `{ arrival_id, status_url, duplicate_of_request: true }` for a repeated `external_ref` |
  | `GET /arrivals/{id}` | `arrivals:read` | |
  | `GET /arrivals?batch_id&status&since&cursor` | `arrivals:read` | |
  | `GET /batches` | `arrivals:read` | |
  | `POST /batches` | `arrivals:write`, idempotent | 202 `{ batch_id, status_url, item_count, items }` |
  | `GET /batches/{id}` | `arrivals:read` | |
  | `GET /batches/{id}/items` | `arrivals:read` | |
  | `POST /batches/{id}/files` | `arrivals:write` | multipart |
  | `POST /imports` | `imports:run` | multipart; 202 `{ import_id, status, proposed_mapping, needs_confirm }` |
  | `GET /imports/{id}` | `imports:run` | |
  | `POST /imports/{id}:preview` | `imports:run` | |
  | `POST /imports/{id}:confirm` | `imports:run` | |
  | `GET /sources` | `arrivals:read` | |
  | `POST /sources` | `sources:manage` | |

- Errors:
  - Validation: 400 with `errors[]`.
  - Over the cap: 429 `cap-reached` with `Retry-After` and `resets_at`.
  - Hidden: 404.
  - Too large: 413 `This request is over the size limit.`

- [ ] **Step 1: Write failing tests.**
  - Idempotency:
    - API-E1-S2-AC1: the same `Idempotency-Key` creates one arrival.
    - AC2: a repeated `external_ref` gets 200 with `duplicate_of_request`.
  - Single arrivals:
    - SRC-E2-S1-AC1: 202 with the documented shape.
    - SRC-E2-S1-AC4: an invalid body gets 400 with two error paths, and nothing is stored.
    - SRC-E2-S1-AC6: over the cap, 429 with the headers.
    - An unknown top-level field gets 400.
  - Batches:
    - SRC-E2-S2-AC1: ids come back in order.
    - SRC-E2-S2-AC2: the file upload returns its sha256.
    - SRC-E2-S3-AC1: batch counts.
    - SRC-E2-S3-AC3: another source's arrival or batch gets 404.
  - Imports, SRC-E4-S4-AC3: a research fixture is queued; an unknown layout needs confirmation, then preview, then confirm.
  - TEN-E3-S1-AC2 on `GET /arrivals`, `GET /batches/{id}/items` and `GET /sources`, for each limit kind.
  - Performance (slow, CI only): the p95 of `POST /arrivals` is under 300 ms over 50 calls.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): /v1 sources, arrivals, batches and imports`.

### Task 19: Accounts on /v1 for agents

**Files:**
- Create: `src/app/v1/accounts/route.ts`, `src/app/v1/accounts/[id]/route.ts`, `src/app/v1/accounts/[id]/people/route.ts`, `src/app/v1/accounts/[id]/signals/route.ts`, `src/app/v1/accounts/[id]/facts/route.ts`, `src/app/v1/accounts/[id]/arrivals/route.ts`, `src/app/v1/people/[id]/route.ts`
- Test: `tests/integration/v1/accounts.test.ts`

**Interfaces:**
- The ACC index endpoints, without conflicts. Paths are after `/v1`.

  | Method and path | Permission | Notes |
  |---|---|---|
  | `GET /accounts` | `accounts:read` | |
  | `GET /accounts/{id}` | `accounts:read` | Includes `merged_into` |
  | `PATCH /accounts/{id}` | `accounts:write` | Ruling 9: a person pins; a key sends an inline targeted arrival with `facts` |
  | `GET /accounts/{id}/people` | `accounts:read` | `email`, `phone`, `mobile_phone` and `linkedin_url` only with `people:read` (TEN-E3-S3-AC1) |
  | `POST /accounts/{id}/people` | `people:write` | Inline; 201 `{ arrival_id, person_id, already_known }` |
  | `PATCH /people/{id}` | `people:write` | Same rule as `PATCH /accounts/{id}`. For a key, the route passes an internal `targetPersonId` to `submitArrival` (an option, never read from the body), so the facts land on `{id}` and a changed email updates that person instead of adding one |
  | `POST /accounts/{id}/signals` | `signals:write` | Inline; 201 `{ arrival_id, signal_id, already_known, warning? }` |
  | `GET /accounts/{id}/facts?field&include=history` | `accounts:read` | |
  | `GET /accounts/{id}/arrivals` | `arrivals:read` | |

- [ ] **Step 1: Write failing tests.**
  - Adding people, ACC-E1-S4:
    - AC1: an agent's call returns the `person_id` in the same response.
    - AC2: a repeat returns the same id with `already_known: true`.
    - AC4: an agent that can't see the account gets 404.
  - Adding signals, ACC-E4-S3:
    - AC1: the call returns a signal id; a repeat returns the existing id.
    - AC2: no `occurred_at` gives 400 with `Add the date it happened.`; no `url` gives 201 with `warning: 'A source link is strongly recommended.'`
  - ACC-E3-S1-AC2: facts with history.
  - ACC-E5-S1-AC3: `merged_into`.
  - Hidden fields: without `people:read`, all four contact fields are missing.
  - Ruling 9:
    - A key's `PATCH` creates an arrival with `facts` and leaves the fact unpinned.
    - A person's `PATCH` pins the fact.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): /v1 accounts, people, signals and facts`.

### Task 20: People-only and settings endpoints for the front end

**Files:**
- Create:
  - Routes under `src/app/v1/` for the endpoints listed below.
  - `src/modules/intake/services/settings.ts`: `listRelationshipDefaults` and `setRelationshipDefault`. Platform admins only in R1 (SRC-E5); otherwise `Only a platform admin can change these in this release.`
- Test: `tests/integration/v1/people-only.test.ts`

**Interfaces:**
- Every route uses `peopleOnly: true` where the spec says people only, and the cookie session path with `assertSameSite`. The front end calls these.
- Endpoints (paths after `/v1`):

  | Method and path | Permission | Does |
  |---|---|---|
  | `PATCH /sources/{id}` | `sources:manage` | Pause, resume, archive, cap, starting status |
  | `GET /sources/{id}/mappings`, `DELETE /sources/{id}/mappings/{mappingId}` | `imports:run` | Saved mappings |
  | `GET /waiting?reason&cursor` | `arrivals:read` | The waiting list |
  | `POST /arrivals/{id}:supply-website` | `imports:run` | Body: `{ website }` |
  | `POST /arrivals/{id}:supply-company` | `imports:run` | |
  | `POST /arrivals/{id}:choose` | `imports:run` | Body: `{ same_as }` or `{ new_company: true }`. The operator's story (SRC-E3-S3), so the operator's permission |
  | `POST /batches/{id}:skip-waiting` | `imports:run` | |
  | `POST /accounts/{id}:merge` | `accounts:write` | Body: `{ merged_id }` |
  | `PUT /accounts/{id}/practices` | `accounts:write` | |
  | `POST /accounts/{id}:pin-primary` | `accounts:write` | |
  | `POST /signals/{id}:archive` | `accounts:write` | |
  | `POST /accounts/{id}:override-exclusion`, `DELETE /accounts/{id}/exclusion-override` | `accounts:write` | |
  | `POST /accounts/{id}:convert-shell` | `accounts:write` | |
  | `GET /settings/exclusions` | `settings:manage` | |
  | `PUT /settings/exclusions/rules/{key}`, `PUT /settings/exclusions/lists/{kind}` | `settings:manage` | |
  | `GET /settings/warm-intros`, `PUT /settings/warm-intros/{key}` | `platformAdminOnly` | |

- [ ] **Step 1: Write failing tests.** For each endpoint, one success case as a signed-in member (cookie plus same-site headers) and one refusal:
  - Merge with an API key gets 403 with `Only a person can merge accounts.`
  - `:choose` without `imports:run` gets 403; an operator succeeds.
  - `PUT /settings/warm-intros/{key}` as an owner who isn't a platform admin gets 403.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: people-only and settings endpoints for accounts and intake`.

### Task 21: Seed data, one-path test and R1a exit

**Files:**
- Modify:
  - `src/entry/seed.ts`
  - `src/entry/cli.ts`: adds `scout import <tenant-slug> <file>`.
  - `README.md` and `docs/CHANGELOG.md`.
  - Spec docs: `docs/spec/migration-and-rollout/release-plan.md` (R1a progress), `docs/spec/architecture/event-catalog.md` (new events and jobs), `docs/spec/ai-tasks/task-catalog.md` (Ruling 12, and that these two task definitions live in the intake module, which owns them), `docs/spec/public-api/async-and-batches.md` (note that item-level `external_ref` and `notes` are accepted), `docs/spec/sources-and-intake/index.md` (the added `arrival` columns, `relationship_default`, `file_blob`) and `docs/spec/accounts/index.md` (`exclusion_list` and the added `account` columns).
- Create: `tests/fixtures/imports/research-a.csv`, built from the research test data in Task 16, and `tests/fixtures/imports/miami-dade-arrival.json`, the SRC-E2 example.
- Test: `tests/integration/intake/one-path.test.ts`, `tests/integration/entry/seed.test.ts`, `tests/integration/entry/cli.test.ts`

**Interfaces:**
- Seed data, for every seeded tenant:
  - Offers, account defaults and intake defaults.
  - One person source per seeded user.
  - An agent source, `Local development agent`, owned by the admin's person source.
  - The dev API key bound to that agent, with `arrivals:write`, `arrivals:read`, `accounts:read`, `accounts:write`, `people:write`, `signals:write`, `imports:run`, `offers:read` and `status:read`.
  - The expiry schedule.
- `scout import` runs `createImport` as the platform admin's person source, then prints the batch id and counts.

- [ ] **Step 1: Write failing tests.**
  - SRC-E3-S1-AC1, for the channels R1a has:
    - The same company arrives four times, from four sources: as a single `/v1` arrival, as a `/v1` batch item, as a CSV row, and as an inline targeted arrival.
    - The result is one account with four `source_ids`, the same people and the same current facts.
  - Seed: running it twice leaves one agent source and one dev key name.
  - CLI: `scout import taazaa tests/fixtures/imports/research-a.csv` exits 0.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run everything: `npm run typecheck && npm run lint && npm test && npm run e2e && npm run build`. Expected: PASS.
  - Then on the laptop:
    1. Run `npm run scout -- migrate`, then `npm run scout -- seed`.
    2. Start `all-background` and `dev`.
    3. `POST tests/fixtures/imports/miami-dade-arrival.json` to `/v1/arrivals` with the dev key.
    4. Poll the `status_url` until it reports `resolved` with an `account_id`.
  - Confirm the CI `images` job builds and its migrate step creates the `offers`, `accounts` and `intake` tables.
- [ ] **Step 5:** Commit `feat: R1a seed data, import command and exit check`.
