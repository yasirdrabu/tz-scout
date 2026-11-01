# Scoring map (worktree C:\dev\tz-scout-scoring). Paths relative to repo root. Facts only.

## 0. Spec key points (docs/spec/scoring-and-matching/four-weight-model.md = SCO-E6)
Weights default fit40/intent25/revenue15/trust20 (0-60 step 5, sum 100); cutoffs act_now75/good_fit55/watch35; 5 tiers add nurture;
GET /scoring/settings, POST /scoring/settings:preview, PUT /scoring/settings; rescore all via scoring.rules.changed; "scout rescore --all" mentioned.

## 1. Domain (src/modules/scoring/domain)
### combine.ts
- matchTotal(fit: number, intent: number, profile: ScoringProfile): { total: number; cappedAtFit: boolean }  :9. Blend normalised by fitWeight+intentWeight; POOR_FIT=50 cap (:6).
### priority.ts
- priority(input: { matchTotal: number; finalTier: Tier; warmPoints: number; trust: number|null }, profile: ScoringProfile): { priority: number; warmPoints: number; trustModifier: number }  :9. not_fit -> priority=matchTotal, no warm, trustModifier 0 (:13). trustModifier = clamp(round((trust - trustNeutral)*25), +-trustModifierMax) (:15-18). Private helpers roundHalfAway, clamp.
### tiers.ts
- TierInput = { fit; intent; total; disqualifiedReason: string|null; hasResearchOrTrigger: boolean }  :8
- tierFor(input: TierInput, profile: ScoringProfile): Tier  :18. not_fit if disqualified OR fit < tierThresholds.notFitBelow (:21); act_now if fit>=actNow.fit && intent>=actNow.intent && total>=actNow.total && hasResearchOrTrigger (:22); good_fit if fit>=goodFit.fit; else watch.
- ResearchTier = 'A'|'B'|'C' :26; FloorInput = { disqualified: boolean; researchTier: ResearchTier|null; researchSignalAt: Date|null; warmIntro: boolean; bestFit: number } :28
- applyFloors(computed: Tier, input: FloorInput, profile: ScoringProfile, now: Date): { tier: Tier; tierReason: TierReason; text?: string }  :43. Rank via TIERS.indexOf (higher :39). Research floor: A->act_now if signal within researchFloorDays else good_fit, B->good_fit, C->watch; warm intro floor -> good_fit if bestFit>=40 (WARM_INTRO_MIN_FIT :7). Private TIER_LABEL record :8 (4 tiers, lowercase labels).
### best-offer.ts
- bestOffer(matches: Match[], approvedOrder: string[]): Match | null  :6. Sort total desc, TIERS.indexOf desc, fit desc, approved order.
### tiles.ts
- ScoreTile = { key: string; label: string; value: number|null; max: 100|null; note: string } :6; NO_DATED_SIGNALS const :8
- scoreTiles(e: { priority; fit; intent; lines: ExplanationLine[]; offer: string|null; datedSignals: number }, thresholds: TierThresholds): ScoreTile[]  :22. Keys: priority (note built from actNow.total/fit/intent :32), fit, intent, revenue_potential (value null, "Arrives with enrichment" :36), source_trust (null, "Not enough data yet" :37).
- warmIntro(lines: ExplanationLine[]): { introducerName: string|null; points: number } | null  :41
### explain.ts
- consts HARD_MISS_CAP=45 :8, NO_OFFER_TEXT :10; dateText(d: Date): string :64
- types ExplanationLine :13, Explanation :27, ExplanationInput :41 (profile = Pick of fitWeight,intentWeight,warmIntroCap,trustModifierMax,halfLifeDays,maxSignalAgeDays; priority has trustModifier; trust {value,sourceName}|null)
- missingInputs(parts: FitResult['parts']): string[] :67 ; intentText(...) :74
- matchText(fit: number, intent: number, profile: Pick<ScoringProfile,'fitWeight'|'intentWeight'>): string :89 -> "55% fit (x) and 45% intent (y)."
- buildExplanation(input: ExplanationInput): Explanation :95. Line groups fit/intent/combine/adjust. Hard miss :130, Low fit :131, Match :132, Tier :133, Warm intro adjust line :136-142, Source trust adjust line (label "Source trust 0.xx (name)", points=trustModifier, only if !=0) :143-150.
- wouldRaise(explanation: Explanation, offer: ScoringOffer, account: ScoringAccount): string[] :156
- summarySentence(explanation: Explanation): string :173
- causeInWords(cause: string): string :200 (CAUSE_WORDS keyed by ScoreCause)
### fit.ts exports
- norm(s) :5, industryMatches(target, actual) :8, titleMatches(title, targets) :42, FitResult = { fit; parts: FitPart[]; disqualifiedReason: string|null; hardMiss: boolean } :51, fit(account: ScoringAccount, offer: ScoringOffer, profile: ScoringProfile): FitResult :63
### others: intent.ts exports CURRENT_STATE, researchScore, signalDate, recency, intent(...) :82; inputs-hash.ts inputsHash(inputs: Record<string,unknown>): string :14.

