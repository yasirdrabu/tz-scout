# R2d Meetings and engagement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assigned account page shows meetings held and the next meeting, buyers engaged with the gap, engagement per committee person, and HubSpot activity rows that say who did what.

**Architecture:** The CRM adapter's `listActivities` returns richer activities (contacts with names, subject or title, meeting start, end and status). CRM stores them on `crm.activity`, re-reads recent and upcoming meetings so moves and cancels update, and serves the counts, next meeting and per-person engagement. The web page joins engagement to the committee by person id. Accounts and playbooks are read only through their `index.ts` and the existing CRM port.

**Tech Stack:** TypeScript, Hono, Drizzle + Postgres (RLS), outbox + NATS, React 19 + TanStack Query, vitest, msw, Playwright.

**Spec:** `docs/spec/web-ui/screens.md` §4b items 1, 3, 5; `docs/spec/web-ui/api-gaps.md` (tiles and feed rows); `docs/spec/crm-sync/crm-adapter-contract.md`; `docs/spec/crm-sync/follow-through-and-deals.md`. Code map: `docs/plans/2026-11-05-r2d-meetings-engagement.map.md`.

## Product decisions (user, 2026-11-05)

1. **Meetings held** counts meetings whose start has passed and that are not cancelled or no-show. The tile also shows the next upcoming meeting. Routing's `meeting_booked` and the playbook stop rule keep firing when a meeting is first seen (booked).
2. **Engaged** = the person replied or attended a held meeting. Labels: "Met {date}" green, "Replied {date}" green, "Emailed, no reply" amber, "Not contacted" gray. "Buyers engaged {x} of {y}": y = people on the committee; the amber note names the first missing required role.
3. **No email opens** in R2d: no open data is read, no "Opened, no reply", no open rows.
4. **Feed detail:** who, what and when, plus email subject, meeting title, attendees and duration. Never an email or reply body.

## Rulings (controller, 2026-11-05)

1. **Next meeting.** The earliest meeting with start after now and status not cancelled or no-show. Note "Next: {Mon D} with {who}". `who` is the meeting title when there is one, else the first attendee's name, plus " +{n}" for more. No upcoming meeting: "No meeting booked".
2. **Held** = status `held`, or status `scheduled` with an end (else start) before now. HubSpot `hs_meeting_outcome` maps: COMPLETED → `held`, SCHEDULED or RESCHEDULED → `scheduled`, NO_SHOW → `no_show`, CANCELED → `cancelled`, and missing → `scheduled`.
3. **Adapter activity shape** (both adapters, contract tests): `{ externalId, kind, occurredAt, actorOwnerExternalId, contacts: { externalId: string; name: string | null }[], subject: string | null, startAt: string | null, endAt: string | null, status: 'scheduled' | 'held' | 'no_show' | 'cancelled' | null }`. `subject` is the email subject or the meeting title; `startAt`, `endAt` and `status` apply only to meetings. No body fields exist anywhere.
4. **Storage.** `crm.activity` gains `contacts jsonb not null default '[]'`, `actor_owner_external_id`, `subject`, `start_at`, `end_at`, `status`. The migration is generated.
5. **Since fix.** The poll's `since` is capped at now. Each sync also re-reads meetings with start from 30 days ago onward (`listActivities` takes `meetingsFrom`). A meeting already stored updates its subject, contacts, start, end and status in place. It never publishes `crm.activity.observed` again, so routing and the stop rule fire once, on first sight.
6. **Engagement per person.** It covers committee people with a CRM person link (`crm.link` person). A person's state comes from activity since the latest completed handoff:
   1. "Met {date}": the latest held meeting listing their contact.
   2. "Replied {date}": the latest reply from their contact.
   3. "Emailed, no reply": an email or call listing their contact.
   4. "Not contacted": anything else, including people with no contact link.
