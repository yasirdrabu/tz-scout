# Pipeline stages: current-state map (read-only research)

Paths relative to C:\dev\tz-scout. Backend `src/modules/...`, web-ui `web-ui/src/...`.

## 0. Spec statements
- docs/spec/web-ui/api-gaps.md:108 Decision 6: stages fully configurable (add, rename, reorder, delete, HubSpot stage, targets); routing+CRM+analytics redesign, own backend plan; "until it lands the app reads stages from the API and the editor is hidden".
- api-gaps.md:176-184 analysis: backend = fixed enum wired into nextStage(), event catalog, CRM; "no table, no labels". Options (a) fixed keys + editable labels (`routing.stage_def`, `PUT /api/v1/settings/stages`), (b) read-only `GET /api/v1/stages`, (c) fully configurable ("weeks, not advised"). Recommendation was (b); Decision 6 chose (c).
- screens.md:168 (S4 tracker: one step per stage, names/order from API), :324-336 (S8 All accounts: tabs = one per pipeline stage + All + Other; "{won} won this year"; footer "Sorted by stage, then priority"), :340-361 (S9 Overview: funnel band per stage, "{count} of {target}" + pace, "Left the pipeline" band per exit, "Configure stages" only once editor exists; before R3 funnel from stage history), :526-543 (S11 funnel by source: column per stage), :396 (source Accounts tab stage filter), :637, :747-760 (S21e editor).
- index.md:69 C6: stage names/order come from API everywhere (tracker, All accounts tabs, funnel); editable later in Settings > Pipeline stages; tab hidden until then.
- docs/spec/analytics/account-funnel-by-source.md:10-40: Analytics takes stage timestamps only from `routing.stage.changed`; a stage counts once per account at first entry; skipped stages count as passed at the later stage's time.
- docs/spec/crm-sync/follow-through-and-deals.md:49: "Engaged stage and playbook outcomes are automatic."

## 1. Where the stage set is defined (all hard-coded, no table)
- src/modules/routing/contracts/types.ts:3-5  `STAGES = ['arrived','reviewed','assigned','engaged','opportunity','won','lost','declined'] as const`; `stageSchema = z.enum(STAGES)`; `type Stage`.
- src/modules/routing/domain/stages.ts:16  `FUNNEL = ['arrived','reviewed','assigned','engaged','opportunity','won']` (rank order = pipeline stages).
- stages.ts:48-57 `STAGE_LABELS`: arrived=Arrived, reviewed=Reviewed, assigned=Assigned, engaged=Engaged, opportunity=Opportunity, won=Won, lost=Lost, declined="Not pursued".
- stages.ts:58 `PIPELINE_STAGES = FUNNEL`; :60 `EXIT_STAGES = ['lost','declined']` (All accounts "Other" tab).
- stages.ts:4-14 `StageEvent` union: reviewed, declined, reopened, assigned, assignment_declined, withdrawn, engaged, opportunity, won, lost.
- Order: arrived, reviewed, assigned, engaged, opportunity, won | exits lost, declined. (Mockup calls the first stage "Sent"; backend key/label is arrived/"Arrived".)
- Exports via src/modules/routing/index.ts:23,32,39 (STAGES, Stage, EXIT_STAGES, nextStage, PIPELINE_STAGES, STAGE_LABELS, StageEvent, moveStage).
- Event contract: routing/contracts/events.ts:82-85 `routing.stage.changed` {accountId, from: stageSchema, to: stageSchema, causeEventId}; contracts/types.ts:33 `reviewSnapshotSchema.stage: stageSchema`; snapshot.ts:61 `stageSchema.parse(review.stage)`.
- No per-tenant stage table, no stage_def, no order/label/target columns.

## 2. Where a stage is stored
- routing.account_review.stage text NOT NULL DEFAULT 'arrived' (routing/db/schema.ts:77; migration 0000_routing_schema.sql:12) + stage_changed_at (schema.ts:78). No CHECK on stage.
- routing.stage_change (schema.ts:134-148; migration 0000:74-79): from_stage text NOT NULL, to_stage text NOT NULL, cause_event_id, at; unique (tenant_id, account_id, cause_event_id) = idempotency; index (tenant, account, at desc). This is the stage history; keys are free text, no FK/CHECK. Re-pointed on merge (routing/services/review.ts:167).
- accounts.account_summary.stage text nullable (accounts/db/schema.ts:280; migration 0000_accounts_schema.sql:61); copied from routing snapshot (accounts/services/summary.ts:99; consumer accounts/consumers.ts:32-37).
- crm.deal.stage text nullable (crm/db/schema.ts:179; migration 0000_crm_schema.sql:75): raw HubSpot dealstage string, not mapped. crm.follow_through.stage (schema.ts:163; migration :44): HubSpot company lifecycle stage. crm.mock_deal.stage (schema.ts:369; migration :165): test double. crm.company_check.crm_lifecycle (schema.ts:242).
- Only CHECK near this: crm.deal `deal_status_valid` status in ('open','won','lost') (crm/db/schema.ts:190; migration 0000_crm_schema.sql:51; zod crm/contracts/types.ts:16 dealStatusSchema). No CHECK on any Scout stage column. routing_setting_auto_accept_range (routing/db/schema.ts:161) is unrelated.
- No stage columns in offers, scoring, playbooks, ai-tasks. Intake "stages" (batch-status.ts:12 received/resolving/waiting/resolved/rejected) are batch row states, unrelated.