### contracts/types.ts (src/modules/scoring/contracts/types.ts)
- TIERS = ['not_fit','watch','good_fit','act_now'] as const :8 (ascending; indexOf is rank); tierSchema = z.enum(TIERS) :9; type Tier :10
- TIER_NAMES: Record<Tier,string> :13 {act_now:'Act now', good_fit:'Good fit', watch:'Watch', not_fit:'Not a fit'}
- Match = { offerId; fit; intent; total; tier: Tier } :16; TIER_REASONS computed|research_floor|warm_intro_floor :18
- revenueBandSchema = z.enum(['low','medium','high']) :21 (RevenueBand)
- tierThresholdsSchema :32 = { notFitBelow:number; actNow:{fit,intent,total}; goodFit:{fit} }; type TierThresholds :37
- ScoringProfile :40 = { fitWeight; intentWeight; fitParts: FitParts; halfLifeDays; maxSignalAgeDays; tierThresholds: TierThresholds; warmIntroCap; trustModifierMax; trustNeutral; researchFloorDays }
- ScoringOffer :80 has no deal-size/price/expansion fields (id, industries, excluded*, companySize*, revenue*Cents, regions, targetTitles, targetBuyingRoles, rules). ScoringAccount :56. SCORE_CAUSES :3 includes rules_changed, manual_rescore, tier_override.
- contracts/events.ts: accountScored ('scoring.account.scored' v1; tier: tierSchema, previousTier nullable, revenueBand: revenueBandSchema.nullable, fit, intent, priority) :6; rulesChanged ('scoring.rules.changed' v1 {profileVersion, changed[], changedBy}) :26.
- Public index src/modules/scoring/index.ts exports TIERS, TIER_NAMES, Tier, TierThresholds, RevenueBand, DEFAULT_PROFILE, getProfile/updateProfile/resetProfile (ProfileView = ScoringProfile & {version}), requestRescore, scoreAccount, setTierOverride, etc.