7. **API.** Two parts:
   - `GET /accounts/{id}/handoffs` → `follow_through` gains `meetings_held` (int) and `next_meeting` (`{ at, with }` or null).
   - New `GET /accounts/{id}/engagement` (`accounts:read`, visibility like `/activity`) → `{ people: [{ person_id, state: 'met' | 'replied' | 'emailed' | 'not_contacted', at: string | null }], engaged: number, total: number, gap_role: string | null }`. `total` is the committee people count, `engaged` counts met or replied, and `gap_role` is the label of the first uncovered required role from accounts' committee coverage. The tile note reads "No {gap_role} contact yet".
8. **Feed rows.** `ActivityEntry` gains `who: string | null` and `actor: 'person' | 'contact' | 'scout'`, and `summary` becomes the "what". Copy (exact):
   - **Email:** who = the actor owner's member name. What = "Sent \"{subject}\" to {names}", or "Sent an email to {names}" with no subject.
   - **Reply:** who = the first contact's name. What = "Replied: \"{subject}\"", or "Replied" with no subject.
   - **Meeting held:** "Meeting held with {names}, {m} minutes". The duration is shown only when both start and end are known.
   - **Upcoming:** "Meeting booked for {Mon D} with {names}".
   - **Cancelled:** "Meeting cancelled". **No-show:** "Meeting missed".
   - **Call:** "Call with {names}", or "Call logged" with no contacts.
   - `{names}` is "A", "A and B", or "A, B and {n} others". It falls back to the old fixed words when nothing is known.
   - **Scout rows:** who = "Scout". What = the existing handoff sentences, plus a new row at each plan start: "Started the {playbook} playbook".
