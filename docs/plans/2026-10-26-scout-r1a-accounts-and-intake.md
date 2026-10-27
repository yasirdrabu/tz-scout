# Taazaa Scout R1a Accounts and Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every account Scout learns about enters through one intake path (one arrival, a batch, or a CSV, Excel or Markdown file), is de-duplicated, and lands as an account with people, facts, signals, practices and its sources recorded, ready for scoring in R1b.

**Architecture:** Three new modules on the R0 platform: Offers and practices (`offers` schema), Accounts (`accounts` schema) and Sources and intake (`intake` schema). Intake stores each arrival exactly as received, then a `jobs.intake.resolve` job runs the resolve pipeline, which calls Accounts' public interface (`findMatches`, `upsertFromArrival`). Accounts calls Offers only to resolve practice hints. `/v1` routes sit above all three. Screens are out of scope (see Scope).

**Tech Stack:** As R0 (Node 22+, TypeScript strict, Next.js 15, Drizzle, Postgres 17, NATS JetStream, Zod 4, Vitest). New dependencies: `tldts` (registrable domain from the public suffix list), `exceljs` (reading `.xlsx`), `i18n-iso-countries` (country names to ISO 3166 alpha-2).

**Spec:** `docs/spec/accounts/` (ACC-E1, E3 facts only, E4, E5, E7, E8), `docs/spec/sources-and-intake/` (SRC-E1 registry and caps, E2, E3, E4, E5 basic), `docs/spec/offers-and-practices/` (OFF-E1, E2 manual offers, E3), `docs/spec/public-api/` (API-E1 idempotency and pagination, API-E2 arrivals and batches), `docs/spec/architecture/*`, `docs/spec/migration-and-rollout/release-plan.md` (R1). v1 reference code is at commit `c3c2124` (`git show c3c2124:<path>`).

## Scope

In: the three modules above, their events, their `/v1` endpoints, tenant defaults, seed data, and `dataFilter` with the TEN-E3-S1-AC2 suite (deferred from R0).

Out (later R1 plans): scoring, signal rules (OFF-E4) and review (R1b); CRM, HubSpot qualified leads (SRC-E6), `crm_status` consumers and a registered `MergeGuard` (R1c); MCP tools, Apollo and Vibe pulls, INT usage caps, v1 data migration (R1d); conflicts (ACC-E3-S3, S4, R2); custom fields (ACC-E6, R2); trust scores (SRC-E1-S3, R3). **Screens** (Sources, Batches, Import, Waiting for you, Accounts list, arrival page, offer editor) wait for the Claude Design work and get their own plan; every action they need exists here as a service and a `/v1` endpoint.

## Rulings (decisions this plan makes where the spec leaves a gap)

1. **Daily arrival cap is counted inside intake** (`arrival` rows per source since the start of the tenant's day, in the tenant's timezone), not through INT `checkCap`, because INT-E4 usage caps are not built yet. R1d moves it behind `checkCap`. Cost if wrong: one function swap.
2. **Trust is a constant 0.60 per source** until R3. `getTrust` still applies the effective-trust formula (0.4 person, 0.3 agent, 0.3 vendor, re-weighted over present levels), so callers don't change later.
3. **`initialReviewStatusKey` is not validated** against Review's list in R1a (Review lands in R1b). Defaults by kind as in SRC-E1.
4. **Files are stored in Postgres** (`intake.file_blob`, `bytea`, keyed by `storage_key`), so backups cover them. Cost if wrong: move blobs to object storage later; `storage_key` stays.
5. **Name similarity is computed in TypeScript** (a `pg_trgm`-compatible trigram similarity) over candidates pre-filtered in SQL by same `hq_state` or `hq_city`, so no Postgres extension is needed.
6. **`ModuleContext` gains `access`** (`{ userId?, sourceId?, dataLimit }`), set by `v1Route` and the page context. Background work has no `access` and sees everything in its tenant. The `DataLimit` type moves to `src/platform/access.ts` (platform may not import modules); tenancy re-exports it.
7. **Batch items that fail validation are stored and rejected `invalid`** (D13: stored as received). Only an invalid batch envelope (missing `name`, 0 or more than 1,000 items, over 10 MB) is a `400` with nothing stored.
8. **The 30-day waiting expiry is a per-tenant schedule** (`intake.waiting.expire`, daily 04:00 UTC), created by intake's `tenancy.tenant.created` consumer and by seed for existing tenants, so no cross-tenant scan is needed.

## Global Constraints

- Everything in R0's Global Constraints still holds (RLS on every tenant table with the `tenant_isolation` policy, module imports only through `index.ts` or `contracts/*`, ULID ids with prefixes, event types `<schema>.<entity>.<verb>`, problem+json errors, snake_case JSON, no em dashes in copy).
- New id prefixes: `src_`, `arr_`, `bat_`, `imp_`, `map_`, `wi_` (intake); `acc_`, `per_`, `fct_`, `sig_` (accounts); `prc_`, `off_`, `cs_` (offers). Add each to `src/platform/ids.ts`.
- Money in integer cents; rates and trust as decimals; scores integers 0 to 100.
- Arrivals are never modified after storage; `payload.raw` is byte-for-byte what was sent (parsed JSON, same values).
- Limits: arrival payload 256 KB; max 25 people, 50 signals, 200 facts per arrival; batch 1 to 1,000 items and 10 MB; batch files 25 MB each, 10 per batch; import files 20 MB and 10,000 rows; pagination limit 1 to 200, default 50.
- Default daily arrival cap 500 per source (0 to 10,000). Every source starts at trust 0.60.
- Warm-intro relationship default points: `customer_referral` 15, `partner_referral` 10, `board_or_investor` 12, `employee_network` 8, `event_meeting` 5, `other` 3; clamp 0 to 20; unconfirmed counts half; highest of several counts.
- `Idempotency-Key` up to 255 characters, 24 hours, same principal and body returns the stored response with `Idempotent-Replayed: true`; a different body returns `409` `idempotency-mismatch`.
- Each new schema (`offers`, `accounts`, `intake`) is added to `bootstrap.sql` (create, usage and grants, default privileges), `MODULE_ORDER` in `src/platform/db/migrate.ts` (order: `platform, tenancy, integrations, ai, offers, accounts, intake`), the RLS catalog test, and `src/entry/registry.ts`.

## Review Focus

1. **Two arrivals for the same company resolve at the same moment** (two batches from different agents). Expected: one account, both arrivals `attached` or one `created` and one `attached`. Test in Task 13.
2. **A messy CSV**: UTF-8 BOM, semicolon delimiter, quoted cells with line breaks, blank rows, duplicate header names, trailing empty columns. Expected: correct rows, duplicate headers suffixed (`Email`, `Email (2)`), blank rows skipped. Test in Task 15.
3. **Odd website values**: `HTTP://WWW.Example.CO.UK/about?x=1`, `example.com.` (trailing dot), `example.com:8080`, `mailto:a@b.com`, `192.168.0.1`, `not a url`, `gmail.com`. Expected: `example.co.uk`, `example.com`, `example.com`, `null`, `null`, `null`, `null` (free email domain). Test in Task 11.
4. **The cap at the tenant's midnight**, including a daylight-saving change in `America/New_York`. Expected: the count resets at local midnight and `Retry-After` points there. Test in Task 10.
5. **A batch of mixed valid and invalid items.** Expected: `202`, one `arr_` id per item in order, invalid items `rejected` / `invalid` with their paths in `detail`, the rest resolve; the batch completes. Test in Task 12.

---

## File Structure

```
src/platform/access.ts                    DataLimit type and Access (moved from tenancy)
src/platform/idempotency.ts               Idempotency-Key store for POST routes
src/modules/offers/
  index.ts contracts/events.ts db/schema.ts db/migrations/
  services/practices.ts services/offers.ts services/case-studies.ts
  defaults.ts                             Taazaa practices, offers and case studies (seed)
src/modules/accounts/
  index.ts contracts/events.ts contracts/source-info.ts contracts/merge-guard.ts contracts/types.ts
  db/schema.ts db/migrations/
  domain/names.ts domain/seniority.ts domain/primary.ts domain/current-value.ts
  domain/signals.ts domain/exclusions.ts domain/similarity.ts
  services/upsert.ts services/match.ts services/read.ts services/edit.ts
  services/merge.ts services/summary.ts services/search.ts services/visibility.ts
  consumers.ts defaults.ts
src/modules/intake/
  index.ts contracts/arrival.ts contracts/events.ts contracts/jobs.ts db/schema.ts db/migrations/
  domain/normalise.ts domain/free-email.ts domain/industry.ts domain/warm-intro.ts domain/day.ts
  services/sources.ts services/submit.ts services/resolve.ts services/waiting.ts
  services/status.ts services/warm-intros.ts services/files.ts services/imports.ts
  import/parse.ts import/layouts/research.ts import/layouts/vibe.ts import/synonyms.ts
  import/rows-to-arrivals.ts import/mapping-task.ts normalise-task.ts
  consumers.ts jobs.ts defaults.ts
src/app/v1/sources/ arrivals/ batches/ imports/ accounts/ people/ practices/ offers/ case-studies/
tests/unit/{offers,accounts,intake}/   tests/integration/{offers,accounts,intake,v1}/
tests/fixtures/imports/                   v1 fixtures copied from c3c2124 tests
```