### Where things are used
- trust modifier: domain/priority.ts:15-19; explain.ts:50,54,133-139; services/score.ts:170,253 (writes account_score.trust_modifier); profile.ts KEYS + problems (trustModifierMax 0-10); defaults.ts:15 (5); db/schema.ts:23,71.
- fitWeight/intentWeight: combine.ts:9-10; explain.ts:50,89-92; services/last-rescore.ts:30,50 (banner weightsText "Fit 55%, buying intent 45%"); profile.ts (0-1 ratios, not both 0); db/schema.ts:16-17; defaults.ts:8-9 (0.55/0.45); http profile/schema.ts:10-11.
- tier thresholds: tiers.ts:20; tiles.ts:24,32; services/explain.ts:137; profile.ts merge + validation (tierThresholds 0-100); defaults.ts:13 ({notFitBelow:40, actNow:{fit:60,intent:35,total:60}, goodFit:{fit:60}}); db/schema.ts:21 (jsonb); http profile/schema.ts:14-26.
- trustNeutral: priority.ts:18 only (default 0.6).
- Revenue potential: NOT computed anywhere. db/schema.ts:82-83 account_score.revenue_potential_cents (bigint) / revenue_band, comments "null until R2"; score.ts never writes them; accountScored published with revenueBand: null (score.ts, tier.ts); tiles.ts:36 placeholder. No median-won-deal code exists.
  Data available: offers table src/modules/offers/db/schema.ts:60-65 priceMinCents, priceMaxCents, typicalDealCents, expansionRate, expansionValueCents (+companySizeMin/Max :67-68); ApprovedOffer = Offer & {signalRules} (offers/services/signal-rules.ts:13) so carries them, but toScoringOffer (score.ts:63) does not copy them. Won deals: crm.deal (src/modules/crm/db/schema.ts:170-190: accountId, status open|won|lost, amountCents, closedAt; no practice/offer column). crm/index.ts exports pollDeals/applyDeals only; no median query. offers/db/schema.ts:20 comment "won deals arrive in later releases".
- Source trust: score.ts calls bestTrustForAccounts(ctx, chainIds) from @/modules/intake -> {trust, sourceId, sourceName}|null (stored account_score.trust, trust_source_id).

## 2. Services (src/modules/scoring/services)
### profile.ts
- ProfileView; getProfile(ctx: ModuleContext): Promise<ProfileView> :16 -> select row by tenantId; no row => {...DEFAULT_PROFILE, version: 0}.
- ProfilePatch :44 (Partial of ScoringProfile; fitParts/tierThresholds partial-merge); KEYS :52 (changed-field detection); problems(p) :70 private validator returning {path,message}[].
- updateProfile(ctx: ModuleContext, patch: ProfilePatch): Promise<ProfileView> :89. Advisory lock ":scoring-profile"; merges; validates (throws ScoutError slug 'validation' 400 with errors[]); no-op if nothing changed; upsert row with version+1, updatedBy/updatedAt; publish(rulesChanged); audit('scoring.profile.updated', before/after of changed keys).
- resetProfile(ctx): Promise<ProfileView> :114 = updateProfile(ctx, DEFAULT_PROFILE).
- Defaults: seedScoringDefaults (defaults.ts:20: insert onConflictDoNothing + nightly ageing schedule 0 2 * * * UTC) run by scoringTenantDefaults consumer (consumers.ts).
### score.ts
- scoreAccount(ctx, accountId: string, cause: ScoreCause, causeEventId?: string, opts: ScoreOptions = {}): Promise<{changed:boolean; score: AccountScore}> :87. ScoreOptions {now, profile, offers, alsoAccountIds}. Also exports toScoringAccount :37, toScoringSignals :50, toScoringOffer :63 (reused by services/explain.ts).
- Pipeline: lock -> getAccountForScoring -> getProfile (:109) -> listApprovedOffers(ctx,{practiceIds}) (:110) -> getWarmIntro, bestTrustForAccounts (:114-115) -> inputsHash over profile/account/signals/offers/research/warm/trust (:122-133; same input same day => no write :140) -> per offer (:147-163): fit() :149, intent() :150 (skipped if disqualified), matchTotal() :151, tierFor() :152 (hasResearchOrTrigger = hits.some(kind!=='pain')) -> bestOffer() :167 -> applyFloors() :189 -> priority() :202 -> buildExplanation() :203 -> delete+insert offer_match rows (:226-245: fit,intent,matchTotal,tier,fitParts,ruleHits,disqualifiedReason) -> upsert account_score (:247-275; tier = tierOverride ?? tier, scoredTier, trustModifier, matchTotal) -> if priority/tier/scoredTier/bestOffer moved: insert score_change (cause) + publish accountScored (revenueBand:null).
- offer_match has no columns for revenue/trust scores.
### rescore.ts
- RESCORE_PAGE_SIZE=200; rescoreAccounts(ctx, accountIds: string[], cause: ScoreCause): Promise<void> :24 (profile+offers loaded once, savepoint per account); rescorePage(ctx, filter: RescoreFilter, cause, afterId?) :60; startRescore(ctx, filter, cause): Promise<string> :68; requestRescore(ctx, filter: {practiceId?; sourceId?} = {}): Promise<string> :72 (cause manual_rescore); ageingPage(ctx, afterId, now) :82.
- Tenant-wide on profile change: consumers.ts ~:141 rescoreOnRulesChanged (event rulesChanged -> startRescore(ctx, {}, 'rules_changed')). Other consumers: offer changed (offer_changed), source trust (trust_changed).
- CLI: NO "scout rescore" command. src/entry/cli.ts USAGE :16-35 lists migrate, seed, import, backfill-r1b/r1c/review-flow (case 'backfill-r1b' :184). backfillR1b (src/entry/seed.ts ~:99-103) calls requestRescore(ctx) tenant-wide; seed.ts:27 imports it. CLI test: tests/integration/entry/cli.test.ts.
- Jobs: src/modules/scoring/jobs.ts (rescoreAccountsHandler, rescorePageHandler, ageingHandler); contracts/jobs.ts (RescoreFilter {sourceId,offerId,practiceId,includeNoPractice}); registered src/entry/worker.ts:29.
### tier.ts
- TierView :12; setTierOverride(ctx, accountId: string, input: { tier: string|null; note?: string|null }): Promise<TierView> :49. Validates tier in TIERS (:54); writes account_score.tier/tierOverride/By/At/Note, score_change cause 'tier_override', publishes accountScored (revenueBand null), audit 'scoring.tier.changed'. People only (ctx.access.userId).
### others: read.ts (getScore, getMatches, getScoreHistory, tierDetails/TierDetail), explain.ts (explainScore -> ScoreExplanation incl. tiles :135 using explanation.priority, fit, intent, profile.tierThresholds), last-rescore.ts (lastRescore, reads fitWeight/intentWeight), offer-usage.ts.