## 3. Code that switches on / hard-codes stage keys
Legend: SYSTEM = code transitions into it automatically; LABEL = only displayed/ordered.

### Backend transitions (routing)
- routing/domain/stages.ts:26-45 `nextStage()`: the whole state machine.
  - reviewed/assigned/engaged/won: forwardTo(current,event), only forward along FUNNEL rank.
  - opportunity: from lost -> opportunity, else forward.
  - lost: any funnel stage except won -> lost. declined: any funnel stage except won -> declined.
  - reopened: declined -> arrived. assignment_declined/withdrawn: assigned -> reviewed.
  - exits and unknown keys have rank -1, so they stay put.
- routing/services/stage.ts:19-49 moveStage(): locks account_review, `stageSchema.parse`, nextStage, inserts stage_change (idempotent on causeId), updates account_review.stage, publishes routing.stage.changed.
- routing/services/review.ts:73 ensureReview inserts `stage: 'arrived'` (SYSTEM initial). review.ts:149 merge copies stage. review.ts:172 merge with accepted assignment -> moveStage 'assigned'.
- routing/services/review.ts:241-243 changeStatus: event = reopened (declined->non-declined; stage back to 'arrived'), declined (status isDeclined; stage 'declined'), reviewed (status countsAsReviewed && !returnsToSource; stage 'reviewed'); send-back statuses leave stage unchanged. Coupled to review-status flags, not stage keys.
- routing/services/respond.ts:56 accept -> 'assigned'; :109 seller decline -> assignment_declined (assigned->reviewed); :117 withdraw -> withdrawn (assigned->reviewed).
- routing/services/assign.ts:156 re-assign over an accepted assignment -> 'withdrawn' (back to reviewed). Creating an assignment does not move stage; 'assigned' happens on acceptance (manual, auto-accept, or crm_activity via acceptLocked).
- routing/services/crm-events.ts:24-32 onCrmActivity: pending-assignment seller activity auto-accepts; reply|meeting -> 'engaged'. :35 `DEAL_STAGE = {open:'opportunity', won:'won', lost:'lost'}`; :38-43 onCrmDeal. Consumers routing/consumers.ts:42-55 (routingCrmActivity, routingCrmDeal).
- SYSTEM stages: arrived (initial/reopen), reviewed (approve status; seller decline/withdraw fallback), assigned (acceptance), engaged (CRM reply/meeting), opportunity (open deal), won (won deal), lost (lost deal), declined (declined review status). All eight are system-driven today; none is a pure label.

### Backend reads / aggregates that hard-code keys
- accounts/services/search.ts:101 `stage_priority` sort: CASE arrived0 reviewed1 assigned2 engaged3 opportunity4 won5 lost6 declined7 else 8, *1000 + (500 - priority). Hard-coded order (LABEL/order).
- routing/services/pipeline.ts:12,73,77: "other" tab = EXIT_STAGES + sent-back review statuses; a stage filter excludes sent-back statuses only when all picked stages are pipeline stages.
- pipeline.ts:155-170 accountFacets: tabs = PIPELINE_STAGES.map(label STAGE_LABELS) + {key:'other',label:'Other'}; :156 other count = EXIT_STAGES + sent-back.
- pipeline.ts:178-185 wonThisYear: `stageChange.toStage = 'won'` since Jan 1 in tenant tz (subtitle "{won} won this year").
- pipeline.ts:108 stageLabel via STAGE_LABELS; :210 CSV Stage column; :222 value kind Won/Open deal (deal status, not stage).
- routing/services/account-review.ts:59 tracker steps = PIPELINE_STAGES + current stage if it is an exit; :57 `reached` map seeded `arrived`=row.createdAt then toStage dates; :85,87 labels via STAGE_LABELS (undefined for unknown key at :87); :189 change log from/to labels; :121 ChangeKind 'stage'.
- intake/services/source-read.ts:76-93 sourceFunnel (Ruling 4): Reviewed = sent - arrived; Assigned = assigned+engaged+opportunity+won; Won = won; exits count only in Sent/Reviewed; byStage = STAGES.map; null stage counts as arrived. Imports STAGES from routing/contracts/types.ts.
- http/routes/v1/sources/stats/route.ts:2,15 labels byStage with STAGE_LABELS.
- accounts/services/source-stats.ts:20-26 counts by raw stage per source (key-agnostic). intake/services/status.ts:415-421 countsByStage per batch (key-agnostic). batches-read.ts:357,423 stage per row.
- scoring/services/offer-usage.ts:49 offers stats: `s.stage === 'won' && lead offer === offerId` -> offer "won" count; offers/services/stats.ts:23 winRate.
- crm/services/checks.ts:77 lifecycleOf: any deal status 'won' => 'customer' (deal status, not stage); crm/services/read.ts:138-145 value pick prefers won deal else open (deal status).
- http/routes/v1/accounts/filters.ts:25,34 `stage` query param (repeatable/comma), not validated against STAGES; special value `other` handled in pipeline.ts:50,73. Facets route: http/routes/v1/accounts/facets/route.ts.
- Playbooks, ai-tasks and analytics: no stage references in src (analytics is docs only).
- No tenant seed of stages: seedCrmDefaults (crm/defaults.ts:39-60) seeds field mappings, settings and schedules only.

