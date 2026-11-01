# REV-E5 Configurable pipeline stages

Release: pipeline stages redesign (web-ui Decision 6), before the R3 analytics plans. It replaces the
fixed stage set of REV-E4 (`STAGES`, `nextStage`) with a per-workspace stage list. Everything else in
REV-E4 (history, the tracker, the status endpoint) stays.

## Why

Every team runs its pipeline a little differently. The mockup (screens.md §21e) lets an owner name the
stages, put them in order, say what moves an account into each, map each to a HubSpot deal stage and
set a quarter target, and the pipeline, tracker, filters, scorecard and HubSpot sync follow.

## Decisions (the user, 2026-11-01)

1. **Full mockup triggers.** Each stage picks what moves an account into it from a fixed list,
   including "Set by hand" with a `Move to stage` control on the account.
2. **Mockup default names** for every workspace: Sent, Reviewed, Assigned, Engaged, Opportunity, Won;
   exits Disqualified, Back to nurture, Lost. History keeps the names it had.
3. **HubSpot deal stages move accounts.** A stage can name a HubSpot deal stage; a deal reaching it
   moves the account there. The mapping is stored so stages can later be pushed to HubSpot too.

## Model

`routing.pipeline_stage` (tenant table, RLS): `key` (text, stable; never reused), `name`, `description`,
`kind` (`flow` | `exit`), `position` (order within its kind), `trigger` (below), `hubspot_stage`
(text, nullable: the HubSpot deal stage id), `quarter_target` (int, nullable, flow only), `locked`
(`first` | `won` | null), `archived_at`. Unique `(tenant_id, key)`; unique `(tenant_id, name)` among
live stages (case-insensitive).

### Defaults (seeded per workspace; existing workspaces get them by migration)

| Key | Name | Kind | Trigger | HubSpot stage | Target | Locked |
|---|---|---|---|---|---|---|
| `arrived` | Sent | flow | `source_creates` | | | first |
| `reviewed` | Reviewed | flow | `reviewer_sets_tier` | | | |
| `assigned` | Assigned | flow | `ae_accepts` | | | |
| `engaged` | Engaged | flow | `reply_or_meeting` | | | |
| `opportunity` | Opportunity | flow | `deal_created` | | | |
| `won` | Won | flow | `deal_closed_won` | `closedwon` | | won |
| `declined` | Disqualified | exit | `reviewer_rejects` | | | |
| `back_to_nurture` | Back to nurture | exit | `playbook_no_reply` | | | |
| `lost` | Lost | exit | `deal_closed_lost` | `closedlost` | | |

Keys of existing stages are today's keys, so stored stages and history need no rewrite. Keys of new
stages are `stg_` ids. The locked first and won stages keep their keys forever, so code may rely on
`arrived` (the first stage) and `won` (the won stage) by key.

### Triggers ("Moves here when")

| Trigger | Label | Fires on | At most |
|---|---|---|---|
| `source_creates` | A source or import creates it | a new review row | the first stage only |
| `reviewer_sets_tier` | A reviewer sets a tier | a review status that counts as reviewed | one stage |
| `ae_accepts` | An AE accepts the assignment | acceptance (by hand, auto-accept or CRM activity) | one stage |
| `reply_or_meeting` | A reply or meeting is logged | CRM activity reply or meeting | one stage |
| `meeting_booked` | A meeting is booked | CRM activity meeting | one stage |
| `deal_created` | A HubSpot deal is created | a deal with status open | one stage |
| `deal_reaches_stage` | HubSpot deal reaches this stage | an open deal whose HubSpot stage equals this stage's `hubspot_stage` | many (each needs a HubSpot stage) |
| `deal_closed_won` | HubSpot deal is Closed won | deal status won | the won stage only |
| `deal_closed_lost` | HubSpot deal is Closed lost | deal status lost | one stage |
| `reviewer_rejects` | A reviewer rejects it | a declined review status | one stage |
| `playbook_no_reply` | Playbook ends with no reply | playbook finished with no reply (fires once R2 playbooks run) | one stage |
| `by_hand` | Set by hand | `Move to stage` only | many |

### Movement rules (replace `nextStage`)

- An event finds the stage whose trigger it fires; no such stage, no move. When one event fires
  several (a meeting fires `reply_or_meeting` and `meeting_booked`), the furthest flow stage wins.
- **Flow stages move forward only** (by position). An account never moves backward on an event,
  except the three rules below.
- **Exits** are entered from any flow stage except the won stage. An account in an exit moves only
  by: reopening (a declined review status changed back: to the first stage), a new open deal (from the
  `deal_closed_lost` exit to the `deal_created` stage, as today), or by hand.
- **An assignment declined or withdrawn** moves an account at or past the `ae_accepts` stage (but
  before any deal stage) back to the `reviewer_sets_tier` stage, else the first stage (today's
  assigned → reviewed).