## 3. Migrations
- Dir src/modules/scoring/db/migrations/: 0000_scoring_schema.sql, 0001_tier_override.sql (latest = 0001; next 0002); meta/ has 0000_snapshot.json, 0001_snapshot.json, _journal.json.
- Drizzle config: drizzle/scoring.config.ts (schema src/modules/scoring/db/schema.ts; out src/modules/scoring/db/migrations; schemaFilter ['scoring']; migrations table scoring.__migrations). Siblings: drizzle/{accounts,ai,crm,intake,integrations,offers,platform,playbooks,routing,tenancy}.config.ts.
- Schema db/schema.ts: scoring_profile (fit_weight :16, intent_weight :17 ratio; fit_parts jsonb :18; tier_thresholds jsonb :21; trust_modifier_max :23; trust_neutral :24); offer_match (match_total :41; tier text :42, comment lists 4 values); account_score (match_total :65, trust :69, trust_modifier :71, tier :73, tier_reason :74, scored_tier :76, tier_override* :78-81, revenue_potential_cents :82, revenue_band :83); score_change (from_tier :102, to_tier :103). No SQL CHECK on tier values found in any module migration/schema.
- Other-module tier storage: accounts account_summary.tier (text, fed by accountScored consumer src/modules/accounts/consumers.ts); playbooks/consumers.ts also consumes accountScored.

