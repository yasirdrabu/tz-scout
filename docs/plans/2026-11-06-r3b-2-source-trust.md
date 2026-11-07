# R3b-2 Source trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every source's trust is learned nightly from what its accounts became, drops immediately when it loses a conflict, feeds scoring through the existing `trust_changed` rescore, and shows on the Sources page, the source page and the account page.

**Architecture:** Intake owns trust (SRC-E1). A pure `domain/trust.ts` holds the quality table and formula. A nightly intake job reads intake's own resolved arrivals and `source_feedback`, plus routing's stages and stage history through a new `StageOutcomes` port (intake can't import routing services; routing imports intake). It writes `source.trust`, a history row and publishes `intake.source.trust_changed`, which scoring already consumes (`scoring.rescore_trust_changed`). Scoring already reads `source.trust` via `getTrust` / `bestTrustForAccounts`, so the score math does not change.

**Tech Stack:** TypeScript, Hono `/api/v1`, Drizzle + Postgres RLS, outbox + NATS consumers, platform scheduler, React 19 + TanStack Query, msw, vitest, Playwright.

**Spec:** `docs/spec/sources-and-intake/source-registry-and-trust.md` (Trust scores, Data, SRC-E1-S3), `docs/spec/sources-and-intake/index.md` (tables), `docs/spec/web-ui/screens.md` §4a item 3, §10, §11, §21f. Map: `docs/plans/2026-11-06-r3b-funnel.map.md`.

## Global Constraints

- Every source starts at **0.60**; UI shows trust as a whole number out of 100 ("Source trust 72").
- Arrival quality by furthest stage: declined at review, or declined by seller with a "bad fit" or "bad data" reason 0.00; arrived with no decision after 30 days 0.10; reviewed 0.30; assigned (accepted) 0.50; engaged 0.70; opportunity 0.90; won 1.00. Arrivals under 30 days old with no review decision are left out.
- `weight_i = 0.5 ^ (age_days_i / 180)`; `trust = (10 × 0.60 + Σ quality_i × weight_i) / (10 + Σ weight_i)`; `trust = max(0, trust − 0.01 × conflicts_lost_in_last_180_days)`.
- Person, agent and vendor trust are computed independently, each from the arrivals it appears in.
- Effective trust of an arrival: `0.4 × person + 0.3 × agent + 0.3 × vendor`, re-weighted over the levels present (exists: `intakeSourceInfo.getTrust`; unchanged).
- A change of 0.02 or more publishes `intake.source.trust_changed` (event exists in `src/modules/intake/contracts/events.ts:79`).
- Source page Trust card copy: "Updated nightly". Account trust note shape: "RFP Watch: 6 won of 41 sent". Breakdown shape: "Person 0.64, agent 0.71, vendor 0.55".
- Trust filter options, verbatim: "80 and up", "60 to 79", "Below 60", "Not enough data".
- New tables get RLS like the other intake tables (copy the policy lines from `0002_source_feedback.sql`); migrations come from `drizzle-kit` per the intake config with RLS lines added by hand.
- Test env: `.superpowers/sdd/2026-11-06-r3b-2-source-trust/test-env.md`. Never touch ports 5432/4222 or `C:\dev\tz-scout`.

## Rulings (controller, 2026-11-06)

1. **No `arrival_outcome` read model.** The nightly job computes from current truth: intake's resolved arrivals and `source_feedback`, routing's stages and `stage_change` history through the `StageOutcomes` port. Why: one place computes, no out-of-order event bugs (R3b-1 needed several fixes for those), no separate backfill. Cost if wrong: add the read model later when workspaces get large; the formula and history don't change.
2. **Quality by trigger, not key.** Stages are configurable, so a flow stage's quality comes from its trigger: `source_creates` 0.10, `reviewer_sets_tier` 0.30, `ae_accepts` 0.50, `reply_or_meeting` and `meeting_booked` 0.70, `deal_created` and `deal_reaches_stage` 0.90, `deal_closed_won` 1.00. Any other flow stage (`by_hand`) takes the highest quality of the flow stages at or before its position. An account's best quality is the highest over the flow stages it entered, at least 0.10. Skipped stages count as passed (same as R3b-1).
3. **Declines.** Zero quality when the account was declined at review (a `declined_at_review` feedback row, or entering an exit stage whose trigger is `reviewer_rejects`) or declined by a seller with reason key `not_a_fit` or `bad_data`, **and** the account entered no flow stage at or past the assigned one (the `ae_accepts` stage, as Ruling 5 defines assigned) after that decline. Later progress overrides an old decline; moving back to Sent or Reviewed (a reopen, or accounts moved when a stage is deleted) keeps the 0. Only declines and stage entries at or after the arrival count at all.
4. **Decided.** An arrival is judged when its best quality is 0.30 or more, or it is zeroed, or the account entered any exit stage. Otherwise it is left out under 30 days old and scores 0.10 at 30 days or more.
5. **One credit per source and account.** For each (source, account) only the earliest resolved arrival counts; its age is from `resolved_at`. An arrival is skipped when the account had already entered an assigned stage (`routingFunnelStages` sense: flow stage at or after the `ae_accepts` stage) before that arrival's `resolved_at`.
6. **Level.** A source's level is the arrival column it appears in: `person_source_id` → person, `agent_source_id` → agent (lists sit here too), `vendor_source_id` → vendor. Partners and CRM sources sit in the person column (see `submit.ts:88-92`) and are rated the same way.
7. **Stored and published.** Each compute writes `source.trust`, `trust_sample`, `trust_won`, `trust_updated_at` and one `source_trust_history` row per source it computed. It publishes `trust_changed` only when `|to − trust_published| ≥ 0.02`, then sets `trust_published = to`. So small nightly drift shows on screen at once, and scoring is told once it adds up.
8. **Conflict loss.** After `recordConflictLost` writes feedback, the same consumer recomputes trust for the losing sources (`cause: 'conflict_lost'`). The count is `conflict_lost` feedback rows for the source with `created_at` in the last 180 days.
9. **Schedule.** Nightly at 01:00 UTC, before scoring's 02:00 ageing. Seeded by `seedIntakeDefaults`. Existing workspaces run `scout backfill-trust <slug>` once (seeds the schedule and computes now); `seed.ts` computes for the tenants it seeds. CHANGELOG entry.
10. **Not enough data.** Under **10** judged arrivals the UI says "Not enough data yet" and the Trust filter puts it in "Not enough data". Scoring still uses the number (the prior keeps it near 0.60).
11. **Scoring unchanged.** Scoring's four-weight model (trust weight 20) stays; the spec's "±5 points" line predates SCO-E6. Only the trust note and a hover breakdown change.
12. **Account breakdown.** The Source trust tile on the account page carries the breakdown for the best chain (the one scoring used) as hover text. Other chains aren't listed.
13. **Weights note.** §21f "The same for every source until Scout learns from outcomes." becomes "Learned nightly from what each source's accounts became."
14. **Removed and archived sources.** Removed sources are skipped; archived sources are still computed (their history stays readable).

## Review Focus

1. A workspace with a custom `by_hand` flow stage between Engaged and Opportunity: it scores 0.70, not 0.10 (Task 1 test).
2. An account declined at review, then reopened and won: its sources get 1.00, not 0.00 (Task 1 test).
3. The same agent sending the same account twice: one credit, not two (Task 2 test).
4. A second nightly run with no new outcomes: no `trust_changed` event, one more history row (Task 2 test).
5. A merged account: the survivor's stages credit the merged account's sources (intake already moves arrivals to the survivor; Task 2 test checks routing's history also points at the survivor, and maps ids through `resolveAccountId` from `@/modules/accounts` if it does not).

---

### Task 1: Trust formula and arrival quality (pure)

**Files:**
- Create: `src/modules/intake/domain/trust.ts`
- Test: `tests/unit/intake/trust.test.ts`

**Interfaces:**
- Produces:
  - Constants `TRUST_PRIOR = 0.6`, `PRIOR_WEIGHT = 10`, `HALF_LIFE_DAYS = 180`, `CONFLICT_DROP = 0.01`, `PUBLISH_STEP = 0.02`, `JUDGE_AFTER_DAYS = 30`, `MIN_SAMPLE = 10`, `ZERO_SELLER_REASONS = ['not_a_fit', 'bad_data']`, `TRIGGER_QUALITY: Record<string, number>` (Ruling 2).
  - `type TrustStage = { key: string; kind: 'flow' | 'exit'; position: number; trigger: string }`
  - `stageQualities(stages: TrustStage[]): Map<string, number>` — flow stages only (Ruling 2).
  - `arrivalQuality(a: { resolvedAt: Date; entries: { stage: string; at: Date }[]; declines: Date[]; stages: TrustStage[]; qualities: Map<string, number>; now: Date }): number | null` — Rulings 2-4; `declines` are the zeroing decline times; `null` = not judged yet.
  - `decayWeight(ageDays: number): number`
  - `trustOf(judged: { quality: number; ageDays: number }[], conflictsLost: number): number` — rounded to 4 decimals.
  - `trustBand(trust: number, sample: number): 'high' | 'mid' | 'low' | 'not_enough'` — ≥0.80, 0.60–0.7999, below 0.60, sample < `MIN_SAMPLE`.

- [ ] **Step 1: Write the failing tests** (`DEFAULT_STAGES` from `@/modules/routing/domain/pipeline` mapped to `TrustStage` is fine in the test)
  - `trustOf([], 0)` → `0.6`.
  - 20 fresh wins (`quality 1, ageDays 0`) → `0.8667`.
  - 40 fresh declines (`quality 0, ageDays 0`) → `0.12`.
  - `decayWeight(360)` → `0.25`; `decayWeight(0)` → `1`.
  - `trustOf([], 3)` → `0.57`; `trustOf(40 fresh declines, 20)` → `0`.
  - `stageQualities(DEFAULT_STAGES)` → arrived 0.1, reviewed 0.3, assigned 0.5, engaged 0.7, opportunity 0.9, won 1; no exit keys.
  - A `by_hand` flow stage at a position between engaged and opportunity → 0.7.
  - `arrivalQuality`: entered reviewed+assigned → 0.5; only arrived, 10 days old → `null`; only arrived, 31 days old → 0.1; entered `declined` exit (trigger `reviewer_rejects`) with a decline time → 0; declined then later entered `won` → 1; entered only `lost` exit after assigned → 0.5; entered `back_to_nurture` exit only, 5 days old → 0.1 (decided by the exit).
  - `trustBand(0.8, 10)` → `'high'`; `(0.79, 10)` → `'mid'`; `(0.59, 10)` → `'low'`; `(0.9, 9)` → `'not_enough'`.

- [ ] **Step 2: Run** `npx vitest run tests/unit/intake/trust.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** `src/modules/intake/domain/trust.ts` with the signatures above.
- [ ] **Step 4: Run** the test — PASS. `npm run lint` and `npm run typecheck` clean.
- [ ] **Step 5: Commit** `feat(intake): trust formula and arrival quality`.

### Task 2: Nightly trust job, history, conflict-loss drop and `trust_changed`

**Files:**
- Modify: `src/modules/intake/db/schema.ts` (source columns, new table), new migration `src/modules/intake/db/migrations/0008_source_trust.sql` (+ RLS lines)
- Modify: `src/modules/intake/contracts/ports.ts` (`StageOutcomes` port), `src/modules/intake/index.ts` (exports)
- Modify: `src/modules/routing/services/pipeline-stages.ts` (`routingStageOutcomes`), `src/modules/routing/index.ts`, `src/entry/compose.ts` (register)
- Create: `src/modules/intake/services/trust.ts`
- Modify: `src/modules/intake/contracts/jobs.ts`, `src/modules/intake/jobs.ts`, `src/entry/worker.ts` (handler), `src/modules/intake/defaults.ts` (schedule), `src/modules/intake/consumers.ts` (`intakeConflictFeedback` recomputes)
- Modify: `src/entry/seed.ts` (`backfillTrust`, seed computes), `src/entry/cli.ts` (`backfill-trust <slug>`, USAGE), `docs/CHANGELOG.md`
- Test: `tests/integration/intake/trust.test.ts`, `tests/integration/intake/trust-migration.test.ts` (pin earlier migration tests to stop at 0007 if they count migrations, as R3a/R3b did)

**Interfaces:**
- Consumes: Task 1's `stageQualities`, `arrivalQuality`, `trustOf`, constants.
- Produces:
  - `source` gains `trustPublished numeric(5,4) not null default 0.6`, `trustSample integer not null default 0`, `trustWon integer not null default 0`.
  - `sourceTrustHistory` table `intake.source_trust_history(tenant_id, source_id, computed_at, trust numeric(5,4), sample_size int, won int, inputs jsonb)`, primary key (tenant_id, source_id, computed_at). `inputs` = `{ cause, conflictsLost, level }`.
  - Port: `interface StageOutcomes { stages(ctx): Promise<TrustStage[]>; history(ctx): Promise<{ accountId: string; toStage: string; at: Date }[]> }`, `registerStageOutcomes(s: StageOutcomes | null)`, `stageOutcomes()` (default when unregistered: `stages` → `[]`, `history` → `[]`). Routing's impl: `loadStages` mapped to `TrustStage`, and `listStageHistory`.
  - `computeTrust(ctx: ModuleContext, opts: { cause: 'outcomes' | 'conflict_lost'; sourceIds?: string[]; now?: Date }): Promise<{ sourceId: string; from: number; to: number; sampleSize: number; published: boolean }[]>` — Rulings 3-8, 14. Publishes `sourceTrustChanged` `{ sourceId, level, from: trust_published, to, sampleSize, cause }`.
  - Job `intake.trust` (`trustJob`, payload `{}`), `trustHandler`; schedule `{ jobName: trustJob.name, cron: '0 1 * * *', timezone: 'UTC', payload: {} }`.
  - `backfillTrust(ctx)` = `seedIntakeDefaults` then `computeTrust({ cause: 'outcomes' })`; CLI `backfill-trust <tenant-slug>` same shape as `backfill-journeys`.

- [ ] **Step 1: Write failing integration tests** in `tests/integration/intake/trust.test.ts` (build arrivals, stage changes and feedback through the existing services or test helpers the intake integration tests already use):
  - A source with no arrivals: `computeTrust` leaves 0.6, writes a history row with `sample_size 0`, publishes nothing.
  - An agent whose 12 accounts were all won 0 days ago: agent trust `= trustOf(12 wins)` (0.8182), the owner person's trust the same, `trust_sample 12`, `trust_won 12`, one `intake.source.trust_changed` in the outbox with `level 'agent'`, `from 0.6`, `cause 'outcomes'`; `trust_published` equals the new trust.
  - Run it again with no change: no new event, one more history row (Review Focus 4).
  - The same agent sends the same account twice: `trust_sample` 1, not 2 (Review Focus 3).
  - An arrival resolved after the account entered `assigned`: not counted.
  - A seller decline with `not_a_fit` and no later flow stage: quality 0; with `too_much_on_my_plate`: the account's stage quality.
  - Conflict loss: deliver `accounts.conflict.resolved` naming the source as loser (follow `tests/integration/intake/*conflict*` set-up); the source's trust drops by 0.01 at once and the history row has `inputs.cause 'conflict_lost'`; no event (change < 0.02).
  - Merge: account A's stages and B's arrival; merge A into B; B's sources get A's stage credit (Review Focus 5).
  - `tenant_id` isolation: another tenant's `computeTrust` doesn't read or write this tenant's rows (RLS).
- [ ] **Step 2: Run** `npx vitest run tests/integration/intake/trust.test.ts` (env from test-env.md) — FAIL.
- [ ] **Step 3: Schema + migration** (`drizzle-kit generate` with the intake config; add RLS by hand; migration test that 0008 adds the columns with defaults on existing rows).
- [ ] **Step 4: Port, `computeTrust`, job, schedule, consumer change, `backfillTrust`, CLI, seed, CHANGELOG** ("R3b-2: run `scout backfill-trust <slug>` once per existing workspace; it adds the nightly trust schedule and computes trust now. Until then every source reads 0.60.").
- [ ] **Step 5: Run** the new tests, then `npx vitest run tests/integration/intake tests/integration/scoring` — PASS. Lint and typecheck clean.
- [ ] **Step 6: Commit** `feat(intake): nightly source trust, history, conflict-loss drop`.

### Task 3: Trust in the APIs and the scoring note

**Files:**
- Modify: `src/modules/intake/services/source-read.ts` (rows and detail), `src/modules/intake/services/sources.ts` (`bestTrustForAccounts`)
- Modify: `src/modules/scoring/domain/explain.ts` (`trustReason`, `ExplanationLine.breakdown`), `src/modules/scoring/domain/tiles.ts` (`ScoreTile.breakdown`), `src/modules/scoring/services/score.ts`, the route/serializer that sends score tiles (find where `scoreTiles` is serialized)
- Modify: docs `docs/spec/web-ui/api-gaps.md` trust rows (678-679, 730, 742) marked done, `docs/spec/sources-and-intake/source-registry-and-trust.md` Data section (Ruling 1 note)
- Test: `tests/integration/intake/source-read.test.ts` (or the existing sources API test), `tests/unit/scoring/explain.test.ts`, `tests/unit/scoring/tiles.test.ts`

**Interfaces:**
- Consumes: Task 2's columns and history; Task 1's `trustBand`, `MIN_SAMPLE`.
- Produces (snake_case on the wire, as the existing source rows):
  - Source rows (`GET /sources`, detail): `trust: number` (round(trust × 100)), `trust_sample: number`, `trust_band: 'high' | 'mid' | 'low' | 'not_enough'`, `trust_label: string | null` ("Not enough data yet" when band is `not_enough`, else null), `trust_updated_at: string | null`.
  - Source detail adds `trust_trend: { month: string /* YYYY-MM */; trust: number /* 0-100 */; sample_size: number }[]` — the last history row of each of the last 12 months that have one, oldest first.
  - `bestTrustForAccounts` returns `{ trust, sourceId, sourceName, won: number, sent: number, levels: { person?: number; agent?: number; vendor?: number } }` — `won`/`sent` are the closest source's `trust_won`/`trust_sample`; `levels` are the best chain's per-level trusts.
  - `trustReason(trust, neutral)`: with `sent > 0` → `"{sourceName}: {won} won of {sent} sent"`; with `sent 0` → existing `"{sourceName} is rated {0.60}."`; null → existing text.
  - Trust explanation line and its tile get `breakdown: "Person 0.64, agent 0.71, vendor 0.55"` (levels present, in that order, 2 decimals, first word capitalised only); absent when there's no trust.
- [ ] **Step 1: Failing tests:** source rows carry the five fields (a source with 12 judged arrivals → band from trust, label null; a new one → `not_enough`, "Not enough data yet"); detail `trust_trend` with rows in two months returns two points, oldest first, last row of each month; `trustReason` with `{won: 6, sent: 41, sourceName: 'RFP Watch'}` → "RFP Watch: 6 won of 41 sent"; breakdown string for person+agent+vendor and for person only ("Person 0.64"); the account score API returns `breakdown` on the Source trust tile.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** those tests plus `npx vitest run tests/unit/scoring tests/integration/scoring tests/integration/intake` — PASS; lint, typecheck.
- [ ] **Step 5: Commit** `feat: trust on sources, trust trend, account trust note and breakdown`.

### Task 4: Trust on the web

**Files:**
- Modify: `web-ui/src/features/sources/api.ts` (types), `SourceTree.tsx` (Trust column), `SourcesScreen.tsx` (Trust filter in the URL, legend), `StatTiles.tsx` (Trust tile), `tabs/OverviewTab.tsx` (Trust card), `web-ui/src/features/account/*` (Source trust tile hover), `web-ui/src/features/settings/scoring/ScoringWeights.tsx` (Ruling 13), their msw handlers/fixtures and tests (`source-page.test.tsx`, the sources screen test, `scoring.test.tsx`, the account score strip test)
- Modify: `tests/e2e/` sources spec (or a new `trust.spec.ts`) and `tests/e2e/prepare-db.ts` if it needs `backfillTrust`
- Modify: `docs/spec/web-ui/screens.md` §10/§11/§4a item 3/§21f (drop "until R3" wording, record copy below)

**Interfaces:**
- Consumes: Task 3's wire fields.
- Copy (new, Claude's call): legend under the tree "Trust is learned nightly from what each source's accounts became. 80 and up is strong, 60 to 79 is average, below 60 is weak. New sources start at 60."; Trust card title "Trust", sub "Updated nightly", line "Based on {n} accounts" ("Based on 1 account"), empty trend "No history yet."; filter label "Trust" with options "All", "80 and up", "60 to 79", "Below 60", "Not enough data" (URL `trust=high|mid|low|not_enough`).
- Behaviour:
  - Tree Trust cell: number and a bar (width = trust %) when `trust_label` is null, else the label in muted text. The filter keeps a row when it or any descendant matches (same as the Type filter, check how Type does it and match).
  - Stat tile Trust: the number, or the label.
  - Overview Trust card: a 12-point sparkline/bar strip of `trust_trend` (SVG, theme tokens), latest number, "Based on {n} accounts".
  - Account Source trust tile: `title`/tooltip from `breakdown` when present.
- [ ] **Step 1: Failing tests:** tree shows "72" and a bar for a rated source and "Not enough data yet" for a new one; `?trust=high` hides a 65 source; legend text present; stat tile shows the number; Overview card shows "Updated nightly" and "Based on 12 accounts"; account tile exposes "Person 0.64, agent 0.71, vendor 0.55"; weights note new copy (update `scoring.test.tsx:92`); `source-page.test.tsx` updated.
- [ ] **Step 2: Run** `cd web-ui && npx vitest run src/features/sources src/features/account src/features/settings/scoring` — FAIL. **Step 3: Implement.** **Step 4:** PASS; `npm run lint`, `npm run typecheck` in web-ui.
- [ ] **Step 5: E2E:** after `backfillTrust` in prepare-db, the Sources page shows a Trust number or "Not enough data yet" for the seeded person source, and the Trust filter narrows the tree. Run the e2e suite — PASS.
- [ ] **Step 6: Commit** `feat(web-ui): source trust on Sources, the source page and the account page`.