### web-ui
- features/account/StageTracker.tsx:17 hard-codes `s.key === 'reviewed' && review.stage === 'arrived' && reviewer` for the "Waiting on you" note; rest is generic (steps, labels, `at`, `current` from review.stages).
- features/accounts/AllAccountsScreen.tsx:97 tabs = All + fx.stages (key,label,count from API, includes `other`); :76 "{won} won this year" from fx.won_this_year; :181 chip from r.stage_label; :143 footer text; features/accounts/api.ts:87 facets type; :97-98 sort=stage_priority and stage param.
- features/accounts/MyAccountsScreen.tsx:264 chip stage_label. features/sources/tabs/AccountsTab.tsx:30 stage filter options from facets; sources/tabs/OverviewTab.tsx:19-30 by_stage bars from API; sources/StatTiles.tsx:20 Sent/Reviewed/Assigned/Won tiles use API fields assigned, won, pct.
- features/review/PeekDrawer.tsx:446 "Stage changed from X to Y" (labels from API). features/review/api.ts:218 `stages?: {key,label,at,current}[]`.
- features/account/AssignedView.tsx:23, AllAccountsScreen.tsx:215, accounts/api.ts:81 use deal status 'open'/'won' (not stage).
- No Overview (S9) or funnel screen in web-ui yet.

## 4. Endpoints and hidden tab
- There is NO `GET /api/v1/stages` and no settings/stages route. src/http/routes/v1/settings has only [setting]/, crm/, exclusions/, review/, warm-intros/. Stage lists reach the UI only embedded: GET /accounts/facets (stages tabs), GET /accounts/{id}/review (`stages[]`, account-review.ts:21), GET /sources/stats (byStage), GET /batches/{id} (countsByStage).
- web-ui/src/app/nav.ts:96 `{ tab:'pipeline-stages', label:'Pipeline stages', section:'21e', tag:'Redesign', rule:{all:['settings:manage']}, hidden:true }` (comment nav.ts:90). Only reference to 'pipeline-stages' in web-ui; no screen component.

## 5. Mockup stage editor (Taazaa Scout Operations.dc.html, scratchpad/mock)
- UI markup lines 2034-2063 (settings tab label line 3619); logic `stgVals()` lines 3220-3238; defaults STAGES0 lines 2572-2581; STAGE_RULES line 2571; STAGE_COUNT/STAGE_PREV 2582-2583.
- Header copy: "The stages every account moves through, in order. They drive the pipeline, scorecard, filters and HubSpot sync. Renaming keeps history; deleting moves accounts back one stage." Buttons: Restore defaults (loads STAGES0 into the draft), Discard and Save stages (only when dirty). Footer: "The first stage and the won stage can be renamed but not deleted. Quarter targets feed the pace markers on the pipeline. Changes apply from the moment you save; past movements keep the stage names they had."
- Two tables. "Stages" (kind=flow; "In order. Accounts move down this list. New stages go just before the won stage."; Add stage; column Quarter target) and "Exits" (kind=exit; "Ways an account leaves the pipeline. They show under the pipeline and count as closed."; Add exit; column Target, input disabled).
- Row fields: numbered dot (n for flow, dash for exit; won dot green), Name, What it means (text), Moves here when (select from STAGE_RULES), HubSpot stage (text, placeholder "Not synced"), Quarter target (numeric, disabled for exits), Move up / Move down / Delete.
- STAGE_RULES (12): A source or import creates it; A reviewer sets a tier; An AE accepts the assignment; A reply or meeting is logged; A meeting is booked; A HubSpot deal is created; HubSpot deal reaches this stage; HubSpot deal is Closed won; HubSpot deal is Closed lost; A reviewer rejects it; Playbook ends with no reply; Set by hand.
- Default stages (id, name, rule, HubSpot stage, target, lock):
  - sent "Sent" | A source or import creates it | (none) | 2400 | lock first
  - reviewed "Reviewed" | A reviewer sets a tier | (none) | 2000
  - assigned "Assigned" | An AE accepts the assignment | Lead | 500
  - engaged "Engaged" | A reply or meeting is logged | Contacted | 320
  - opportunity "Opportunity" | A HubSpot deal is created | Qualified | 120
  - won "Won" | HubSpot deal is Closed won | Closed won | 60 | lock won
  - Exits: disq "Disqualified" (A reviewer rejects it; no HS; no target); nurture "Back to nurture" (Playbook ends with no reply); lost "Lost" (HubSpot deal is Closed lost; HS "Closed lost").
