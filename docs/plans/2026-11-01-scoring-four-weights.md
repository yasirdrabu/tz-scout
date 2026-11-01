# Four-Weight Scoring Model (Decision 21) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scores become a weighted blend of Fit, Buying intent, Revenue potential and Source trust with
one cutoff per tier and a new Nurture tier, editable on Settings > Scoring weights.

**Architecture:** Pure domain functions in `src/modules/scoring/domain/` change first (with the SCO-E6
worked examples as unit tests), then the profile (migration 0002), the scoring pipeline, the profile API
with a preview, the tier consumers in other modules, and finally the §21f screen.

**Tech Stack:** TypeScript, Drizzle (scoring schema), Hono, React + TanStack Query, Vitest, MSW.

**Spec:** `docs/spec/scoring-and-matching/four-weight-model.md` (SCO-E6, binding; it wins over SCO-E1
to E5 where they differ); screen `docs/spec/web-ui/screens.md` §21f; `docs/spec/web-ui/api-gaps.md`
Decisions 21 and 22. Code map: `docs/plans/2026-11-01-scoring-four-weights.map.md`.

## Global Constraints

- Default weights Fit 40, Buying intent 25, Revenue potential 15, Source trust 20; each 0 to 60 in steps
  of 5; sum 100.
- Default cutoffs Act now 75, Good fit 55, Watch 35; strictly descending; Act now ≤ 100; Watch ≥ 1.
- Tiers ascending (rank is `TIERS.indexOf`): `not_fit`, `nurture`, `watch`, `good_fit`, `act_now`.
  Label "Nurture".
- Not a fit = disqualified only. Act now also needs a research or trigger hit.
- Priority = min(100, best score + warm points capped by `warm_intro_cap`); none for Not a fit; no trust modifier.
- Score capped at fit when fit < 50. Hard-miss cap 45 unchanged.
- Revenue reference = base until the R3 win analysis (won deals have no practice).
- Validation copy: "Weights add up to {n}. Make them add up to 100." / "Act now has to start higher than
  Good fit." / "Good fit has to start higher than Watch."
- Rescore footnote (Decision 22, screens §21f) and toast "Rescoring started." verbatim from screens.md.
- Modules talk only through `index.ts`/contracts; `tests/unit/boundaries.test.ts` stays green.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A tenant's hand-set tier (`tier_override`) survives the rescore, including a hand-set `nurture`.
2. The migration on a database with existing scores: old `tier_thresholds` rows become the new defaults,
   and reading an `account_score` written by the old model (non-zero `trust_modifier`) doesn't crash.
3. `nurture` reaching consumers that switch on tier: playbook recommendation (treat like watch), the
   brief draft gate (Act now and Good fit only), HubSpot `taazaa_tier` ("Nurture" option and map), queue
   tier tabs (lowest tabs shown only with a count).
4. Preview never writes (no `score_change`, no event, same `account_score.version`).
5. Weight edge cases: a weight of 0 (that score ignored), a weight of 60, cutoffs at 100/99/1.

---

### Task 1: Domain model

**Files:** `src/modules/scoring/contracts/types.ts`, `domain/combine.ts`, `domain/tiers.ts`,
`domain/priority.ts`, `domain/best-offer.ts`, create `domain/revenue.ts`, `src/modules/scoring/defaults.ts`
(DEFAULT_PROFILE); tests `tests/unit/scoring/{combine,tiers,priority,best-offer,revenue}.test.ts`.

**Interfaces (produces):**
- `TIERS = ['not_fit','nurture','watch','good_fit','act_now']`, `TIER_NAMES.nurture = 'Nurture'`.
- `ScoringProfile` drops `fitWeight`, `intentWeight`, `trustModifierMax`, `tierThresholds`, gains
  `weights: { fit; intent; revenue; trust }` (integers) and `tierCutoffs: { actNow; goodFit; watch }`.
  `trustNeutral` stays (default trust 0.6).
- `matchScore(s: { fit; intent; revenue; trust }, profile): { score: number; cappedAtFit: boolean }`
  (replaces `matchTotal`).
- `revenuePotential(input: { typicalDealCents: number|null; priceMinCents: number|null; expansionRate:
  number|null; sizeMin: number|null; sizeMax: number|null; employees: number|null; referenceCents:
  number|null }): { score: number; cents: number|null; band: RevenueBand|null; reason: string|null }`
  (reason `'no_deal_size'` when no base; reference null → base).
- `trustScore(trust: number|null, profile): number` = round((trust ?? trustNeutral) × 100).
- `tierFor({ score, disqualifiedReason, hasResearchOrTrigger }, profile): Tier`.
- `priority({ score, finalTier, warmPoints }, profile): { priority; warmPoints }` (no trust).
- `Match` gets `score` in place of `total` (rename every use).

- [ ] Step 1: replace the old combine/tier/priority worked examples with SCO-E6-S1 AC1-AC5, S2 AC1-AC3
  (AC1 with `referenceCents` 4,800,000 passed in), S3 AC1-AC3; tiers for each cutoff boundary
  (75 with trigger = act now, 74 = good fit, 55 = good fit, 54 = watch, 35 = watch, 34 = nurture);
  best offer ranks nurture above not_fit.
- [ ] Step 2-4: fail, implement, `npm run test:unit -- scoring` passes (typecheck will fail in services:
  fine until Task 3; keep the domain compiling).
- [ ] Step 5: commit `feat(scoring): four-weight model and the Nurture tier in the domain`.

### Task 2: Profile migration and service

**Files:** `src/modules/scoring/db/schema.ts`, migration `0002_four_weights.sql` (via
`drizzle/scoring.config.ts`), `services/profile.ts`, `defaults.ts`; tests
`tests/integration/scoring/{profile,defaults}.test.ts`.