The intake module's folder is `intake`, the same as its schema name, so `migrationsFolder` needs no special case (unlike `ai-tasks`, whose schema is `ai`). The other two follow the same rule: folders `offers` and `accounts`.

---

### Task 1: Access in the context, idempotency and pagination for /v1

**Files:**
- Create: `src/platform/access.ts`, `src/platform/idempotency.ts`, `src/app/v1/_lib/pagination.ts`
- Modify: `src/platform/context.ts`, `src/modules/tenancy/domain/data-limit.ts` (import and re-export the type), `src/app/v1/_lib/v1-route.ts`, `src/server/page-context.ts`, `src/platform/errors.ts` (add slugs `validation`, `not-found`, `idempotency-mismatch`, `cap-reached` if missing)
- Test: `tests/unit/platform/pagination.test.ts`, `tests/integration/v1/idempotency.test.ts`

**Interfaces:**
- Produces:
  - `type Access = { userId?: string; sourceId?: string; dataLimit: DataLimit }`; `ModuleContext.access?: Access`.
  - `v1Route(opts: { permission?: Permission; idempotent?: boolean }, handler)`. With `idempotent: true` on a `POST`, the wrapper reads `Idempotency-Key`, and within the handler's transaction stores `(tenant_id, key)` with `request_hash = sha256(principal.id + body)`, status and body. Replays return the stored response with header `Idempotent-Replayed: true`. Keys older than 24 hours are ignored and overwritten.
  - `encodeCursor(values: (string | number)[]): string`, `decodeCursor(c: string): (string | number)[]` (base64url JSON; a bad cursor is a `400` `validation` with path `cursor`), `pageLimit(url: URL): number` (default 50, 1 to 200), and `page<T>(rows: T[], limit: number, cursorOf: (t: T) => (string | number)[]): { data: T[]; nextCursor: string | null }` (callers fetch `limit + 1` rows).
  - Error: `ScoutError({ slug: 'idempotency-mismatch', status: 409, title: 'That Idempotency-Key was already used with a different request body.' })`.

- [ ] **Step 1: Write failing tests.** Unit: `pageLimit` gives 50 with no param and 200 for `?limit=200`; `?limit=999` and `?limit=0` are a `400` (`Limit must be between 1 and 200.`); `page` with 51 rows and limit 50 returns 50 rows and a cursor that decodes to the 50th row's values. Integration (route built in the test with `v1Route({ idempotent: true }, …)` writing one outbox row per call): two POSTs with the same key and body create one outbox row and the second has `Idempotent-Replayed: true` and the same body; same key with a different body returns 409 `idempotency-mismatch`; the same key from a different API key in another tenant is independent; a request handler sees `ctx.access.sourceId` equal to the key's source.
- [ ] **Step 2:** Run `npm run test:unit -- pagination` and `npm run test:int -- idempotency`. Expected: FAIL.
- [ ] **Step 3:** Implement. `page-context.ts` sets `access` from the signed-in membership (`userId`, `dataLimit`).
- [ ] **Step 4:** Run the two tests plus `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(platform): access in context, idempotency keys and cursor pages for /v1`.

### Task 2: Offers module: practices, offers and case studies

**Files:**
- Create: `src/modules/offers/{index.ts,contracts/events.ts,db/schema.ts,db/migrations/*,services/practices.ts,services/offers.ts,services/case-studies.ts}`
- Modify: `src/platform/db/bootstrap.sql`, `src/platform/db/migrate.ts`, `src/entry/registry.ts`, `tests/integration/platform/rls-catalog.test.ts`
- Test: `tests/integration/offers/practices.test.ts`, `tests/integration/offers/offers.test.ts`, `tests/integration/offers/case-studies.test.ts`

**Interfaces:**
- Tables: `practice`, `offer`, `case_study`, `offer_case_study` with the fields in `offers-and-practices/index.md` (skip `signal_rule`, `readiness*`, `segment*`, `won_deal`, `win_analysis`; they belong to later releases). `practice.slug` and `offer.slug` unique per tenant.
- Events (data as in the OFF index): `offers.offer.approved`, `offers.offer.changed` (`affectsMatching` true when buyer-definition fields or status changed), `offers.offer.archived`, `offers.practice.changed`.
- Produces:
  - `createPractice(ctx, { slug, name, description?, keywords? })`, `updatePractice(ctx, id, patch)`, `archivePractice(ctx, id)`, `listPractices(ctx, { includeArchived? })`.
  - `resolvePractice(ctx, hint: string | null | undefined): Promise<string | null>`: matches, in order, a practice id, slug, name (case-insensitive), then any keyword contained in the hint (case-insensitive); archived practices never match.
  - `createOffer(ctx, input: OfferInput)`, `updateOffer(ctx, id, patch)`, `approveOffer(ctx, id)`, `archiveOffer(ctx, id)`, `getOffer(ctx, id)`, `listOffers(ctx, { practiceId?, status? })`, and `BUYER_DEFINITION_FIELDS` (`industries`, `companySizeMin`, `companySizeMax`, `revenueMinCents`, `revenueMaxCents`, `regions`, `targetTitles`, `targetBuyingRoles`, `excludedDomains`, `excludedCategories`).
  - `createCaseStudy(ctx, input)`, `updateCaseStudy`, `archiveCaseStudy`, `linkCaseStudy(ctx, offerId, caseStudyId)`, `unlinkCaseStudy`, `listCaseStudies(ctx, { buyerVisibleOnly? })`, `matchCaseStudies(ctx, offerId, industry: string | null, limit: number, opts?: { buyerVisibleOnly?: boolean })`.
  - Copy: `Add a promise before approving.`, `Add at least one target title or buying role before approving.`, `Add industries or a company size range before approving.`, `Add a typical deal size before approving.`, `Add the sales cycle in days before approving.`, `Only an owner can approve an offer.`, `Move or archive these offers first: <names>.` (archive practice with approved offers).