## 4. Tier values outside src/modules/scoring
Backend:
- src/modules/crm/defaults.ts:8 TIER_LABELS {act_now,good_fit,watch,not_fit} -> enum_map transformConfig :16 for HubSpot taazaa_tier (nurture would be unmapped)
- src/modules/crm/adapters/hubspot/properties.ts:17 TIER_OPTIONS ['Act now','Good fit','Watch','Not a fit']; :22 taazaa_tier options + description
- src/modules/playbooks/domain/brief-io.ts:25 const tier = z.enum(['not_fit','watch','good_fit','act_now']) (briefInputSchema score.tier; fixtures tests/unit/playbooks/fixtures/briefs/*.json)
- src/modules/playbooks/domain/recommendation.ts:52 act_now|good_fit -> approve/assign; :56 watch -> keep in review; fallthrough (:61+) "Send it back or decline it" (nurture would land there)
- src/modules/playbooks/services/draft.ts:18 CLAUDE_TIERS = Set(['act_now','good_fit']); :39 gate
- src/modules/playbooks/services/inputs.ts:6,11,68,113 (Tier type, TIER_NAMES[tier] -> tierLabel); domain/package.ts:104,177; domain/rules-brief.ts:68-69 (tierLabel)
- src/modules/routing/services/queue.ts:5,204 facets [...TIERS].reverse() with TIER_NAMES; :188 counts; :23,79 tier filter string
- src/modules/routing/services/pipeline.ts:5,109,174 (Object.keys(TIER_NAMES) facets),216 (CSV label)
- src/modules/routing/services/account-review.ts:4,151 tierName; routing/services/read.ts:20,47,132; routing/domain/columns.ts:6 column key 'tier'
- src/http/routes/v1/batches/[id]/items/route.ts:3,32 TIER_NAMES label
- Free-string tier plumbing (no enum): accounts/services/search.ts:24,62,184,258,312; summary.ts:42,66; read.ts:348,367; intake/services/batches-read.ts:355,421; http accounts/filters.ts:30, review-queue/filters.ts:14, review-queue/facets/route.ts; accounts/[id]/tier/route.ts:8 (z.string().nullable(), validated by TIERS in setTierOverride)
- src/modules/offers/contracts/ports.ts:6 comment "current match is not not_fit" (offers stats counts by non-not_fit)
Web-ui (labels/options come from API; hard-coded values only here):
- web-ui/src/features/review/parts.tsx:40 TIER_LOOK {act_now: tier_act, good_fit: tier_good, watch: tier_watch}; fallback tier_low for not_fit and any unknown (nurture); :42-45 TierChip
- web-ui/src/features/review/Review.module.css:286-305 .tier_act/.tier_good/.tier_watch/.tier_low
- web-ui/src/features/review/QueueScreen.tsx:134-140 tier tabs from fx.tiers; last tab (lowest) shown only if count>0 or selected (assumes last = not_fit, best-first order)
- web-ui/src/features/review/PeekDrawer.tsx:127,142,216-240 tier select options from facets; QueueTable.tsx:25
- web-ui/src/features/review/api.ts:35,54-58,73,81,85,281-282; sources/api.ts:70-71,123-129; sources/tabs/AccountsTab.tsx:31,75; batches/api.ts:56; routes/workspace.tsx:13,18,39,48,70-71 (tier in URL search); review/RescoreBanner.tsx:29,39-40
Tests that hard-code tier lists or profile shape (will break): tests/unit/scoring/{tiers,priority,best-offer,explain,combine,tiles}.test.ts; tests/unit/crm/fields.test.ts; tests/unit/playbooks/{package,recommendation}.test.ts + fixtures/briefs/*.json; tests/integration/scoring/{score,rescore,profile,defaults}.test.ts; tests/integration/v1/{scoring,offers,review-actions,review-reads,sources}.test.ts; tests/integration/routing/{queue,status}.test.ts; tests/integration/accounts/{score-summary,scoring-reads}.test.ts; tests/integration/crm/{defaults,push}.test.ts; tests/integration/offers/{delete,stats}.test.ts; tests/integration/playbooks/{draft,draft-guards,edit,handoff-package,merge,read,triggers}.test.ts; web-ui features/account/account-page.test.tsx, features/review/{peek,queue}.test.tsx + testing.ts, features/sources/{source-page.test.tsx,testing.ts}.

## 5. HTTP routes and web-ui settings
- Mounts: src/http/routes.ts:106-107 imports, :241-242 (V1/scoring/profile/reset, V1/scoring/profile); rescore and last-rescore also mounted there.
- GET /api/v1/scoring/profile: src/http/routes/v1/scoring/profile/route.ts:10, permission scoring:manage, returns getProfile (camelCase + version).
- PUT /api/v1/scoring/profile: same file :13, scoring:manage, 202, body profilePatchBody (src/http/routes/v1/scoring/profile/schema.ts: snake_case fit_weight, intent_weight, fit_parts, half_life_days, max_signal_age_days, tier_thresholds{not_fit_below, act_now{fit,intent,total}, good_fit{fit}}, warm_intro_cap, trust_modifier_max, trust_neutral, research_floor_days; strictObject partial). Route snake_cases error paths (:9,18-21).
- POST /api/v1/scoring/profile/reset: scoring/profile/reset/route.ts:6, scoring:manage, 202.
- POST /api/v1/rescore: src/http/routes/v1/rescore/route.ts:10, scoring:manage, body {practice_id?, source_id?}, 202 {jobId}.
- GET /api/v1/scoring/last-rescore: src/http/routes/v1/scoring/last-rescore/route.ts (web-ui review/api.ts:133, RescoreBanner).
- PUT /api/v1/accounts/:id/tier: accounts/[id]/tier/route.ts:10, review:act, peopleOnly.
- NO /scoring/settings or :preview route exists. Tests: tests/integration/v1/scoring.test.ts, tests/integration/scoring/profile.test.ts.
- Permission scoring:manage: src/modules/tenancy/domain/permissions.ts:24 (+ role grant :81); labels permission-labels.ts:24,61.
- web-ui hidden tab: web-ui/src/app/nav.ts:97 { tab:'scoring-weights', label:'Scoring weights', section:'21f', tag:'Redesign', rule:{all:['scoring:manage']}, hidden:true } (comment :90; SETTINGS_RULE :85; SettingsTab type :88 has hidden?); nav.test.ts:60 tests visibleSettingsTabs. RescoreBanner.tsx:29 comment says Open settings omitted because tab is hidden. pipeline-stages also hidden (:96).
- Existing scoring settings UI code in web-ui: none (scoring-weights / scoring/profile appear only in nav.ts, RescoreBanner, review/api.ts last-rescore). web-ui/src/features/settings/ holds other tabs; no scoring file.

## 6. Account page score strip
- Backend: src/modules/scoring/services/explain.ts:135 builds tiles via scoreTiles (domain/tiles.ts:22), returned in ScoreExplanation (tiles, warmIntro); served by the account score endpoint (tests/integration/v1/account-page.test.ts).
- web-ui/src/features/account/ScoreStrip.tsx:8 ScoreTile({tile}) (value "/ max" + bar + note; null value => note only), :31 ScoreStrip({tenant,id}) maps score.data.tiles :45; used in ReviewView.tsx:12,136 and AssignedView.tsx:16,112; AssignedView.tsx:120-122 also maps score.data.tiles with ScoreTile.
- Types: web-ui/src/features/account/api.ts:56 Tile = {key,label,value:number|null,max:number|null,note}, :58 AccountScore = {tiles: Tile[]; warm_intro}. Tests: web-ui/src/features/account/account-page.test.tsx; tests/unit/scoring/tiles.test.ts.

## 7. Existing tests
Unit (tests/unit/scoring/): combine.test.ts (matchTotal; "worked examples" A fit100/intent22/total65, B wrong-industry cap 45, C fit70/26/50; v1 matchAccount cases; default rules per offer), priority.test.ts (SCO-E2 ACs: 65+8+trust .72=76, clamp, not_fit, cap, trust->modifier, rounding), tiers.test.ts, best-offer.test.ts, explain.test.ts, tiles.test.ts, fit.test.ts, intent.test.ts, inputs-hash.test.ts. No test for any revenue function (none exists).
Integration: tests/integration/scoring/{score,rescore,profile,defaults}.test.ts; tests/integration/v1/scoring.test.ts; tests/integration/accounts/{score-summary,scoring-reads}.test.ts; tests/integration/intake/scoring-reads.test.ts.
E6 worked examples live only in the spec (SCO-E6-S1..S4 ACs); no tests yet. tests/unit/boundaries.test.ts enforces module import boundaries.
