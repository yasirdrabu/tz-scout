# Configurable Pipeline Stages (Decision 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each workspace names, orders and maps its own pipeline stages, picks what moves an account
into each, and can move an account by hand; every screen and HubSpot follow.

**Architecture:** A pure domain module in routing (`domain/pipeline.ts`) holds the stage model, the
trigger list, validation and the movement rule that replaces `nextStage`. A tenant table
`routing.pipeline_stage` (seeded with today's keys under the mockup names) feeds it. Every event call
site maps to a trigger; every read that hard-coded stages reads the workspace's list. The CRM deal
poller also reports stage-only changes.

**Tech Stack:** TypeScript, Drizzle (routing, crm schemas; RLS), NATS events, Hono, React + TanStack Query, Vitest, MSW.

**Spec:** `docs/spec/review-and-routing/configurable-stages.md` (REV-E5, binding; wins over REV-E4);
screens `docs/spec/web-ui/screens.md` §21e, §4 tracker, §8; decision `docs/spec/web-ui/api-gaps.md`
Decision 6. Code map: `docs/plans/2026-11-01-pipeline-stages.map.md`.

## Global Constraints

- Default stages, keys, names, triggers, HubSpot stages and locks exactly as REV-E5 "Defaults".
- Locked first stage key `arrived`, locked won stage key `won`; both keys permanent.
- Trigger keys, labels and "at most" limits exactly as REV-E5 "Triggers".
- Flow stages move forward only on events; the three exceptions in REV-E5 "Movement rules" only.
- Validation sentences verbatim: "Every stage needs a name."; "The first stage and the won stage can be
  renamed but not deleted."; "Only one stage can move when {trigger label lowercased}." (e.g. "Only one
  stage can move when an AE accepts the assignment."); "A stage that moves on a HubSpot deal stage needs
  that HubSpot stage."; "Two stages can't share a name.".
- Toast "Pipeline stages saved. The pipeline and scorecard use them now."
- `Move to stage`: `POST /api/v1/accounts/{id}:move-stage`, `review:act`, people only.
- Settings: `GET /api/v1/stages` (`accounts:read` or `status:read`); `PUT /api/v1/settings/stages`
  (`settings:manage`, people only).
- Modules talk only through `index.ts`/contracts; `tests/unit/boundaries.test.ts` stays green.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. With default stages every existing REV-E4 movement test passes unchanged (same keys, same moves).
2. Deleting a stage that holds accounts: they move per REV-E5, each with a history row; deleting the
   stage an account is "in the middle of" (an assignment pending acceptance) leaves no account on an
   archived key.
3. History after a rename shows the old name for old moves (`from_name`/`to_name`), including rows
   backfilled by the migration.
4. Workspace isolation of `pipeline_stage` (RLS and every query) and of the stage cache, if any.
5. A HubSpot deal changing only its stage publishes `crm.deal.changed` once (not on every poll).

---

### Task 1: Pipeline domain

**Files:** create `src/modules/routing/domain/pipeline.ts`; modify `routing/contracts/types.ts` (stage
becomes `string` key with `stageKeySchema`; keep `STAGES` only as the default keys), `routing/domain/stages.ts`
(keep `StageEvent`; `nextStage` delegates to the new rule with default stages, or is removed once all
callers move in Task 3); tests `tests/unit/routing/pipeline.test.ts`.

**Interfaces (produces):**
- `TRIGGERS` (const list of `{ key, label, limit: 'first' | 'won' | 'one' | 'many' }`), `type Trigger`.
- `type PipelineStage = { key; name; description: string|null; kind: 'flow'|'exit'; position: number;
  trigger: Trigger; hubspotStage: string|null; quarterTarget: number|null; locked: 'first'|'won'|null }`.
- `DEFAULT_STAGES: PipelineStage[]`.
- `type StageSignal = { trigger: Trigger; hubspotStage?: string } | { kind: 'reopened' } | { kind:
  'assignment_undone' } | { kind: 'by_hand'; to: string }` (what an event means for stages).
- `moveFor(current: string, signals: StageSignal[], stages: PipelineStage[]): string | null` — the
  target key or null (no move), implementing REV-E5 "Movement rules".
- `validateStages(next: PipelineStageInput[], prev: PipelineStage[]): { path: string; message: string }[]`.
- `planDeletion(prev, next): { archived: string[]; moveTo: (key: string, history: string[]) => string }`
  (where accounts on archived stages go).
- `stageRank(stages)`: map key → sort rank (flow by position, then exits) for `stage_priority`.

- [ ] Step 1: tests: REV-E4 equivalence table — for every `StageEvent` and every default stage, old
  `nextStage` result equals `moveFor` with defaults; REV-E5-S2-AC2/AC3/AC4; meeting fires both
  `reply_or_meeting` and `meeting_booked` → furthest; exits only from flow (not won); reopen → first;
  assignment undone → `reviewer_sets_tier` stage; deal open from the `deal_closed_lost` exit →
  `deal_created` stage; by-hand anywhere; each validation sentence; deletion targets (flow → previous
  flow stage; exit → stage before entering from history, else first).
- [ ] Steps 2-4: fail, implement, `npx vitest run --project unit tests/unit/routing` passes.
- [ ] Step 5: commit `feat(routing): pipeline stage model and movement rules`.

### Task 2: Stage table, history names, seeding

**Files:** `routing/db/schema.ts` (`pipelineStage`; `stageChange.fromName`, `toName`, `by`, `note`),
migration `routing/db/migrations/00NN_pipeline_stages.sql` via `drizzle/routing.config.ts` (table + RLS
like other tenant tables; insert defaults for every existing tenant; backfill `from_name`/`to_name` from
today's labels: arrived→"Arrived", reviewed→"Reviewed", assigned→"Assigned", engaged→"Engaged",
opportunity→"Opportunity", won→"Won", lost→"Lost", declined→"Not pursued" — history keeps the names it
had); seeding for new tenants (find how other modules seed per-tenant defaults on tenant creation, e.g.
`seedCrmDefaults` / tenant-created consumers, and do the same); service `services/pipeline.ts`
`loadStages(ctx): Promise<PipelineStage[]>` (live, ordered); tests `tests/integration/routing/pipeline-stages.test.ts`.

- [ ] Steps: tests for seeding (new tenant has defaults; existing tenant after migration has defaults),
  backfilled names, RLS isolation. Commit `feat(routing): stages per workspace`.

### Task 3: Movement engine on workspace stages, and Move to stage

**Files:** `routing/services/stage.ts` (`moveStage(ctx, accountId, signals, causeId, opts?)` loads
stages, uses `moveFor`, writes `from_name`/`to_name`/`by`/`note`), every caller in `review.ts`,
`respond.ts`, `assign.ts`, `crm-events.ts` mapped to signals (table in REV-E5 "Triggers"); `review.ts`
`ensureReview` starts at the locked first stage; create `services/move-stage.ts` + route
`src/http/routes/v1/accounts/[id]/...` colon action `:move-stage` (follow how other account colon actions
are mounted); `routing.stage.changed` event schema: `from`/`to` become stage keys (strings) plus
`fromName`/`toName`; check every consumer of that event (accounts summary, playbooks) still works.
Tests: the existing routing integration suites unchanged and green; new tests REV-E5-S2-AC2,
REV-E5-S4-AC1/AC2.

- [ ] Commit `feat(routing): stages move by each workspace's triggers`.

### Task 4: Reads use the workspace's stages

**Files:** `routing/services/pipeline.ts` (facets tabs, "Other", `wonThisYear` on the won stage),
`routing/services/account-review.ts` (tracker steps from live flow stages + current exit; labels from
stages; change log uses `from_name`/`to_name`), `accounts/services/search.ts` (`stage_priority` from
`stageRank`, passed in or read through routing's index — respect boundaries), `intake/services/source-read.ts`
(source funnel: Assigned = at or past the `ae_accepts` stage), `http/routes/v1/sources/stats/route.ts`,
`scoring/services/offer-usage.ts` (won = key `won`), batch row stage labels, CSV labels; create
`GET /api/v1/stages`. Tests: existing suites green; new: renamed stage label shows in facets, tracker
and CSV; added stage gets a tab; archived stage disappears.

- [ ] Commit `feat: pipeline, tracker and funnels read each workspace's stages`.

### Task 5: Edit stages

**Files:** `routing/services/pipeline.ts` `saveStages(ctx, input)` (validate, diff, archive deleted and
move their accounts with cause `stage_deleted`, upsert, audit `routing.stages.changed` before/after,
publish `routing.stages.changed`), `restoreDefaults` semantics per REV-E5; routes `GET/PUT
/api/v1/settings/stages`. Tests REV-E5-S1 AC1-AC5, S5-AC1, Review Focus 2-3.

- [ ] Commit `feat(api): edit pipeline stages`.

### Task 6: HubSpot deal stages

**Files:** `crm/services/deals.ts` (publish `crm.deal.changed` when `stage` changes too),
`routing/services/crm-events.ts` (open deal → `deal_reaches_stage` stage with matching `hubspot_stage`,
else `deal_created`), tests REV-E5-S3 AC1/AC2 with the mock HubSpot adapter, Review Focus 5.

- [ ] Commit `feat(crm): a HubSpot deal stage moves the account`.

### Task 7: Web-ui

**Files:** `web-ui/src/app/nav.ts` (un-hide `pipeline-stages`, tag R1), create
`web-ui/src/features/settings/stages/{PipelineStages.tsx,api.ts,stages.test.tsx}` per screens.md §21e
and the mockup notes in the code map §5 (two tables Stages and Exits; columns Name, What it means, Moves
here when, HubSpot stage, Quarter target; Move up/down, Delete; Add stage before Won, Add exit; Restore
defaults, Discard, Save stages; header and footer copy from the code map §5; errors from the API's
`errors[]` next to the field); `features/account/StageTracker.tsx` (drop the hard-coded `reviewed`/
`arrived` check: "Waiting on you" shows on the step after the current one when it is the
`reviewer_sets_tier` stage and the viewer has `review:act`); a `Move to stage` control on the account page
(menu of live stages, optional note, `review:act` only; toast "{account} moved to {stage}."). Tests for
each.

- [ ] Commit `feat(web-ui): pipeline stages settings and Move to stage`.

### Task 8: Docs, suites, local verify

- [ ] `api-gaps.md` (Decision 6 status, §21e rows READY), `screens.md` §21e tag, `index.md` C6 status.
- [ ] Full suites + e2e.
- [ ] `scout-verify`: migrate; rename Engaged to "Talking", add "Proposal" (Set by hand) before Won, save;
  see tabs and tracker; move an account to Proposal by hand; history shows it. Restore defaults.
- [ ] Commit `docs: pipeline stages are configurable`.