9. **Plan start row.** `PlanTasks` gains `startedAt` (the plan's `created_at`) for the current plan and for `otherPlans`. The feed builds the row from that port, with no new table.
10. **Out of scope.** Opens, logging a meeting by hand ("Log outcome", R3 PLB-E6), booking (R4 campaigns), and HubSpot contacts Scout never pushed joining the committee.

## Global Constraints

- **Test environment:** tests run on the throwaway embedded Postgres (port 54329) and a private NATS, per `.superpowers/sdd/2026-11-04-r2c-3a-account-plan/test-env.md` in the main repo `C:\dev\tz-scout` (copy it into this plan's workspace).
  - `DATABASE_URL` and `DATABASE_ADMIN_URL` use the `scout_app` and `scout_admin` roles. The superuser goes only in `DATABASE_SUPERUSER_URL`.
  - The relay test needs `nats-server.exe` under `.tools/nats-server/` in the worktree (gitignored), copied from `C:\dev\tz-scout\.tools`.
- **Hands off the dev setup:** never run `npm run db:migrate` against `localhost:5432`, and never touch `C:\dev\tz-scout` or the dev services on 5432 and 4222. Work only in `C:\dev\tz-scout-meetings`.
- **Migrations:** generated with drizzle-kit, never hand-written or hand-edited.
- **Module boundaries:** module code imports another module only via its `index.ts` or `contracts/**`.
- **Copy:** UI copy is exactly as written above. Dates use `useFormat()`. Day and month read "Nov 18".
- **Commits:** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A booked future meeting** must not push the next sync's `since` past emails and replies that come before it (Task 3 test "a future meeting does not hide later emails").
2. **A meeting moved or cancelled in HubSpot** updates the tile and the feed on the next sync, without a second `crm.activity.observed` (Task 3 test "a cancelled meeting updates in place").
3. **A committee person with no HubSpot contact** reads "Not contacted" and counts in y (Task 3 test).
4. **An email with no subject or no contacts** still renders a readable row (Task 4 unit tests on the copy builder).
5. **The live adapter** maps every `hs_meeting_outcome` value, and a missing value reads as scheduled (Task 2 unit test).

---

### Task 1: Adapter contract and mock

**Files:**
- Modify: `src/modules/crm/contracts/adapter.ts` (`listActivities` input `meetingsFrom?: string`; output shape per Ruling 3), `src/modules/crm/contracts/types.ts`
- Modify: `src/modules/crm/adapters/hubspot/mock.ts`, `src/modules/crm/db/schema.ts` (`mock_activity`: `contact_external_ids text[] not null default '{}'`, `subject`, `start_at`, `end_at`, `status`), generated migration
- Modify: `src/modules/crm/fixtures.ts` (`mockAddActivity` options `{ contactExternalIds?, subject?, startAt?, endAt?, status? }`, plus `mockSetActivity(ctx, externalId, patch)` to move or cancel a meeting)
- Modify: `tests/contract/crm/adapter.contract.ts` and the live adapter stub so the type check passes (the live fields are Task 2)
- Modify: `docs/spec/crm-sync/crm-adapter-contract.md`
- Test: the contract suite through `tests/integration/crm/mock-contract.test.ts`

**Interfaces:**
- Produces: `Activity = { externalId; kind; occurredAt; actorOwnerExternalId; contacts: { externalId: string; name: string | null }[]; subject: string | null; startAt: string | null; endAt: string | null; status: MeetingStatus | null }`, `MeetingStatus = 'scheduled' | 'held' | 'no_show' | 'cancelled'`, and `mockSetActivity`. The mock gives contact names from `mock_contact` (first and last name) and a null name when the contact is unknown.

- [ ] **Step 1: Failing contract tests:**
  - `listActivities returns contacts with names, subject and meeting times`.
  - `meetingsFrom returns meetings starting after it even when since is later` (a meeting starting 10 days ago, `since` yesterday, `meetingsFrom` 30 days ago → returned).
  - `a meeting's status changes after mockSetActivity`.
- [ ] **Step 2: Run** `npx vitest run tests/integration/crm/mock-contract.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the contract, the mock columns and generated migration, the fixtures, and the doc lines. The live adapter returns the new fields as null or empty until Task 2.
- [ ] **Step 4: Run** `tests/integration/crm`, `tests/unit/crm`, lint and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(crm): richer activities in the adapter contract`.

### Task 2: Live HubSpot reads

**Files:**
- Modify: `src/modules/crm/adapters/hubspot/live.ts` (`activitiesOf`: search properties `hs_email_subject`, `hs_meeting_title`, `hs_meeting_start_time`, `hs_meeting_end_time`, `hs_meeting_outcome`; contact associations by a batch associations read per object type, then a batch contact read of `firstname`, `lastname`; `meetingsFrom` as a second meeting search on `hs_meeting_start_time >= meetingsFrom`, merged by id)
- Test: `tests/unit/crm/hubspot-live.test.ts` (fetch fakes)
- Modify: `docs/spec/crm-sync/crm-adapter-contract.md` if a scope note is needed (check the scopes list at live.ts:112-125; the contact association read needs `crm.objects.contacts.read`, which is already required)

**Interfaces:**
- Consumes: Task 1's `Activity`. Produces: no new names.

- [ ] **Step 1: Failing unit tests:**
  - `maps every hs_meeting_outcome` (COMPLETED → held, SCHEDULED → scheduled, RESCHEDULED → scheduled, NO_SHOW → no_show, CANCELED → cancelled, missing → scheduled).
  - `reads contact names through the associations` ("Pat Lee", a contact with no names → null).
  - `email subject and meeting title land in subject`.
  - `meetingsFrom adds a second meeting search and de-duplicates by id`.
  - `no body property is requested` (assert the request bodies' `properties` lists).
- [ ] **Step 2: Run** `npx vitest run tests/unit/crm/hubspot-live.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the reads above. Batch reads are capped at 100 ids per HubSpot call. Keep each call inside `gateway.call` as today.
- [ ] **Step 4: Run** `tests/unit/crm`, lint and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(crm): read meeting details and contacts from HubSpot`.

### Task 3: Storage, sync and engagement reads

**Files:**
- Modify: `src/modules/crm/db/schema.ts` (`crm.activity` columns per Ruling 4), generated migration
- Modify: `src/modules/crm/services/follow-through.ts` (store the new fields; `since` capped at now; `meetingsFrom` = now − 30 days; update stored meetings in place without publishing)
- Create: `src/modules/crm/domain/engagement.ts` (pure: `meetingHeld(a, now)`, `nextMeeting(rows, now)`, `personStates(rows, contactByPerson, now)`)
- Create: `src/modules/crm/services/engagement.ts` (`engagement(ctx, accountId, now)`), `src/http/routes/v1/accounts/[id]/engagement/route.ts`, `src/http/routes.ts`
- Modify: `src/modules/crm/services/read.ts` (`meetings_held`, `next_meeting` on the handoffs `follow_through`)
- Modify: `docs/spec/web-ui/api-gaps.md`, `docs/spec/crm-sync/follow-through-and-deals.md`
- Test: `tests/unit/crm/engagement.test.ts`, `tests/integration/crm/engagement.test.ts`, `tests/integration/v1/account-page.test.ts` (the route)

**Interfaces:**
- Consumes: Task 1's `Activity`, `mockAddActivity`, `mockSetActivity`; accounts' `getCommittee` (via `@/modules/accounts`) for people and coverage.
- Produces: `engagement(ctx, accountId, now): Promise<{ people: { personId: string; state: 'met' | 'replied' | 'emailed' | 'not_contacted'; at: string | null }[]; engaged: number; total: number; gapRole: string | null } | null>`, `nextMeeting(...) → { at: string; with: string } | null`.

- [ ] **Step 1: Failing unit tests** (`engagement.test.ts`):
  - **Held (Ruling 2):** status held → yes; scheduled with end in the past → yes; scheduled in the future → no; cancelled in the past → no.
  - **`nextMeeting` (Ruling 1):** the earliest future meeting that isn't cancelled; title wins over attendees; "Pat Lee +2" with no title; null when none.
  - **`personStates` (Ruling 6):** met beats replied beats emailed; a call counts as emailed; no link → not_contacted.
- [ ] **Step 2: Failing integration tests** (mock HubSpot, `handedOff()` pattern):
  - `a held meeting counts and the next meeting shows`. `GET /accounts/{id}/handoffs` returns `meetings_held` 1 and `next_meeting` `{ at, with: 'Scoping call' }`.
  - `a future meeting does not hide later emails`. A meeting 5 days ahead is synced, then an email from today is added. The next sync stores the email.
  - `a cancelled meeting updates in place`. `mockSetActivity` sets it cancelled. After the sync, `next_meeting` is null, there is one `crm.activity` row, and only one `crm.activity.observed` is published for it.
  - `engagement lists each committee person`. Ana met, Ben replied, Cy was emailed, and Dee has no contact link (not_contacted). The route returns `engaged` 2, `total` 4, and `gap_role` = the first uncovered required role label.
  - `engagement is 404 for an account the caller cannot see`.
- [ ] **Step 3: Run** the new files. Expected: FAIL.
- [ ] **Step 4: Implement** the pieces under Files, per Rulings 1, 2 and 4-7.
- [ ] **Step 5: Run** `tests/unit/crm`, `tests/integration/crm`, `tests/integration/v1`, `tests/integration/routing/crm-events.test.ts`, `tests/integration/playbooks`, lint and typecheck. Expected: PASS.
- [ ] **Step 6: Commit** `feat(crm): meetings held, next meeting and buyer engagement`.

### Task 4: Feed rows that say who did what

**Files:**
- Modify: `src/modules/crm/domain/activity.ts` (row copy per Ruling 8, as pure functions), `src/modules/crm/services/activity.ts` (who, actor, Scout plan rows)
- Modify: `src/modules/crm/contracts/types.ts` and `src/modules/playbooks/services/package.ts` / `plans.ts` (`startedAt` on `PlanTasks` and `otherPlans`, Ruling 9)
- Modify: `docs/spec/web-ui/api-gaps.md` (row shape), `docs/spec/web-ui/screens.md` §4b item 3 (opens removed for R2d)
- Test: `tests/unit/crm/activity.test.ts`, `tests/integration/v1/account-page.test.ts`

**Interfaces:**
- Consumes: Task 3's stored fields.
- Produces: `ActivityEntry = { id; kind; at; who: string | null; actor: 'person' | 'contact' | 'scout'; summary: string }` (JSON `who`, `actor`, `summary`).

- [ ] **Step 1: Failing unit tests** for each Ruling 8 line, with and without subject or contacts:
  - names "A", "A and B", "A, B and 2 others";
  - a held meeting with no end shows no duration;
  - a booked meeting reads "Meeting booked for Nov 18 with Pat Lee".
- [ ] **Step 2: Failing route tests:**
  - an email row has `who` = the seller's name and `actor` 'person';
  - a reply row has `who` = the contact's name and `actor` 'contact';
  - a Scout row has `who` 'Scout';
  - after accept with a playbook there is a row "Started the {playbook} playbook" at the plan start;
  - no row contains a body field.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Implement** the copy builders, the service, and `startedAt` on the port.
- [ ] **Step 5: Run** `tests/unit/crm`, `tests/integration/v1`, `tests/integration/crm`, lint and typecheck. Expected: PASS.
- [ ] **Step 6: Commit** `feat(crm): activity rows say who did what`.

### Task 5: Web UI tiles, feed rows and committee engagement

**Files:**
- Modify: `web-ui/src/features/account/api.ts`:
  - `Handoffs.counts.meetings`;
  - `follow_through.meetings_held` and `next_meeting`;
  - `ActivityRow.who` and `actor`;
  - `Engagement` type and `engagementQuery`.
- Modify: `web-ui/src/features/account/testing.ts` (fixtures, the `serveAccount` engagement route)
- Modify: `web-ui/src/features/account/AssignedView.tsx`:
  - `Outcomes` tiles in order Meetings held, Replies, Buyers engaged, Opportunity;
  - the Buyers engaged note is amber when `gap_role` is set;
  - `Activity` rows: date, 24px `Avatar` (Scout shows "S"), who in bold over what.
- Modify: `web-ui/src/features/account/RightRail.tsx` (`BuyingCommittee`: a 7px dot plus 12px text per person — green for met/replied, amber for emailed, gray for not contacted; labels from Product decision 2, dates via `useFormat()`)
- Modify: `tests/e2e/` (extend the account plan spec or add `engagement.spec.ts` on the seeded mock: a held meeting, a next meeting, a reply → tiles, feed and committee dots)
- Test: `web-ui/src/features/account/assigned.test.tsx`, `committee.test.tsx`

**Interfaces:**
- Consumes: the Task 3 and Task 4 JSON.

- [ ] **Step 1: Failing web tests:**
  - **Tiles:** "Meetings held" shows `meetings_held` with "Next: Nov 18 with Scoping call". With no meeting it reads "No meeting booked". "Buyers engaged" reads "2 of 4" with the note "No Technical buyer contact yet" (amber class), and has no note when `gap_role` is null.
  - **Feed:** rows show the who and summary text. The Scout row shows an "S" avatar.
  - **Committee:** "Met Nov 4", "Replied Nov 3", "Emailed, no reply", "Not contacted". A person missing from the engagement answer reads "Not contacted". With the engagement query loading or failed, the committee renders without dots.
- [ ] **Step 2: Run** `npm --prefix web-ui test -- assigned committee`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the web tests, web lint and typecheck, then the e2e spec. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web-ui): meetings, buyers engaged and committee engagement`.

## Verification (controller)

- **Full suites:** unit, integration, web and e2e on the throwaway stack.
- **scout-verify** (a `verify-up-<name>.sh` copy pointing at `C:\dev\tz-scout-meetings`): on an assigned account, add mock activity — a held meeting with two contacts, a future meeting, a reply and an email. Run "Check follow-through" as an owner. Check the tiles, the feed rows, and the committee dots and labels.