- [ ] **Step 1: Write failing tests.** OFF-E1-S1-AC1 (duplicate slug throws `That short name is taken.`), OFF-E1-S1-AC2 (archive blocked, message names the offer), OFF-E1-S2-AC1 (`resolvePractice` with `prc_…`, `ai-operating-platforms`, `AI Operating Platforms`, `Yasir AI Operating Platform agent` all give the same id; `null` and `unknown` give null). OFF-E2-S1-AC1 (save needs name, practice, promise), AC2 (each approve requirement throws its copy line), AC3 (archive publishes `offers.offer.archived`; `listOffers({ status: 'approved' })` omits it). OFF-E2-S2-AC1 (a leader with `offers:manage` added as an extra permission gets `Only an owner can approve an offer.`), AC2 (approve publishes `offers.offer.approved`). Editing `industries` on an approved offer sets status `draft` and publishes `offers.offer.changed` with `affectsMatching: true`; editing `promise` keeps `approved` with `affectsMatching: false`. OFF-E3-S1-AC2 (link two offers to one case study; each lists it). OFF-E3-S2-AC1 (`matchCaseStudies(offer, 'Logistics', 2)` puts the logistics case study first, then the most recent; `buyerVisibleOnly` drops non-public ones). An RLS test: a practice created in tenant A is not visible in tenant B.
- [ ] **Step 2:** Run `npm run test:int -- offers`. Expected: FAIL.
- [ ] **Step 3:** Implement. The owner check reads the membership role through the tenancy public interface (`ctx.access.userId` → role); API keys can't approve.
- [ ] **Step 4:** Run `npm run test:int -- offers` and `npm run test:int -- rls`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(offers): practices, offers and case studies`.

### Task 3: Offers on /v1 and Taazaa's catalogue as seed data

**Files:**
- Create: `src/modules/offers/defaults.ts`, `src/app/v1/practices/route.ts`, `src/app/v1/offers/route.ts`, `src/app/v1/offers/[id]/route.ts`, `src/app/v1/case-studies/route.ts`
- Modify: `src/entry/seed.ts`
- Test: `tests/integration/v1/offers.test.ts`, `tests/unit/seed.test.ts`

**Interfaces:**
- `TAAZAA_PRACTICES`: the four practices from `c3c2124:src/lib/buckets.ts` (`DEFAULT_BUCKETS`: slug, name, description, keywords). `TAAZAA_OFFERS`: every offer in `c3c2124:prisma/seed.ts` with the same slugs, names, promises, prices, margins, cycle days, titles, industries and proof points, filed under its bucket's practice, plus the two `DRAFT_OFFERS` from `buckets.ts`; status `approved` where v1 says `APPROVED`, else `draft`. `TAAZAA_CASE_STUDIES`: the case studies named in that seed's `cases` lists, linked the same way, `public` false.
- Routes as in the OFF index: `GET /v1/practices` (`offers:read`), `GET /v1/offers?practice_id&status` (`offers:read`; approved only unless the principal has `offers:manage`), `GET /v1/offers/{id}` (with case studies), `POST /v1/offers` and `PATCH /v1/offers/{id}` (`offers:manage`, idempotent POST), `POST /v1/offers/{id}:approve` and `:archive` (the `[id]` segment carries `off_…:approve`; the route splits on `:`), `GET /v1/case-studies` (agents see only `public` ones).
- `seedOffers(ctx)` is idempotent (upsert by slug).

- [ ] **Step 1: Write failing tests.** `GET /v1/offers` with a read-only key returns only approved offers, snake_case (`price_min_cents`, `target_titles`); with an `offers:manage` key a draft appears. `POST /v1/offers/{id}:approve` with an API key returns 403 with `Only an owner can approve an offer.` `GET /v1/case-studies` with an agent key omits non-public. Seed unit test: running `seedOffers` twice leaves 4 practices and the same offer count, and `Modernization Blueprint` is approved under `ai-operating-platforms`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run test:int -- v1/offers` and `npm run test:unit -- seed`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(offers): /v1 offers and practices, Taazaa catalogue seed`.

### Task 4: Accounts schema, contracts and tenant defaults

**Files:**
- Create: `src/modules/accounts/{index.ts,contracts/events.ts,contracts/types.ts,contracts/source-info.ts,contracts/merge-guard.ts,db/schema.ts,db/migrations/*,defaults.ts,consumers.ts}`
- Modify: `bootstrap.sql`, `migrate.ts`, `registry.ts`, `src/entry/worker.ts`, RLS catalog test
- Test: `tests/integration/accounts/defaults.test.ts`

**Interfaces:**
- Tables from the ACC index: `account`, `account_alias`, `person`, `person_role`, `person_alias`, `fact`, `signal`, `buying_role`, `exclusion_rule`, `account_summary`; plus `exclusion_list` (`tenant_id`, `kind` `vendor_keyword` | `parent_domain` | `do_not_contact_domain`, `value`). Skip `conflict` and `custom_field` (R2). Partial unique index `account (tenant_id, domain) where archived_at is null and domain is not null`; unique `person (account_id, lower(email)) where archived_at is null and email is not null`; index `account_alias (tenant_id, kind, value)`.
- Events: every event in the ACC index except the two conflict events, with the `data` fields listed there.
- `contracts/types.ts`: `AccountView` (current values, `people: PersonView[]` with `roleKeys`, `aliases`, `excluded: { reasonKey, label } | null`, `excludedOverride`, `mergedInto?`), `PersonView`, `SignalView`, `FactView`, `SourceChain = { personSourceId?: string; agentSourceId?: string; vendorSourceId?: string }`, and `ArrivalForAccounts` (the normalised arrival intake hands to `upsertFromArrival`: account fields, people, signals, facts list with `observedAt`/`url`/`note`, research, `practiceHint`, `soleProprietor`, `arrivalId`, `sourceChain`, `externalIds: { system, id }[]`).
- `SourceInfoProvider { getTrust(ctx, sourceIds: string[]): Promise<Record<string, number>>; sourcesForAccount(ctx, accountId): Promise<string[]> }` with `registerSourceInfoProvider` / `sourceInfoProvider()`; default when none is registered: every source 0.60, no sources.
- `MergeGuard { check(ctx, survivorId, mergedId): Promise<{ allowed: boolean; reason?: string }> }` with `registerMergeGuard`; default allows.
- Consumer `accounts.tenant_defaults` on `tenancy.tenant.created`: inserts default buying roles (`business_owner` Business owner, `commercial_buyer` Commercial buyer, `technical_buyer` Technical buyer, `influencer` Influencer, `champion` Champion, `blocker` Blocker, `user` Day-to-day user) and the five exclusion rules from ACC-E7 (enabled), and the v1 vendor keyword list from `c3c2124:src/integrations/prospects/vibe.ts` (`exclusionFor`'s software vendor words). Idempotent. `seedAccountDefaults(ctx)` does the same for seed.

- [ ] **Step 1: Write failing tests.** Publishing `tenancy.tenant.created` and running the consumer creates 7 buying roles and 5 exclusion rules; running it again changes nothing. RLS: an account inserted in tenant A is invisible in tenant B. With no provider registered, `sourceInfoProvider().getTrust(ctx, ['src_a'])` returns `{ src_a: 0.6 }`.
- [ ] **Step 2:** Run `npm run test:int -- accounts/defaults`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it and the RLS catalog test. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): schema, contracts and tenant defaults`.

### Task 5: Accounts domain rules (pure)

**Files:**
- Create: `src/modules/accounts/domain/{names.ts,seniority.ts,primary.ts,current-value.ts,signals.ts,exclusions.ts,similarity.ts}`
- Test: `tests/unit/accounts/*.test.ts`

**Interfaces:**
- `splitName(full: string): { firstName: string; lastName: string | null }`; `matchName(name: string): string` (lowercase, punctuation removed, legal suffixes `inc`, `llc`, `ltd`, `corp`, `co`, `gmbh` dropped at the end).
- `seniorityFromTitle(title: string | null): 'owner' | 'founder' | 'chief' | 'president' | 'vp' | 'head' | 'director' | 'manager' | 'other'` (port the rule from `c3c2124:src/integrations/prospects/vibeExport.ts` `seniority`).
- `pickPrimary(people: { id; title; seniority; emailStatus; pinnedPrimary: boolean }[], targetTitles: string[]): string | null`.
- `pickCurrent(facts: FactLike[], trust: Record<string, number>): { currentId: string | null; supersededIds: string[] }` per ACC-E3 (pinned, then higher effective trust of the fact's chain, then newer `observedAt`; same chain newer supersedes older); `unionList(facts)` for `technologies` and `keywords`; free-text keys (`description` and research text keys) take the newest.
- `SIGNAL_TYPES` (the nine types with label, kind and the explainer text from `c3c2124:src/lib/matching.ts` `SIGNAL_EXPLAINER`), `kindFor(type)`, `fineTypeFromTitle(kind, title): string | null` (keyword rules in ACC-E4, only when the type's kind equals `kind`), `signalDedupKeys(s): string[]` (the three duplicate keys).
- `evaluateExclusions(input: { industryKey; keywords; description; name; parentDomain; domain; crmStatus }, rules, lists): { key: string; label: string } | null` (first enabled rule that matches, in the ACC-E7 table order).
- `trigramSimilarity(a: string, b: string): number` (pg_trgm algorithm: lowercase, words padded with two leading spaces and one trailing, set of 3-grams, |A∩B| / |A∪B|).

- [ ] **Step 1: Write failing tests.** ACC-E1-S3-AC2 (target title beats seniority; seniority beats verified email; pinned wins). ACC-E3-S2-AC1 (pinned beats trust; trust 0.7 beats 0.6 even if older; same chain newer supersedes and returns the older in `supersededIds`; list union; free text newest). ACC-E4-S1-AC2 (`fineTypeFromTitle('trigger', 'Acme raised a Series B')` is `funding`; `fineTypeFromTitle('pain', 'Acme raised a Series B')` is null; `'Jane named CIO'` gives `leadership`). ACC-E4-S1-AC1 (the three duplicate keys: same source and external id; same url and date; same kind, normalised title and date). ACC-E7-S1-AC1 using the five software vendors and three units of larger parents from `c3c2124:tests/unit/vibe.test.ts` (copy the fixtures). `matchName('Keystone Ridge Properties LLC') === matchName('Keystone Ridge Properties')`. `trigramSimilarity('Miami-Dade County DTPW', 'Miami Dade County')` is at least 0.6 and `trigramSimilarity('abc', 'xyz')` is 0. Port v1's `vibe.test.ts` seniority cases.
- [ ] **Step 2:** Run `npm run test:unit -- accounts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): domain rules for names, people, current values, signals and exclusions`.

### Task 6: upsertFromArrival

**Files:**
- Create: `src/modules/accounts/services/upsert.ts`
- Modify: `src/modules/accounts/index.ts`
- Test: `tests/integration/accounts/upsert.test.ts`

**Interfaces:**
- Consumes: Task 5 domain; `resolvePractice` (offers); `sourceInfoProvider().getTrust`.
- Produces: `upsertFromArrival(ctx, arrival: ArrivalForAccounts, accountId?: string): Promise<{ accountId: string; created: boolean; personIds: string[]; factIds: string[]; signalIds: string[]; existingPersonIds: string[]; existingSignalIds: string[]; excluded: { key; label } | null }>`.
  - Creates the account (or loads it), writes one fact per supplied account field with the arrival's chain and `observedAt` (default now), re-picks current values and writes the projection, adds domain and name aliases and `external_id` aliases, matches people (email, then LinkedIn URL, then same first and last name at the account; a research-sheet email with no name match is attached to the person whose name matches the email's local part), adds person facts and roles (`origin: 'stated'` when sent), stores signals unless a duplicate key matches, projects `research_tier` and `research_tier_signal_at`, adds practices from `practiceHint` (additive), evaluates exclusions, and publishes the events in ACC-E1-S1-AC1.
  - Shell accounts (ACC-E1-S2): `soleProprietor` with a person and no company name → account `"<First Last>"`, `is_shell = true`, domain from the person's website if any, roles `business_owner` and `commercial_buyer`. The next arrival with that email finds it because `findMatches` checks the emails of people on shell accounts (Task 7).
- Concurrency: callers hold the domain lock (Task 13); `upsertFromArrival` itself does no locking.

- [ ] **Step 1: Write failing tests.** ACC-E1-S1-AC1 (new domain → account, 2 people, 3 facts, 1 signal in one transaction; outbox has `accounts.account.created` and one `person.added`, `fact.recorded`, `signal.recorded` per item). AC2 (second call with the account id and the same person email → `existingPersonIds` has it, no new person; the same signal → `existingSignalIds`, no new signal). AC3 (every row has the arrival id and chain). ACC-E1-S2-AC1 and AC2. A `practiceHint` of `ai-operating-platforms` adds that practice; a second arrival with no hint keeps it. `researcher_tier: 'A'` with a signal dated `2026-06-02` sets `research_tier = 'A'` and `research_tier_signal_at = 2026-06-02`. A software vendor arrival returns `excluded.key = 'software_vendor'` and sets `excluded_reason_key`. Two facts for `employees` from chains with trust 0.6 and (stubbed provider) 0.8 → the 0.8 value is current.
- [ ] **Step 2:** Run `npm run test:int -- accounts/upsert`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): create and update accounts from arrivals`.

### Task 7: findMatches

**Files:**
- Create: `src/modules/accounts/services/match.ts`
- Test: `tests/integration/accounts/match.test.ts`

**Interfaces:**
- `findMatches(ctx, candidate: { domain?: string | null; linkedinUrl?: string | null; externalIds?: { system; id }[]; name?: string | null; country?: string | null; state?: string | null; city?: string | null; shellEmail?: string | null }): Promise<{ accountId: string; confidence: 'certain' | 'likely' | 'possible'; reason: string }[]>`, at most 5, in the SRC-E3 table order. `possible` needs similarity at least 0.85 and the same state or city. Merged ids resolve to the survivor (Task 9 adds the alias; the lookup here follows `merged_id` aliases already).
- Reasons (plain words, shown to people): `Same website`, `Website is also known for this account`, `Same LinkedIn page`, `Same id in <system>`, `Same name and country, no website on file`, `Similar name in the same state or city`, `Same email (one-person business)`.

- [ ] **Step 1: Write failing tests.** SRC-E3-S2-AC1 at this level (`miamidade.gov` matches the account with domain `miamidade.gov`, certain). Alias domain matches certain. LinkedIn match. `(apollo, 123)` external id match. SRC-E3-S2-AC3 (`Keystone Ridge Properties LLC`, US, no domain → likely; with candidate domain `keystone.com` and account domain `other.com` → no `likely` row). `Miami Dade County DTPW`, FL vs account `Miami-Dade County DTPW`, FL, different domains absent → possible. Same similar name in another state → nothing. Shell email match. Archived accounts never match.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): find matching accounts for an arrival`.

### Task 8: Account reads, edits, practices and exclusion overrides

**Files:**
- Create: `src/modules/accounts/services/read.ts`, `src/modules/accounts/services/edit.ts`
- Test: `tests/integration/accounts/read-edit.test.ts`

**Interfaces:**
- `getAccount(ctx, id): Promise<AccountView | null>` (asked for a merged id, it returns the survivor with `mergedInto` set to the survivor's id), `getAccounts(ctx, ids)`, `getSignals(ctx, accountId, since?: Date)`, `getFacts(ctx, accountId, { key?, includeHistory? })`, `getAccountForScoring(ctx, accountId)` (exactly the fields in the ACC index row), `checkExclusion(ctx, accountId)`.
- `setPractices(ctx, accountId, practiceIds: string[], actor: 'hint' | 'person')`: a hint only adds; a person may remove; publishes `accounts.account.updated` with `changedKeys: ['practice_ids']` when it changed.
- `editAccount(ctx, accountId, patch)` and `editPerson(ctx, personId, patch)` (needs `ctx.access.userId`): each changed field becomes a fact pinned by the editor, `observedAt` now, with `ctx.access.sourceId` as the person level of the chain. The page context sets `access.sourceId` to the signed-in user's person source (intake's `personSourceFor`, Task 12), so Accounts never calls intake. Publishes `accounts.account.updated` / `accounts.person.updated`. Role edits set `origin: 'set_by_person'`.
- `pinPrimary(ctx, personId | null, accountId)`, `archiveSignal(ctx, signalId, reason)`, `overrideExclusion(ctx, accountId, note)` / `removeExclusionOverride(ctx, accountId)` (note required: `Add a note saying why.`; audited; publishes `accounts.account.exclusion_changed`), `convertShell(ctx, accountId, { name, domain })` (ACC-E1-S2-AC3, history kept as facts).
- Exclusion settings for owners (ACC-E7-S2-AC2, `settings:manage`): `listExclusionRules(ctx)`, `setExclusionRule(ctx, key, enabled)`, `setExclusionList(ctx, kind, values: string[])`. Each change re-checks every account's exclusion and publishes `accounts.account.exclusion_changed` for each account whose result changed.
- Consumer `accounts.primary_on_person_change` is not needed in R1a: `upsertFromArrival` and `editPerson` re-pick the primary inline using the account's best offer titles once R1b supplies them; until then target titles are empty. Note this in the code where the titles are read.

- [ ] **Step 1: Write failing tests.** `getAccountForScoring` returns practice ids, facts with chains, people with role keys and seniority, non-archived signals only, research tier and exclusion flags. A person removes a practice; a hint cannot. `editAccount` for `employees` pins the fact; a later arrival with a different value from a higher-trust source does not change the current value. ACC-E7-S2-AC1 (override without note throws; with note writes an audit row and publishes `exclusion_changed` with `override: true`). `archiveSignal` hides it from `getAccountForScoring`. `convertShell` sets `is_shell = false` and keeps the old name as an alias. Turning `software_vendor` off clears that exclusion on a vendor account and publishes `exclusion_changed`; adding its domain to `do_not_contact_domain` sets `domain_listed`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): reads, pinned edits, practices and exclusion overrides`.

### Task 9: Merges and aliases

**Files:**
- Create: `src/modules/accounts/services/merge.ts`
- Test: `tests/integration/accounts/merge.test.ts`

**Interfaces:**
- `mergeAccounts(ctx, survivorId, mergedId): Promise<void>`: people only (`ctx.access.userId` required and `accounts:write`; API keys get `403` `Only a person can merge accounts.`); calls `mergeGuard().check` and throws its `reason` as a `409` `conflict`; moves people (de-duplicated by email, LinkedIn, name; duplicate people become `person_alias` `merged_id`), facts, signals (dedup keys apply), aliases, practices (union) to the survivor; adds the merged account's domain and name and id as aliases; re-picks current values; archives the merged account with reason `merged`; publishes `accounts.account.merged` and `accounts.account.archived`; audited.
- `resolveAccountId(ctx, id): Promise<{ id: string; mergedInto?: string } | null>` used by reads.

- [ ] **Step 1: Write failing tests.** ACC-E5-S1-AC2 at this level (after merging, `findMatches({ domain: merged's domain })` returns the survivor, certain). AC3 (`getAccount(mergedId)` returns the survivor with `mergedInto`). Two people with the same email end as one. A registered guard returning `{ allowed: false, reason: 'These are different companies in HubSpot. Merge them there first.' }` makes the merge throw that copy and change nothing. An API-key context gets the 403 copy.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): merge accounts and follow merged ids`.

### Task 10: Account summary, visibility (dataFilter) and search

**Files:**
- Create: `src/modules/accounts/services/summary.ts`, `src/modules/accounts/services/visibility.ts`, `src/modules/accounts/services/search.ts`
- Modify: `src/modules/accounts/consumers.ts`, `src/entry/worker.ts`
- Test: `tests/integration/accounts/search.test.ts`, `tests/integration/accounts/visibility.test.ts`

**Interfaces:**
- `account_summary` is written inline by `upsertFromArrival`, edits and merges (name fields, `last_signal_at`, `practice_id` empty until R1b) and by consumer `accounts.summary_sources` on `intake.arrival.resolved` (adds the chain's source ids to `source_ids`, ordered by `accountId`). R1b and R1c add their own consumers for scores, status, owner and stage.
- `visibleAccounts(ctx): SQL` (a Drizzle condition on `account_summary`): no `ctx.access` or `all` → true; `own_source` → `source_ids` overlaps `[ctx.access.sourceId, ...ctx.access.childSourceIds]` (this task adds `childSourceIds?: string[]` to `Access`; `v1Route` fills it through intake's `childSources` in Task 18, and tests set it directly); `sources {ids}` → overlap; `practices {ids}` → `practice_ids` overlap or `practice_id` in ids; `own_accounts` → `owner_user_id = ctx.access.userId`; `any_of` → OR of the parts.
- `search(ctx, query: AccountQuery): Promise<{ data: AccountSummaryView[]; nextCursor: string | null }>` with every ACC-E8 filter that has data in R1a (text over name, domain and aliases; industry; employees range; revenue range; HQ country and state; practice; source; has signal of kind since date; excluded or not) and sort `priority` (nulls last, then created), `last_signal`, `created`, `name`. Filters for best offer, tier, priority, review status, stage and owner are accepted and applied on their columns (empty until R1b and R1c).
- `getAccount`, `getSignals` and `getFacts` apply `visibleAccounts` when `ctx.access` is set and return null for hidden accounts.

- [ ] **Step 1: Write failing tests.** TEN-E3-S1-AC2 suite: an `own_source` agent key sees only accounts its source sent (search, `getAccount`); a `sources` limit sees the listed sources' accounts; a `practices` limit sees only accounts with that practice; `any_of(own_source, practices)` sees the union; an `own_accounts` seller sees none (no owners yet). ACC-E8-S2-AC2 is the first case. Filters: text `miami` finds by alias; `excluded: true` lists only ruled-out accounts; paging 120 accounts with limit 50 returns 50, 50, 20 with no repeats. Performance: 10,000 seeded summaries, search p95 under 500 ms over 20 runs (ACC-E8-S1-AC2); mark the test `slow` and run it in CI only.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement, with indexes on `account_summary (tenant_id, priority desc)`, GIN on `source_ids` and `practice_ids`, and a trigram-free `lower(name)` btree plus `account_alias (tenant_id, lower(value))`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): account summary, data limits and search`.

### Task 11: Intake schema, arrival contract and normalising rules

**Files:**
- Create: `src/modules/intake/{index.ts,contracts/arrival.ts,contracts/events.ts,contracts/jobs.ts,db/schema.ts,db/migrations/*}`, `src/modules/intake/domain/{normalise.ts,free-email.ts,industry.ts,warm-intro.ts,day.ts}`
- Modify: `bootstrap.sql`, `migrate.ts`, `registry.ts`, RLS catalog test, `package.json` (`tldts`, `i18n-iso-countries`)
- Test: `tests/unit/intake/arrival-contract.test.ts`, `tests/unit/intake/normalise.test.ts`, `tests/unit/intake/warm-intro.test.ts`, `tests/unit/intake/day.test.ts`

**Interfaces:**
- Tables from the SRC index except `source_trust_history`, `arrival_outcome` and `source_feedback` (R3 and R1b): `source`, `arrival`, `batch`, `batch_file`, `file_blob` (Ruling 4), `file_import`, `column_mapping`, `warm_intro`, `warm_intro_rule`, `relationship_default` (`tenant_id`, `key`, `label`, `points`). Unique `arrival (tenant_id, coalesce(agent_source_id, person_source_id, vendor_source_id), external_ref) where external_ref is not null`; index `arrival (tenant_id, status, waiting_on)`; index `arrival (tenant_id, batch_id)`.
- `ArrivalV1Schema` (Zod, `.strict()` on every object so unknown fields are rejected): exactly the `arrival.v1` shape and field rules in SRC-E2, with `strictIdentity: boolean` option (API and MCP: name plus one of domain, website, LinkedIn URL; files and forms: not required). Error messages: `Must be a domain like acme.com.`, `Add the company name.`, `Add a website, domain or LinkedIn page.`, `Add the date it happened.`, `At most 25 people.`, `At most 50 signals.`, `At most 200 facts.`. `BatchV1Schema` (`name`, `run_at?`, `notes?`, `criteria?`, `metadata?`, `items` 1 to 1,000 of unknown, validated one by one).
- Events: every event in the SRC index except `trust_changed`, `warm_intro.confirmed` and `feedback.recorded`. Jobs: `intake.resolve { arrivalId }` (timeout 30 s), `intake.import.run { importId }` (timeout 5 min), `intake.waiting.expire {}`.
- Domain: `normaliseDomain(input: string | null | undefined): string | null` (Review Focus 3), `domainFromEmail(email)` (null for free email domains; port the list from `c3c2124:src/lib/leadChecks.ts`), `isFreeEmailDomain(d)`, `countryCode(input): string | null` (`United States`, `USA`, `us` → `US`), `parseRange(s): { min: number | null; max: number | null }` (port `rangeMid`'s parser from v1 `vibe.ts`: `501-1000`, `10001+`, `75M-200M`, `[201-500]`), `industryKey(text): string | null` (synonym table: the industry words used by the v1 NAICS map and offers, lowercased keys like `logistics`, `healthcare_services`, `commercial_real_estate`), `relationshipKey(text): string` (SRC-E5 keyword rules, else `other`; AI fallback is applied in the pipeline, not here), `warmIntroPoints({ relationshipKey, introducerRule?, defaults, confirmed }): number`, `strongest(intros)`, `tenantDayStart(now: Date, timezone: string): Date` and `nextTenantDay(now, timezone): Date`.

- [ ] **Step 1: Write failing tests.** Contract: the SRC-E2 example parses; an extra field `account.colour` fails with path `account.colour`; strict identity rejects a name-only account with `Add a website, domain or LinkedIn page.`; a signal without `occurred_at` fails with `Add the date it happened.`; 26 people fail. Normalise: Review Focus 3 table exactly; `https://www.miamidade.gov/global/transportation/home.page` → `miamidade.gov`; `parseRange('[201-500]')` → `{ min: 201, max: 500 }`. Warm intro: SRC-E5-S2-AC2 (introducer rule beats default; unconfirmed halves (8 → 4); highest of several wins; 25 clamps to 20, -1 to 0); `relationshipKey('knows the CTC director from FPTA')` → `employee_network`; `'met at FPTA 2026'` → `event_meeting`. Day: Review Focus 4, around the 1 November 2026 change from EDT to EST: `tenantDayStart(2026-11-01T03:30:00Z, 'America/New_York')` is `2026-10-31T04:00:00Z` (03:30Z is 23:30 EDT on 31 October), and `nextTenantDay(2026-11-01T12:00:00Z, 'America/New_York')` is `2026-11-02T05:00:00Z`.
- [ ] **Step 2:** Run `npm run test:unit -- intake`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): schema, arrival contract and normalising rules`.

### Task 12: Sources, caps, submitArrival and submitBatch

**Files:**
- Create: `src/modules/intake/services/sources.ts`, `src/modules/intake/services/submit.ts`, `src/modules/intake/defaults.ts`, `src/modules/intake/consumers.ts`
- Modify: `src/modules/intake/index.ts`, `src/entry/worker.ts`, composition: `src/entry/registry.ts` registers `SourceValidator` (tenancy) and `SourceInfoProvider` (accounts) implementations
- Test: `tests/integration/intake/sources.test.ts`, `tests/integration/intake/submit.test.ts`

**Interfaces:**
- `registerSource(ctx, { kind, name, parentId?, userId?, dailyArrivalCap?, initialReviewStatusKey? }): Promise<string>` with SRC-E1-S1 rules (agent needs a person parent: `An agent needs an owner. Pick the person who runs it.`; scheduled pull needs a vendor parent; one person source per user: `This person already has a source.`), `updateSource(ctx, id, patch)` (`status`, cap 0 to 10,000: `The daily limit must be between 0 and 10,000.`), `listSources(ctx)` (tree order with arrivals in the last 30 days), `childSources(ctx, sourceId): Promise<string[]>`, `personSourceFor(ctx, userId): Promise<string>` (creates on first use).
- `SourceValidator.exists` and `SourceInfoProvider` (`getTrust` per Ruling 2; `sourcesForAccount` from resolved arrivals) implementations.
- Consumer `intake.tenant_defaults` on `tenancy.tenant.created`: vendor sources `apollo`, `vibe`, `hubspot_qualified` (kind `vendor`, `vendor`, `crm`, names `Apollo`, `Vibe Prospecting`, `HubSpot marketing qualified`, with `settings.key` set to those keys), the six relationship defaults, and the `intake.waiting.expire` schedule (Ruling 8).
- `submitArrival(ctx, body: unknown, opts: { channel: 'api' | 'mcp' | 'file' | 'web' | 'webhook' | 'enrichment'; batchId?: string; inline?: boolean; raw?: unknown }): Promise<{ arrivalId: string; status: 'received' | 'rejected'; replayed: boolean; inlineResult?: InlineResult }>`:
  - Chain from `ctx.access.sourceId` and its parent (agent → person), plus `via_vendor` matched by vendor `settings.key`. Never from the body (SRC-E2-S1-AC5).
  - Paused source: `403` `This source is paused`. Archived: `403` `This source is archived`.
  - Cap (Ruling 1): a single arrival over cap throws `ScoutError({ slug: 'cap-reached', status: 429, title: 'This source has sent its daily limit of arrivals.', retryAfter })`; nothing stored.
  - Same `external_ref` from the same source returns the existing arrival with `replayed: true`.
  - Stores the row (`payload` = `{ raw, parsed, contractVersion: 1 }`, `payload_hash`), publishes `intake.arrival.received`, enqueues `jobs.intake.resolve` (unless `inline`) in the same transaction.
- `submitBatch(ctx, body: unknown, opts): Promise<{ batchId: string; items: { arrivalId: string; externalRef: string | null; status: 'received' | 'rejected' }[] }>`: Ruling 7; items past the cap stored and rejected `daily_cap_reached` with detail `This source reached its daily limit. Send this one again after <local time>.`; publishes `intake.batch.created`.

- [ ] **Step 1: Write failing tests.** SRC-E1-S1-AC1, AC2. SRC-E1-S1-AC4 at the consumer level (three vendor sources after `tenancy.tenant.created`). SRC-E1-S2-AC1 (cap range), AC2 (cap 2: third single arrival → 429 with `retryAfter` at the next tenant day and no row; a batch of 3 with cap 2 → third item rejected `daily_cap_reached`), AC3 (an agent's arrival carries `unvetted`, a person's `needs_review`, in the arrival row's chain lookup), AC4 (paused source → 403 copy). SRC-E2-S1-AC1 (one transaction: arrival row, `intake.arrival.received` and a resolve job), AC2 (payload raw deep-equals the input), AC3 (same `external_ref` twice → one row), AC5 (a body naming `person_source_id` is rejected by the strict schema; the chain comes from the key). Review Focus 5 (a batch with items 2 and 4 invalid → 5 ids in order, items 2 and 4 `rejected` with the failing paths in `detail`). SRC-E2-S2-AC3 `duplicate_in_batch` (items 1 and 3 with domains `acme.com` and `https://www.acme.com/` → item 3 rejected). Tenancy: `createApiKey` with a `source_id` that doesn't exist now fails (validator registered).
- [ ] **Step 2:** Run `npm run test:int -- intake/sources intake/submit`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): source registry, daily caps and arrival submission`.

### Task 13: The resolve pipeline

**Files:**
- Create: `src/modules/intake/services/resolve.ts`, `src/modules/intake/services/warm-intros.ts`, `src/modules/intake/normalise-task.ts`, `src/modules/intake/jobs.ts`
- Modify: `src/entry/worker.ts`
- Test: `tests/integration/intake/resolve.test.ts`

**Interfaces:**
- Consumes: `findMatches`, `upsertFromArrival`, `runTask` (ai-tasks).
- `resolveHandler` for `jobs.intake.resolve` and `resolveArrival(ctx, arrivalId, opts?: { decision?: ResumeDecision }): Promise<ResolveOutcome>` running SRC-E3 steps 1 to 8. Each step writes its outcome on the arrival row (`status`, `waiting_on`, `account_id`, `resolution`, `duplicate_candidates`, `warm_intro_id`, `reject_reason`, `resolved_at`), and each step first checks whether it already happened, so a retried job is safe (SRC-E3-S1-AC3).
- Ordering: the handler takes `pg_advisory_xact_lock(hashtext(tenant_id || ':' || normalised_domain))` (or the matched shell email, or the arrival id when neither exists) before `findMatches`, so two arrivals for one company never resolve at once.
- AI task `arrival_normalise` (input: `{ industry?: string; relationship?: string }`; output `{ industryKey: string | null; relationshipKey: string | null }`; mock returns nulls), called only when the rules return null for industry or `other` for a non-empty relationship.
- `isFirstFromSource`: true when no earlier resolved arrival with any of the same chain source ids points at the account.
- `intake.arrival.resolved` carries `initialReviewStatusKey` from the closest source in the chain (agent, then person, then vendor), `effectiveTrust` from `getTrust`, `warmIntro`, `practiceHint`, `offerHint`.
- Batch counters on `batch.counts` (`resolved`, `rejected`, `newAccounts`, `alreadyKnown`, `waiting`) update in the same transaction; the last item publishes `intake.batch.completed` with `reportedCost` from `metadata.reported_cost`.
- Inline mode (`inline: true`, targeted only): steps 1, 2, 5 and 7 inside the caller's transaction; `InlineResult = { accountId; personIds; signalIds; alreadyKnown: boolean }`.

- [ ] **Step 1: Write failing tests.** SRC-E3-S2-AC1 end to end (two arrivals, `miamidade.gov` then `https://www.miamidade.gov/x` → one account, second `attached`). AC2 (alias of a merged account attaches to the survivor). AC4 at the service level (a possible duplicate waits with candidates; `resolveArrival` with `decision: { kind: 'same_as', accountId }` attaches; with `{ kind: 'new_company' }` creates; both audited). SRC-E3-S1-AC3 (run the handler, then roll back after step 5 by throwing in a test hook, retry → one account, one set of people, facts and signals). SRC-E3-S4-AC2 (`isFirstFromSource` true then false for the same source; true for a second source). Excluded: a software vendor arrival → `rejected` / `excluded`, `account_id` set, `detail` `Software vendor`. Warm intro: an agent-declared intro with `knows the CTC director from FPTA` stores `employee_network`, points 4 unconfirmed; `getWarmIntro` returns it. Batch: three items resolve → `intake.batch.completed` with counts `{ resolved: 3, rejected: 0, newAccounts: 2, alreadyKnown: 1 }`. Review Focus 1 (two batches from two agents each with `acme.com`, resolved by two concurrent `resolveArrival` calls → one account). Inline: `submitArrival(…, { inline: true })` with `target_account_id` and a person returns the person id in the same call.
- [ ] **Step 2:** Run `npm run test:int -- intake/resolve`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): resolve pipeline with duplicate checks, warm intros and batch completion`.

### Task 14: Waiting arrivals, status reads and expiry

**Files:**
- Create: `src/modules/intake/services/waiting.ts`, `src/modules/intake/services/status.ts`
- Modify: `src/modules/intake/jobs.ts`, `src/entry/worker.ts`
- Test: `tests/integration/intake/waiting.test.ts`, `tests/integration/intake/status.test.ts`

**Interfaces:**
- `listWaiting(ctx, { reason?, cursor?, limit? })`, `supplyWebsite(ctx, arrivalId, website)`, `supplyCompany(ctx, arrivalId, { name, website? } | { soleProprietor: true })`, `chooseDuplicate(ctx, arrivalId, { kind: 'same_as'; accountId } | { kind: 'new_company' })`: each records the decision on the arrival (the stored payload is untouched; the decision lives in `arrival.resolution_input`), audits, and resumes the pipeline from step 2 via a new resolve job. `skipWaiting(ctx, batchId)` rejects a batch's waiting items `invalid` with `Skipped by <name>.` (SRC-E4-S4-AC2).
- `waitingExpireHandler` for `jobs.intake.waiting.expire`: rejects arrivals waiting more than 30 days `invalid` with `Nobody supplied the missing website within 30 days` (SRC-E3-S3-AC3; feedback rows land with SRC-E1-S4 in R1b, so only the rejection and event here).
- `getArrival(ctx, id)` (status, `waiting_on`, reason, detail, account id, chain, raw and parsed payload, unused fact keys), `listArrivals(ctx, { batchId?, status?, since?, cursor?, limit? })`, `getBatch(ctx, id)` (counts by status, rejections with `external_ref`, reason and detail, files), `listBatchItems(ctx, id, { cursor, limit })`, `accountForArrival(ctx, arrivalId)`, `getWarmIntro(ctx, accountId)`. Every read applies the principal's source visibility: `own_source` sees only arrivals and batches whose chain includes its source or children (SRC-E2-S3-AC3 returns `null` → the route maps it to 404).

- [ ] **Step 1: Write failing tests.** SRC-E3-S3-AC1 (a file-channel arrival with no website waits `needs_website`; `supplyWebsite` resumes and resolves). AC2 (a batch with one waiting item is not completed; after `supplyWebsite` it is). AC3 (an arrival with `received_at` 31 days ago is rejected by the expiry handler with the copy). `supplyCompany({ soleProprietor: true })` makes a shell account. SRC-E2-S3-AC1 (`getBatch` counts and rejections), AC3 (another source's agent gets null for an arrival and a batch). Arrivals with unknown fact keys list them in `unusedKeys`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): waiting arrivals, status reads and 30-day expiry`.

### Task 15: File parsing (CSV, Excel, Markdown)

**Files:**
- Create: `src/modules/intake/import/parse.ts`
- Modify: `package.json` (`exceljs`)
- Test: `tests/unit/intake/parse.test.ts`, fixtures in `tests/fixtures/imports/`

**Interfaces:**
- `parseFile(input: { fileName: string; contentType?: string; bytes: Uint8Array }, opts?: { sheet?: string }): Promise<ParsedFile>` with `ParsedFile = { kind: 'csv' | 'xlsx' | 'markdown'; sheets?: string[]; headers: string[]; rows: Record<string, string>[]; rowNumbers: number[] }`. CSV: delimiter detected among comma, semicolon and tab by the first non-empty line; quotes, doubled quotes and line breaks in cells; BOM removed (port `c3c2124:src/lib/leadSheet.ts`). Excel: first sheet unless `sheet` is given; `sheets` lists every sheet name; dates as ISO `YYYY-MM-DD`. Markdown: the first pipe table. Duplicate headers get ` (2)`, ` (3)`. Blank rows skipped; `rowNumbers` keep the file's 1-based line or row numbers.
- Limits: over 20 MB → `This file is over 20 MB. Split it and import the parts.`; over 10,000 rows → `This file has more than 10,000 rows. Split it and import the parts.` (SRC-E4-S1-AC2).

- [ ] **Step 1: Write failing tests.** Port `c3c2124:tests/unit/leadSheet.test.ts` parsing cases. Review Focus 2 exactly (BOM, semicolons, a quoted cell with a line break, a blank row, duplicate `Email` headers, trailing empty columns). A two-sheet `.xlsx` fixture (create it in the test with `exceljs`) lists both sheets and parses the second when asked. A Markdown table with alignment row parses. The two limit messages.
- [ ] **Step 2:** Run `npm run test:unit -- parse`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): parse CSV, Excel and Markdown files`.

### Task 16: Column mapping: built-in layouts, saved mappings, synonyms and Claude

**Files:**
- Create: `src/modules/intake/import/layouts/research.ts`, `src/modules/intake/import/layouts/vibe.ts`, `src/modules/intake/import/synonyms.ts`, `src/modules/intake/import/mapping-task.ts`, `src/modules/intake/import/rows-to-arrivals.ts`
- Test: `tests/unit/intake/layouts.test.ts`, `tests/unit/intake/rows-to-arrivals.test.ts`, `tests/integration/intake/mapping.test.ts`

**Interfaces:**
- `type Mapping = { columns: Record<string, MappingTarget>; personGroups: number; layout?: 'research' | 'research_master' | 'vibe_export' | null }`, `MappingTarget` = an `arrival.v1` path (`account.name`, `account.website`, `people[0].email`, `signals[].occurred_at`, `research.hook`, `account.practice_hint`, `account.external_ref`, `account.notes`, `account.custom_fields.<key>`) with a `confidence` 0 to 1.
- `headerSignature(headers: string[]): string` (lowercase, trimmed, sorted, sha256).
- `detectLayout(headers): 'research' | 'research_master' | 'vibe_export' | null` and `layoutRowsToArrivals(layout, parsed, now)` porting `c3c2124:src/lib/research.ts` (`RESEARCH_FIELDS`, the four layouts and stacked master files) and `c3c2124:src/integrations/prospects/vibe.ts` plus `vibeExport.ts` (12 months of events, M&A only when a party, no crime stories as lawsuits, three most recent news items per type, industry from NAICS, people and seniority). Vibe events become signals with `fine_type` set.
- `synonymMapping(headers): Mapping` (port the lead-sheet header guesses).
- AI task `csv_column_mapping` (input: headers plus 5 sample rows; output: `{ columns: { header: string; target: string | null; confidence: number }[] }`, Zod-checked; targets outside the allowed list become null; under 0.6 left unmapped). Mock mode returns `synonymMapping` and the import records `mapping_origin: 'synonyms'` so the page can say `Suggested from column names`.
- `chooseMapping(ctx, { sourceId, headers, sampleRows }): Promise<{ mapping: Mapping; origin: 'layout' | 'saved' | 'synonyms' | 'ai'; needsConfirm: boolean }>` in the SRC-E4 order; `needsConfirm` false only for `layout` and `saved` with every required field mapped (company name and one of website, domain, work email).
- `rowsToArrivals(parsed, mapping, { practiceHintFrom?: string }): { arrivals: { body: ArrivalV1; raw: { headers; rows } }[]; skipped: { row: number; reason: string }[] }`: groups rows by domain (website column, else work-email domain); personal-email rows with no company skipped with `Personal email and no company`; rows with a company and no website kept with no identity (they wait `needs_website`); `practice_hint` from a research agent column or the file name.
- `saveMapping(ctx, sourceId, headers, mapping)`, `listMappings(ctx, sourceId)`, `deleteMapping(ctx, id)`.

- [ ] **Step 1: Write failing tests.** SRC-E4-S2-AC1: port `c3c2124:tests/unit/research.test.ts` (four layouts and a master file produce the same companies, people, research facts and practice hints as v1). AC2: port `c3c2124:tests/unit/vibeExport.test.ts` and `vibe.test.ts` (signal rules and people). AC3 at the service level: a saved mapping is reused for the same headers in a different order with `needsConfirm: false`. SRC-E4-S3-AC1 in mock mode: unknown headers give origin `synonyms`. Rows: two rows with `@acme.com` emails and no website become one arrival with two people; a `gmail.com` row with no company is skipped with its row number; a company with no website is kept.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): column mapping with known layouts, saved mappings and Claude suggestions`.

### Task 17: Imports and batch files

**Files:**
- Create: `src/modules/intake/services/files.ts`, `src/modules/intake/services/imports.ts`
- Modify: `src/modules/intake/jobs.ts`, `src/entry/worker.ts`
- Test: `tests/integration/intake/imports.test.ts`, `tests/integration/intake/files.test.ts`

**Interfaces:**
- `attachFile(ctx, batchId, { fileName, contentType, bytes }): Promise<{ storageKey; sha256 }>` (25 MB: `Files can be up to 25 MB each.`; 10 per batch: `A batch can have up to 10 files.`), `readFile(ctx, storageKey)`.
- `createImport(ctx, { fileName, contentType, bytes, sheet?, vendorSourceId? }): Promise<ImportView>`: creates the batch (source = `ctx.access.sourceId`, or the person source for the signed-in user), attaches the file, parses, chooses a mapping, stores `file_import` with status `needs_confirm` or `queued` (and enqueues `jobs.intake.import.run` when no confirm is needed). For a multi-sheet `.xlsx` without `sheet`, status `needs_sheet` with the sheet list (SRC-E4-S1-AC3).
- `previewImport(ctx, importId, mapping?)` (first 5 arrivals it would create, SRC-E4-S3-AC2), `confirmImport(ctx, importId, mapping)` (saves the mapping for the source and header signature, enqueues the run), `importRunHandler` (submits one arrival per company through `submitArrival` with channel `file` and the batch id; records `stats`: companies, people, skipped rows with numbers and reasons), `getImport(ctx, id)` (stats plus live counts from the batch: created, attached, waiting with their arrival ids, rejected).

- [ ] **Step 1: Write failing tests.** SRC-E4-S1-AC1 (three `createImport` calls → three batches, each with its file and sha256). AC3 (two-sheet file → `needs_sheet`). SRC-E4-S2-AC1 at this level (a research fixture imports with no confirm and creates accounts after the worker runs the jobs). SRC-E4-S4-AC1 (`getImport` shows created, attached, waiting with ids, skipped with row numbers). AC2 (`skipWaiting` completes the batch). Files: 26 MB refused with the copy; an 11th file refused.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): file imports and batch files`.

### Task 18: Intake on /v1

**Files:**
- Create: `src/app/v1/sources/route.ts`, `src/app/v1/arrivals/route.ts`, `src/app/v1/arrivals/[id]/route.ts`, `src/app/v1/batches/route.ts`, `src/app/v1/batches/[id]/route.ts`, `src/app/v1/batches/[id]/items/route.ts`, `src/app/v1/batches/[id]/files/route.ts`, `src/app/v1/imports/route.ts`, `src/app/v1/imports/[id]/route.ts`
- Modify: `src/app/v1/_lib/v1-route.ts` (fill `access.childSourceIds` through intake's `childSources`)
- Test: `tests/integration/v1/arrivals.test.ts`, `tests/integration/v1/batches.test.ts`, `tests/integration/v1/imports.test.ts`

**Interfaces:**
- Endpoints, scopes and responses exactly as in the SRC index and `public-api/async-and-batches.md`: `POST /v1/arrivals` → `202 { arrival_id, status_url }` (idempotent); `GET /v1/arrivals/{id}`; `GET /v1/arrivals?batch_id&status&since&cursor`; `POST /v1/batches` → `202 { batch_id, status_url, item_count, items: [{ arrival_id, external_ref, status }] }` (idempotent); `GET /v1/batches/{id}`; `GET /v1/batches/{id}/items`; `POST /v1/batches/{id}/files` (multipart, one file per call); `POST /v1/imports` (multipart) → `202 { import_id, status, proposed_mapping, needs_confirm }`; `GET /v1/imports/{id}`; `POST /v1/imports/{id}:confirm`; `GET /v1/sources` and `POST /v1/sources` (`sources:manage`).
- Validation failures → `400` `validation` with `errors[]` of `{ path, message }` (SRC-E2-S1-AC4). Over cap → `429` `cap-reached` with `Retry-After` seconds and `resets_at`. Hidden or missing → `404` `not-found`. Request body limits: 5 MB, batches 10 MB (`413` with `This request is over the size limit.`).

- [ ] **Step 1: Write failing tests.** API-E1-S2-AC1 (two POSTs with the same `Idempotency-Key` and body → one arrival), AC2 (same `external_ref`, no key → the first arrival). SRC-E2-S1-AC1 (202 shape; p95 under 300 ms over 50 sequential calls on the laptop), AC4 (invalid body → 400 with two `errors[]` paths, nothing stored), AC6 (429 with `Retry-After`). SRC-E2-S2-AC1 (ids in order), AC2 (file upload returns sha256). SRC-E2-S3-AC1 (`GET /v1/batches/{id}` counts), AC3 (404 for another source). SRC-E4-S4-AC3 (`POST /v1/imports` with a research fixture then `GET` shows `queued` or finished; with an unknown layout `needs_confirm`, then `:confirm` runs it). A body with an unknown top-level field → 400 (`api-foundations`: unknown fields rejected).
- [ ] **Step 2:** Run `npm run test:int -- v1/arrivals v1/batches v1/imports`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(intake): /v1 sources, arrivals, batches and imports`.

### Task 19: Accounts on /v1, including inline people and signals

**Files:**
- Create: `src/app/v1/accounts/route.ts`, `src/app/v1/accounts/[id]/route.ts`, `src/app/v1/accounts/[id]/people/route.ts`, `src/app/v1/accounts/[id]/signals/route.ts`, `src/app/v1/accounts/[id]/facts/route.ts`, `src/app/v1/people/[id]/route.ts`
- Test: `tests/integration/v1/accounts.test.ts`

**Interfaces:**
- As the ACC index, except the conflict endpoints (R2): `GET /v1/accounts` (search, `accounts:read`), `GET /v1/accounts/{id}` (with `merged_into` for merged ids), `PATCH /v1/accounts/{id}` (`accounts:write`; API keys write facts with their source as chain, not pinned; people pin), `GET /v1/accounts/{id}/people` (contact fields only with `people:read`), `POST /v1/accounts/{id}/people` (`people:write`; inline targeted arrival; returns `{ person_id, already_known }`; `committee_gaps` waits for ACC-E2 in R2 and is omitted), `PATCH /v1/people/{id}`, `POST /v1/accounts/{id}/signals` (`signals:write`; returns `{ signal_id, already_known }`, and `warning: 'A source link is strongly recommended.'` when `url` is missing), `GET /v1/accounts/{id}/facts?field=&include=history`.

- [ ] **Step 1: Write failing tests.** ACC-E1-S4-AC1 (agent adds a person → `person_id` in the same response and the person exists), AC2 (same email again → same id with `already_known: true`), AC4 (an agent that can't see the account gets 404). ACC-E4-S3-AC1 (signal id; a repeat returns the existing id), AC2 (missing `occurred_at` → 400 `Add the date it happened.`; missing `url` → `201`, since the call resolves inline, with `warning: 'A source link is strongly recommended.'`). ACC-E3-S1-AC2 (`facts?include=history` lists both values for `employees` with chains). ACC-E5-S1-AC3 (merged id → survivor with `merged_into`). `GET /v1/accounts/{id}/people` without `people:read` omits `email` and `phone`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): /v1 accounts, people, signals and facts`.

### Task 20: Seed data, one-path test and R1a exit

**Files:**
- Modify: `src/entry/seed.ts`, `src/entry/cli.ts` (`scout import <tenant-slug> <file>` for laptops: runs `createImport` as the platform admin's person source and prints the result), `README.md`, `docs/CHANGELOG.md`, `docs/spec/migration-and-rollout/release-plan.md` (R1a progress lines), `docs/spec/architecture/event-catalog.md` (any event added or renamed)
- Test: `tests/integration/intake/one-path.test.ts`, `tests/unit/seed.test.ts`, `tests/integration/entry/cli.test.ts`

**Interfaces:**
- Seed: Taazaa practices, offers and case studies (Task 3), account defaults (Task 4), intake defaults (Task 12) for every seeded tenant; one person source per seeded user (SRC-E1-S1-AC4); an agent source `Local development agent` owned by the admin's person source; the dev API key bound to that agent source with scopes `arrivals:write`, `arrivals:read`, `accounts:read`, `people:write`, `signals:write`, `offers:read`, `status:read`; the expiry schedule.
- R1a exit: a CSV, a `/v1` batch and a single `/v1` arrival each create de-duplicated accounts with their sources recorded, on a laptop.

- [ ] **Step 1: Write failing tests.** SRC-E3-S1-AC1 for the channels that exist in R1a: the same company sent as a single `/v1` arrival, a `/v1` batch item, a CSV import row and an inline targeted arrival, from four sources, ends as one account with four source ids in `account_summary.source_ids`, the same people and the same current facts. Seed: two runs leave one agent source and one dev key name. CLI: `scout import taazaa tests/fixtures/imports/research-a.csv` exits 0 and prints the batch id and counts.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite: `npm run typecheck && npm run lint && npm test && npm run e2e`. Expected: PASS. Then on the laptop: `npm run scout -- seed`, start `all-background` and `dev`, `curl -X POST -H "Authorization: Bearer <dev key>" -H "content-type: application/json" -d @tests/fixtures/imports/miami-dade-arrival.json http://localhost:4240/v1/arrivals`, then `GET` the `status_url` until `resolved` with an `account_id`.
- [ ] **Step 5:** Commit `feat: R1a seed data, import command and exit check`.