- **Move to stage** (`POST /api/v1/accounts/{id}:move-stage` `{stage, note?}`, `review:act`, people
  only) moves to any live stage, forward or back, into or out of an exit. It writes history with who
  and the note.
- Every move writes `routing.stage_change` with `from_stage`, `to_stage`, and now `from_name` and
  `to_name` (the names at that moment; backfilled from today's labels), and publishes
  `routing.stage.changed`.

### Editing (screens.md §21e)

- `GET /api/v1/stages` (any member with `accounts:read` or `status:read`): live stages in order, flow
  then exits, with `key, name, description, kind, trigger, trigger_label, hubspot_stage,
  quarter_target, locked`, plus the trigger list with labels and limits.
- `PUT /api/v1/settings/stages` (`settings:manage`, people only): replaces the whole list (keys of
  existing stages, no key for new ones). Rules, each a 400 with the field and a sentence: every stage
  needs a name ("Every stage needs a name."); names unique; the first and won stages present, first at
  position 0 and won last among flow stages ("The first stage and the won stage can be renamed but not
  deleted."); their triggers fixed; each trigger within its "at most"; `deal_reaches_stage` needs a
  HubSpot stage; no target on exits; targets whole numbers 0 or more.
- **Deleting a stage** archives it. Accounts at a deleted flow stage move back one flow stage; accounts
  in a deleted exit move to the stage they were at before entering it (from history), else the first
  stage. Each is a `stage_change` with cause `stage_deleted`. Archived keys are never reused.
- Renaming keeps history (history has its own names). Changes apply from the save.
- Saving audits `routing.stages.changed` with before and after, publishes `routing.stages.changed`, and
  answers with the new list. Toast "Pipeline stages saved. The pipeline and scorecard use them now."
- `Restore defaults` puts back the default list: default stages that were archived come back under
  their key, added stages are deleted under the rules above.

### Where stages are read (all from the workspace's list)

The account tracker (one step per flow stage, plus the current exit), All accounts tabs and the "Other"
tab (exits and sent-back), the stage sort (`stage_priority` by position: flow in order, then exits),
"{n} won this year" and the offer "won" count (the won stage), the source funnel (Assigned = at or past
the `ae_accepts` stage), stage labels in CSV, change logs and batch rows, and later the R3 funnel,
Overview targets and scorecard.

### HubSpot

- The deal poller publishes `crm.deal.changed` when a deal's stage changes, not only its status or
  amount.
- Routing on a deal event: won → the `deal_closed_won` stage; lost → the `deal_closed_lost` stage; open
  → a `deal_reaches_stage` stage whose `hubspot_stage` equals the deal's stage, else the `deal_created`
  stage (forward only, as above).
- The `closedwon`/`closedlost` ids stay the default HubSpot pipeline's; other pipelines are a later
  change.

## Stories

### REV-E5-S1 Name and order stages
- REV-E5-S1-AC1 Renaming Engaged to "Talking" changes every stage label in the app on the next load;
  the account's history still says "Engaged" for moves made before.
- REV-E5-S1-AC2 Adding "Proposal" before Won with trigger "Set by hand" shows it in the tracker and the
  All accounts tabs; `Move to stage` puts an account there.
- REV-E5-S1-AC3 Deleting Engaged moves its accounts to Assigned with a history row; Engaged is gone
  from tabs and the tracker.
- REV-E5-S1-AC4 Deleting the won stage, or a save with no name, is refused with the sentence above.
- REV-E5-S1-AC5 Two stages with "An AE accepts the assignment" are refused: "Only one stage can move
  when an AE accepts the assignment."

### REV-E5-S2 Events move accounts by trigger
- REV-E5-S2-AC1 With default stages, every REV-E4 movement test still passes (same keys, same moves).
- REV-E5-S2-AC2 Moving "A reply or meeting is logged" from Engaged to a new stage "Talking" makes the
  next reply move the account to Talking.
- REV-E5-S2-AC3 A stage with no trigger match for an event: nothing moves.
- REV-E5-S2-AC4 An account at Opportunity never moves back to Engaged on a reply.

### REV-E5-S3 HubSpot deal stages
- REV-E5-S3-AC1 A stage "Proposal" mapped to HubSpot `presentationscheduled` with trigger "HubSpot deal
  reaches this stage": an open deal moving to that HubSpot stage moves the account to Proposal within
  one poll.
- REV-E5-S3-AC2 A deal changing only its stage publishes `crm.deal.changed`.

### REV-E5-S4 Move to stage by hand
- REV-E5-S4-AC1 A reviewer moves an account from Lost back to Opportunity with a note; history shows
  who, when and the note.
- REV-E5-S4-AC2 Without `review:act`, 403.

### REV-E5-S5 Workspaces don't share stages
- REV-E5-S5-AC1 Workspace A's renamed or added stages never appear in workspace B.
