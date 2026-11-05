# R2d map: meetings and engagement on the assigned account page

Read-only map of branch feat/r2d-meetings (= main aa7cd48). Paths are relative to C:\dev\tz-scout-meetings. "Mockup" means
`C:\Users\yasir\AppData\Local\Temp\claude\c--dev-tz-scout\5d5b32bf-3547-4ae0-9554-5906e0cd9276\scratchpad\mock\Taazaa Scout.dc.html`.

## 1. Copy and layout (screens.md + mockup + other specs)

- **Tiles (§4b item 1, docs/spec/web-ui/screens.md:251-253)**: Meetings held ("Next: Nov 18 with Transit Operations", R2), Replies ("3 of 9",
  "Emails sent since Oct 27"), Buyers engaged ("2 of 4", gap in amber; R2), Opportunity ("Not yet" / deal name and value).
  Mockup 1411-1416: `Meetings held` value "1", note "Next: Nov 18 with Transit Operations" (#7A736B); `Buyers engaged` value "2 of 4",
  note "No IT or security contact yet" in amber #A15C07 (the amber note names a missing role, not a person); `Opportunity` note
  "Created when the scoping call is held". Tile markup 572-580: 4-column grid, label 11px uppercase, value 26px/600, note 12px.
  "with Transit Operations" is a group or meeting name, not a person. The spec's "Next: {date} with {who}" leaves `who` undefined.
- **Activity (§4b item 3, screens.md:271-273)**: "Synced {when}", dated entries of replies, emails, meetings, opens and Scout's own actions
  ("Scout set Ash Patel as company owner, logged the brief and started the playbook."). Mockup 600-606 + data 1418-1424: grid
  `72px 28px 1fr`: date, 24px avatar (Scout = plum PL with "S", people = initials on #F2F0EC), then **who** (bold) over **what**:
  - "Jarice Rodriguez · Replied: "Please send the outline before the 20th…"" (quotes the reply text)
  - "Ash Patel · Sent the Modernization Blueprint outline to Jarice Rodriguez and Keisha Marlowe" (email subject-ish + recipients)
  - "Ash Patel · Meeting held with Jarice Rodriguez and Keisha Marlowe, 30 minutes" (attendees + duration)
  - "Alonzo Joseph · Opened the cancelled-RFP lessons note twice" (open count + email name)
  - "Scout · Set Ash Patel as company owner, logged the brief and started the playbook"
- **Committee engagement (§4b item 5, screens.md:277-280)**: per person "Met Nov 4" green, "Opened, no reply" amber, "Not contacted" gray.
  Mockup 627-633 + 1425-1430: 7px dot + 12px text on the right of each row; dots #18794E / #A15C07 / #A39C93. The rail row also shows
  "Technical buyer, found Nov 6" (role + when found). No text for "Replied" or "Emailed, not opened": the three states are not exhaustive.
- **Other spec lines**
  - docs/spec/web-ui/api-gaps.md:811-814,830: tiles meetings/emails/opportunity READY via `follow_through.counts`; "Buyers engaged", "Next:"
    and per-person engagement LATER (R2), "Activity is per account; no next meeting stored."
  - docs/spec/crm-sync/follow-through-and-deals.md:22-27 (activity kinds email, reply, call, meeting, task done; reply = inbound email),
    :13-14 (baseline at handoff), :41-42 (CRM-E5-S1-AC1 meetings since handoff). Nothing about opens, attendees or future meetings.
  - docs/spec/crm-sync/crm-adapter-contract.md:25-26,47: `readFollowThrough` counts, `listActivities` -> `{externalId, kind, occurredAt}`
    + `actorOwnerExternalId`. No contact, no title/body, no start vs logged time, no opens. The contract needs an edit.
  - docs/spec/review-and-routing/configurable-stages.md:37,56,68: `reply_or_meeting` (Engaged), `meeting_booked` ("A meeting is booked", from
    CRM activity meeting). So routing already treats a CRM meeting as booked; the tile says "held". Both readings exist.
  - docs/spec/playbooks/outcomes-and-what-worked.md:18: `meeting` outcome = "`crm.activity.observed` meeting held; `campaigns.meeting.held` (R4)".
    PLB-E6 (outcomes, what-worked score) is **R3** (docs/spec/playbooks/index.md:62). `POST /accounts/{id}/outcomes` and "Log outcome"
    (playbooks/account-page.md:38,77, PLB-E4-S2-AC3) belong to it: logging a meeting by hand is out of R2d unless the owner pulls it in.
  - docs/spec/campaigns/booking-and-reminders.md:1,17-20 and campaigns/index.md:28,57,73: booking, meeting statuses (booked, held, no-show,
    cancelled), `campaigns.meeting`, `GET /api/v1/meetings` are **R4**. Out of scope; R2d reads meetings from HubSpot only.
  - docs/spec/analytics/*: Engaged stage counts (account-funnel-by-source.md:8-18) come from stage changes; scorecard meeting rows are R4
    (weekly-scorecard-and-diagnosis.md:19). Nothing new for R2d.

## 2. CRM backend as built

- **Adapter** (src/modules/crm/contracts/adapter.ts:117-139): `readFollowThrough` -> `{tasks[], emails, calls, meetings, deals, openDeals,
  stage, ownerExternalId, lastActivityAt}`; `listActivities` -> `[{externalId, kind, occurredAt, actorOwnerExternalId}]`. Kinds
  `email|reply|call|meeting|task_done` (contracts/types.ts:19). **No person/contact, no subject/body/title, no duration, no meeting
  outcome, no end time, no opens.**
- **Live HubSpot** (src/modules/crm/adapters/hubspot/live.ts): `activitiesOf` 300-317 searches emails, calls, meetings by
  `associations.company` and `hs_timestamp >= since`, props `hs_timestamp, hubspot_owner_id` (+ `hs_email_direction`); INCOMING_EMAIL -> reply.
  `occurredAt` = `hs_timestamp` (for meetings HubSpot sets it to the start time; `hs_meeting_start_time`, `hs_meeting_end_time`,
  `hs_meeting_outcome` SCHEDULED|COMPLETED|NO_SHOW|CANCELED|RESCHEDULED, `hs_meeting_title` are not read). No contact associations are
  requested. `readFollowThrough` 505-525 counts associations of the company (`associations=emails,calls,meetings,deals`), so `meetings`
  includes future and cancelled meetings. `listActivities` 527-532 runs the three searches in turn. Scopes checked 112-125 (contacts,
  companies, deals); verify whether reading email/meeting contact associations and open data needs more (e.g. `sales-email-read`).
  Opens: per-email open counts are not on the logged email object in a way Scout reads today; contacts carry `hs_sales_email_last_opened`
  (to verify against HubSpot docs). Unit test with fetch fakes: tests/unit/crm/hubspot-live.test.ts.
- **Mock** (adapters/hubspot/mock.ts:312-352): counts `email`+`reply` as emails, `meeting` as meetings, from `crm.mock_activity`
  (db/schema.ts:402-413: tenant, external_id, company_external_id, kind, occurred_at, actor_owner_external_id; **no person, no title,
  no status**). `mockAddActivity` fixtures.ts:102-117. Contract suite tests/contract/crm/adapter.contract.ts, tests/integration/crm/mock-contract.test.ts.
- **`crm.activity`** (db/schema.ts:195-212): id `cac_`, account_id, handoff_id, system, external_id, kind, occurred_at; unique
  (tenant, system, external_id); kind check constraint. **No person ids, no actor, no summary data, no status.** A migration is needed for any
  of these (and the check constraint if an `open` kind is added).
- **Sync** (services/follow-through.ts): `syncFollowThrough` 58-160. `since` 81-85 = max(occurred_at) of non-task rows, else handoff time.
  **Trap**: a booked future meeting stored with its start time pushes `since` into the future, so emails/replies until then are missed;
  and a meeting that moves (rescheduled) or is cancelled is never re-read (insert `onConflictDoNothing` 105-110). `observe` publishes
  `crm.activity.observed` (contracts/events.ts:58-73: accountId, handoffId, system, externalId, kind, occurredAt, actor ids, task ids;
  **no person ids**). `followThrough()` 207-221 and `getHandoffs` (services/read.ts:41-96) give the counts: baseline subtraction in
  domain/follow-through.ts:27-43; `replies` = count of `crm.activity` kind reply for the latest completed handoff (read.ts:67-74).
  So "Replies 3 of 9" = reply rows over (email association count - baseline), where HubSpot's count includes the replies themselves.
- **Feed** `GET /api/v1/accounts/{id}/activity` (src/http/routes/v1/accounts/[id]/activity/route.ts, `accounts:read`, 25 a page) ->
  `listActivity` services/activity.ts:28-77: crm.activity rows + Scout rows from `crm.handoff` via `scoutEntries`
  (domain/activity.ts:62-79). Summaries are fixed words per kind (domain/activity.ts:6-19: "Email sent", "Reply received", "Call logged",
  "Meeting held", "Task done"). Row shape `{id, kind, at, summary}`: **no who, no avatar, no text**. Scout rows today: "Scout sent the account
  to HubSpot with {seller} as owner and logged the brief." and undo rows. **No "started the playbook"**: plan start lives in playbooks
  (history kind `created`, `plan.created` event, which crm already consumes, consumers.ts:3,129-139; `PlanTasks` port contracts/types.ts:56
  has no started time). Integration tests: tests/integration/v1/account-page.test.ts:288-; unit tests/unit/crm/activity.test.ts.
- **Person <-> contact**: `crm.link` scout_type `person` (db/schema.ts:14-29, index `link_external_idx` on external_id) written by the
  handoff push (services/handoff.ts:261-279, up to `PUSH_PEOPLE_LIMIT` 10 people, primary first, :33) and `personPush` for people added
  later (services/push.ts:90-112). Read in links.ts:66,79 and plan-tasks.ts:155. People never pushed (no name, over 10, found after a
  failed push) have no contact link, so they can only be "Not contacted". Contacts HubSpot has that Scout never pushed have no person.

## 3. Accounts, routing, playbooks

- Committee: `getCommittee` src/modules/accounts/services/committee.ts:42-58, pure `coverage` domain/committee.ts:18-60 (roles required
  by the lead offer or the core three; `summary.covered/required`). Route `GET /accounts/:id/committee` (src/http/routes.ts:184).
  Accounts imports crm only via contracts/events (accounts/consumers.ts:1); it must not read crm tables, so per-person engagement is a
  crm read joined in the page, keyed by person id.
- Routing `onCrmActivity` src/modules/routing/services/crm-events.ts:26-38: `reply` -> engaged, `meeting` -> `meeting` (fires
  `reply_or_meeting` + `meeting_booked`) on first sight, whatever the meeting's date or outcome.
- Playbooks `onCrmActivity` src/modules/playbooks/services/crm-activity.ts:23-42: ignores activity before `plan.acceptedAt`, sets
  `engaged_at`, stop rule reason "They booked a meeting". A future meeting's `occurredAt` (start) is after accept, so it stops the plan
  at booking. If R2d starts reading meeting status, both consumers keep their current meaning ("booked") unless the owner says otherwise.

## 4. Module boundaries

- ESLint (eslint.config.mjs:12-34): cross-module imports only via `index.ts` or `contracts/**`. crm may import accounts/tenancy services
  (activity.ts:2-3 already does `getAccount`, `members`). Per-person engagement and next meeting belong in crm (it owns activity);
  the web page joins by person id. For the Scout "started the playbook" row crm can read its own record of `plan.created`
  (add a started time to `PlanTasks` or store it from the consumer) rather than import playbooks services.

## 5. Web UI (web-ui/src/features/account)

- `AssignedView` AssignedView.tsx:221-239: PlanCard, `Outcomes`, `Activity`, `ReviewRecord`; rail AssignmentCard, SellerGuideCard,
  `BuyingCommittee`. Note the order differs from the mockup (tiles first); screens.md:254 makes the playbook the first card. Keep.
- `Outcomes` 23-58: only Replies and Opportunity; `styles.tiles4` already set. Add Meetings held (first) and Buyers engaged (third).
- `Activity` 60-104: rows are `f.date(at)` + `summary`; no avatar or who line. Mockup layout needs `who` and `Avatar` (web-ui/src/ui).
  Empty text "No HubSpot activity yet. Replies, emails and meetings show here as HubSpot records them."
- `BuyingCommittee` RightRail.tsx:20-128 renders `account.people` with roles, chips, notes, Edit; no engagement slot. Add a dot+text span
  per row from a new engagement query (keyed by person id); people without a row = "Not contacted"?
- api.ts: `Handoffs` 239-244 types only `counts.{emails,replies}`; the API already sends `meetings` (api-gaps.md:811). `ActivityRow` 253,
  `activityQuery` 255-265, `committeeQuery` 78, `Person` 16-28. testing.ts: `HANDOFFS` 208-213, `Served` 305-319, `serveAccount`
  322- (activity answered empty at 350). Tests: assigned.test.tsx:107-160 (activity feed), committee.test.tsx.

## 6. Test helpers

- `seedMockCrm`, `mockAddActivity` (extend with person/contact ids, title, status, end time), `syncAccount`, `pollActivity` from
  `@/modules/crm` / `@/modules/crm/fixtures`; `handedOff()` pattern tests/integration/crm/activity.test.ts:36-60; `runOutbox`
  tests/integration/helpers/run-outbox.ts:32. Mock contact ids `mock-ct-<n>` from the push; look them up in `crm.link` person rows.
- Live adapter: tests/unit/crm/hubspot-live.test.ts fetch fakes for new search props and association reads.
- Routing/playbooks regression: tests/integration/routing/crm-events.test.ts, tests/integration/playbooks (stop on meeting).

## Owner questions

1. "Meetings held": count meetings whose start time is past (and not cancelled / no-show by `hs_meeting_outcome`), or every meeting HubSpot logs?
2. "Next: {date} with {who}": the earliest future, not cancelled meeting. Is `who` the attendees' names (first contact, "+1"), or the meeting title like the mockup's "Transit Operations"? No future meeting: what does the note say?
3. Should routing's `meeting_booked` and the playbook stop rule keep firing when a meeting is booked (today), while the tile counts only held ones?
4. "Engaged" for a buyer: replied or met (proposed), or also emailed/called? Are the states in order Met > Replied > "Opened, no reply" > Emailed > "Not contacted", and what are the words for "Replied" and "Emailed, no open"?
5. "Buyers engaged {x} of {y}": y = people on the committee (mockup 4 people), or the offer's required roles (committee summary)? Is the amber note the first role gap ("No technical buyer yet")?
6. Are email opens tracked in R2d? They need HubSpot open data that Scout does not read yet (and maybe another scope). If not, drop "Opened, no reply" and "opens" from the feed for now.
7. Feed rows: is the mockup's who + what (reply text quoted, email subject, attendees, duration) wanted, given it copies email text into Scout? Or names and kinds only?
8. The Scout row "set {AE} as company owner, logged the brief and started the playbook": one merged row when the plan starts, or a separate "Scout started {playbook}" row at accept?
9. Does activity count only from the handoff (today) and only for pushed contacts, or also HubSpot contacts Scout never pushed (shown by name, not in the committee)?
10. Logging a meeting by hand (Log outcome, PLB-E4-S2-AC3 / PLB-E6) stays R3, booking stays R4. OK?

## Suggested tasks (5)

1. Adapter contract + mock: `listActivities` adds `personExternalIds[]`, `title`, `endAt`, `status` (scheduled|held|cancelled|no_show) for
   meetings, optional `opens`; `mock_activity` columns; `mockAddActivity` options; contract tests; crm-adapter-contract.md and
   follow-through-and-deals.md edits.
2. Live HubSpot: read meeting start/end/outcome/title and contact associations (batch associations read), open data if Q6 says yes; fix the
   future-`since` trap (cap `since` at now, re-read future and recent meetings so moves and cancels update); unit tests with fetch fakes.
3. CRM storage and reads: migration for `crm.activity` (person ids, actor, title, status, start/end; kind check), sync updates on change;
   `meetingsHeld`, `nextMeeting {at, with}`, per-person engagement (via `crm.link` person) and buyers-engaged counts on
   `GET /accounts/{id}/handoffs` or a new `GET /accounts/{id}/engagement` (`accounts:read`); integration tests with the mock.
4. Feed: richer `ActivityEntry` (`who`, `actor` kind, text) from stored data; Scout "started the playbook" row from `plan.created`; route
   tests and screens.md/api-gaps.md updates.
5. Web UI: Meetings held and Buyers engaged tiles (amber gap note), feed rows with avatar + who/what, committee engagement dot per person,
   api.ts/testing.ts fixtures, tests in assigned.test.tsx and committee.test.tsx; e2e on the seeded mock (meeting held, next meeting, reply).