- Behaviours: reorder = swap with neighbour within the same kind; flow cannot swap with the locked first stage (silently blocked); exits reorder freely. Delete: locked first/won rows blocked with toast "The {first|won} stage can be renamed but not deleted."; other rows removed from the draft. Add stage inserts "New stage" (rule "Set by hand", no HS, no target) immediately before the won stage; Add exit appends "New exit". Save validates only "Every stage needs a name." (toast), trims names, toast "Pipeline stages saved. The pipeline and scorecard use them now."; no uniqueness check on names or HubSpot stages. Targets are per-quarter counts; none on exits.
- Target consumers (Overview, lines ~1954, 3138-3150): "{count} of {target}", pace marker, "Behind pace" if count/target < pace*0.9, "Ahead" if >= pace*1.05, "No target set" when empty. Pipeline value = count at stage id 'opportunity' (fallback second-to-last flow stage) * avg; won value = the lock 'won' stage. Conversion = % of previous stage; first = "Into the pipeline".
- Differences vs backend: first key 'sent' vs 'arrived'; exits Disqualified / Back to nurture / Lost vs backend lost / declined ("Not pursued"); mockup finds the won stage by lock flag and opportunity by id. Mockup "Moves here when" rule is a free pick from a fixed list; the backend has hard-coded event-to-stage transitions instead.

## 6. HubSpot deal stages today
- No Scout-stage-to-HubSpot-stage mapping exists. Scout never maps HubSpot dealstage to a Scout stage key and never pushes its stage to HubSpot.
- crm/adapters/hubspot/live.ts:61 DEAL_PROPS include dealstage, hs_is_closed, hs_is_closed_won. :86-92 dealOut: closed = hs_is_closed==='true' || dealstage in ('closedwon','closedlost') (HubSpot default-pipeline ids hard-coded); won = hs_is_closed_won==='true' || dealstage==='closedwon'; status = won ? 'won' : closed ? 'lost' : 'open'; :96 stage = raw dealstage string.
- crm/services/deals.ts:60-110 applyDeals/pollDeals: upserts crm.deal (raw stage, status); publishes crm.deal.changed only when status or amount changed (a stage-only change does not publish); event carries `stage` (crm/contracts/events.ts:84) and `status`. pollDeals hourly (crm/defaults.ts CRM_SCHEDULES), changedSince high-water mark.
- routing/services/crm-events.ts:35-43 uses only status open/won/lost -> opportunity/won/lost; the raw HubSpot stage string is ignored. So any open deal in any HubSpot stage = Scout 'opportunity'; the mockup's per-stage HubSpot stage field has no backend counterpart.
- crm/defaults.ts:13-24 DEFAULT_FIELD_MAPPINGS (crm.field_mapping, direction push, company object): taazaa_bucket, taazaa_best_offer, taazaa_tier (enum_map with TIER_LABELS), scores, why_now, top_signals, research_topics, last_handoff (date), scout_link. None for stage. `transformConfig` (crm/db/schema.ts:128 jsonb Record<string,string>; crm/domain/fields.ts:6,31 `enum_map` lookup) is used only for tier labels; it is the existing generic mechanism a stage mapping could reuse.
- crm/services/settings.ts:14 DEFAULT_QUALIFIED_LEAD_RULE {property:'lifecyclestage', value:'marketingqualifiedlead'} (qualified-lead intake, unrelated to deal stages); settings keys: system, takeOverStaleOwnership, pushNewPeople, followUpDays, qualifiedLeadRule.
- crm/services/checks.ts:77 lifecycleOf: CRM lifecycle 'customer' or any won deal => 'customer'; any open => 'open_deal'.
- crm.follow_through.stage = company lifecyclestage (live.ts:519), stored only. crm/fixtures.ts:61 uses deal stage 'proposal' (mock only).