- Migration: add `weights jsonb not null default '{"fit":40,"intent":25,"revenue":15,"trust":20}'`,
  `tier_cutoffs jsonb not null default '{"actNow":75,"goodFit":55,"watch":35}'`; drop `fit_weight`,
  `intent_weight`, `trust_modifier_max`, `tier_thresholds`; add `revenue_score integer` and
  `trust_score integer` (nullable) to `offer_match` and `account_score`.
- `updateProfile` validation per Global Constraints (paths `weights`, `tier_cutoffs.act_now` etc.;
  messages verbatim); `KEYS` and audit cover the new fields.
- [ ] Steps 1-5 (tests: defaults, each validation message, save bumps version and publishes
  `scoring.rules.changed`). Commit `feat(scoring): weights and tier cutoffs in the profile`.

### Task 3: Scoring pipeline, explanation, tiles, hand-set tiers

**Files:** `services/score.ts` (`toScoringOffer` copies `typicalDealCents`, `priceMinCents`,
`expansionRate`, size range; compute revenue and trust scores per match; write `revenue_score`,
`trust_score`, `revenue_potential_cents`, `revenue_band`, `trust_modifier` 0; publish `revenueBand`),
`domain/explain.ts` (four score lines "Fit 82 × 40%"; trust modifier line removed; warm intro line kept),
`domain/tiles.ts` (Revenue potential and Source trust values out of 100 with reasons; Priority note
"Act now starts at {act_now} with a research or trigger signal."), `services/explain.ts`,
`services/last-rescore.ts` (weights text "Fit 40%, buying intent 25%, revenue potential 15%, source trust
20%"), `services/tier.ts` (accept `nurture`); tests `tests/integration/scoring/{score,rescore}.test.ts`,
`tests/unit/scoring/{explain,tiles}.test.ts`.

- [ ] Steps 1-5: an account scored end to end has the S1-AC1 numbers; a hand-set tier survives a
  `rules_changed` rescore; revenue band published. Commit `feat(scoring): score accounts with four weights`.

### Task 4: API and CLI

**Files:** `src/http/routes/v1/scoring/profile/{route,schema}.ts` (GET adds `weights`, `tier_cutoffs`,
`defaults`; PUT body takes `weights`, `tier_cutoffs` and drops the removed fields), create
`src/http/routes/v1/scoring/profile/preview/route.ts` or the colon action on the profile route following
how `idAndAction`-style actions are mounted (`POST /api/v1/scoring/profile:preview`), service
`previewProfile(ctx, draft): Promise<{ before: Record<Tier, number>; after: Record<Tier, number>;
samples: Array<{ account_id; name; fit; intent; revenue; trust; score_before; score_after; tier_before;
tier_after }> }>` (accounts scored in the last 90 days; 8 samples, those whose tier changes first, then
highest priority; uses stored per-match inputs, no writes); `src/entry/cli.ts` `rescore [--tenant <slug>]`
(every active tenant otherwise, via `requestRescore`); `src/http/routes.ts` + routes test.
Tests `tests/integration/v1/scoring.test.ts`, `tests/integration/entry/cli.test.ts`.

- [ ] Steps 1-5: preview writes nothing (Review Focus 4); validation 400 bodies; CLI rescores two tenants.
  Commit `feat(api): scoring weights, cutoffs and preview`.

### Task 5: Tier consumers in other modules

**Files:** `src/modules/crm/defaults.ts` and `crm/adapters/hubspot/properties.ts` ("Nurture" option and
map), `src/modules/playbooks/domain/brief-io.ts` (enum), `playbooks/domain/recommendation.ts` (nurture as
watch), brief fixtures, `src/modules/offers/contracts/ports.ts` comment; run the whole suite and fix tests
that hard-code the old tier list or profile shape (list in the code map §4).
- [ ] Steps: `npm run typecheck && npm run lint && npm test` green. Commit `feat: Nurture tier across modules`.

### Task 6: Scoring weights screen (§21f)

**Files:** `web-ui/src/app/nav.ts` (un-hide `scoring-weights`, tag R1), create
`web-ui/src/features/settings/scoring/{ScoringWeights.tsx,api.ts,scoring.test.tsx}` and its route in the
settings router; `web-ui/src/features/review/parts.tsx` + `Review.module.css` (`nurture` chip look);
`QueueScreen.tsx` (low tabs: Nurture and Not a fit shown only with a count or when selected);
`RescoreBanner.tsx` (`Open settings` link now that the tab exists).
Screen per screens.md §21f: four sliders (0 to 60, step 5) with what feeds each, total chip "Adds up to
100" or the warning with `Balance to 100` (scales the others proportionally to 100 in steps of 5,
largest remainder), three cutoff inputs with the ordering rule text, "What changes" from the preview
(debounced 400 ms on draft change), `Restore defaults`, `Discard`, `Save and rescore` (toast), footnote.
- [ ] Steps: tests for slider total, Balance to 100, invalid cutoff message, preview table, save PUT
  body and toast, read-only without `scoring:manage` (tab hidden). `cd web-ui && npm test && npm run build`.
  Commit `feat(web-ui): scoring weights settings`.

### Task 7: Docs, full suite, local verify

- [ ] `docs/spec/web-ui/api-gaps.md` (§21f rows READY, open questions 3 and 4 answered by SCO-E6),
  `screens.md` §21f tag; score strip copy for Revenue and Trust in §4a.
- [ ] Full suite plus `npm run e2e`.
- [ ] `scout-verify`: migrate, `scout rescore`, open Settings > Scoring weights, change a weight, see the
  preview, save, see tiers move in the queue. Commit `docs: four-weight scoring is live`.
