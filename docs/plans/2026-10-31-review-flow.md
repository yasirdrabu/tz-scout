# Review flow Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A leader works the review queue in the new app: queue with tier tabs, filters, columns,
bulk actions and the peek drawer; send back with a reason; assign to an AE; and an AE accepts or
declines in My accounts; everyone browses All accounts. Backend first (the decided R1 gaps), then
the screens. The account page is not in this plan (it waits for Playbooks minimum, Decision 7);
"Open full page" links to a placeholder until then.

**Architecture:** Backend changes in the owning modules (routing, accounts, scoring, crm, tenancy),
exposed under `/api/v1` through `v1Route`; then `web-ui/src/features/review`, `features/accounts`
screens built on the existing primitives, TanStack Query, MSW tests.

**Spec:** `docs/spec/web-ui/screens.md` §2 Review queue, §3 Peek drawer, §5 Send-back dialog, §6
Assign dialog, §7 My accounts, §8 All accounts; `docs/spec/web-ui/index.md` (C4 to C14);
`docs/spec/web-ui/api-gaps.md` sections routing, accounts, scoring, crm, offers (tables and
Proposed changes) and Decisions taken 1, 2, 3, 4, 5, 8 (binding).

## Global Constraints

- Module boundaries, `v1Route` with explicit permissions, problem+json, snake_case, integration test
  per endpoint (success, permission refusal, validation error, cross-tenant 404).
- No number computed in the browser (C8): counts, facets, tier changes, best-match all come from
  the API.
- Copy exactly as screens.md; no em dashes.
- Never touch `.env` or the dev `scout` database. Commit per task, `git add` specific paths,
  conventional messages with the Co-Authored-By line.

## Review Focus

1. Send back cannot happen without a reason; bulk send back applies one reason to each account and
   reports per-account failures.
2. A manual tier survives a rescore and shows who set it and the scored tier.
3. Notes are tenant-scoped and visible to everyone who can see the account (data limit).
4. Assign from the queue respects the ownership preflight and is async (202): the UI says
   "Sending {account} to HubSpot." and the row shows the handoff state.
5. Polling never moves rows under the pointer (C14 "{n} updates" bar).

---

### Task 1: Review statuses, send back and reasons (routing; Decisions 1, 2)

- [ ] Seed migration and backfill: rename statuses to Ready for review, In review, Approved, Not
  pursued; add "Sent back to source" (`returns_to_source`, counts as reviewed). Reasons get
  `applies_to` including `send_back` and a `note_required` flag; seed the mockup's send-back
  reasons (Not our kind of customer, Already a customer, Duplicate of another account, Bad or
  missing contact, Wrong practice) and keep decline reasons.
- [ ] Status change and `/review-queue/bulk` validate `reason_key` for send back, note only when the
  reason requires it; bulk returns per-account results.
- [ ] Status editor endpoints (Decision 2): `GET/PUT /api/v1/settings/review/statuses`,
  `GET/PUT /api/v1/settings/review/reasons`, `POST /api/v1/settings/review:reset`, with name,
  color, description, set_by, flag_after_hours, order, archive; "In it now" and late counts on GET.
  Reading statuses and reasons needs `review:act` or `assignments:respond` (dialogs), editing
  `settings:manage`.

### Task 2: Queue and accounts reads (routing, accounts, scoring, crm)

- [ ] Queue rows gain what §2 shows: kind/industry, location, fit, intent, source name and via,
  status label/color and who set it, flags (conflicts count, enrichment requested, warm intro),
  note_count, arrived, lead offer (override or scored), tier with `tier_set_by`/`scored_tier`.
- [ ] `GET /api/v1/review-queue/facets` (tier counts, filter option counts), oldest arrival age;
  per-person column preferences `GET/PUT /api/v1/me/preferences/review-queue-columns`.
- [ ] `GET /api/v1/accounts/{id}/review` (status, who and when, stage dates, assignment with names,
  sources, version) and `GET /api/v1/accounts/{id}/changes` (change log).
- [ ] All accounts: `GET /api/v1/accounts` filters owner, stage, practice, source, `q`, sort by stage
  then priority, row fields per §8; `GET /api/v1/accounts/facets` (stage tab counts, won this year);
  CSV export `GET /api/v1/accounts/export`.

### Task 3: Notes, tier, best offer, assignable sellers (accounts, scoring, routing; Decisions 3, 4, 5, 8)

- [ ] `accounts.account_note` table, `GET/POST /api/v1/accounts/{id}/notes` (4,000 characters),
  `note_count` on the summary.
- [ ] `PUT /api/v1/accounts/{id}/tier { tier | null, note? }`: override honoured by scoring, kept
  across rescores, audited.
- [ ] `PUT /api/v1/accounts/{id}/lead-offer { offer_id | null }`.
- [ ] `GET /api/v1/assignable-sellers?account_ids=`: name, focus (practice access), active account
  count, HubSpot user linked, `best_match` with reason per Decision 8 (none when no seller covers
  the offer).
- [ ] My accounts reads: assignments for me with assigner name and note, playbook name when present,
  stage, next step (null until R2), last CRM activity.

### Task 4: Queue screen and peek drawer (web-ui)

- [ ] §2 and §3: tier tabs, Filter popover (shared component), Columns popover saved per person,
  table, bulk bar, banner, states; peek drawer with scores, inline Details selects (best offer,
  tier, status), Why now, Notes, Changes, previous/next, `j`/`k`; URL search params (C10);
  30 s polling with the updates bar (C14).

### Task 5: Send back, Assign, My accounts, All accounts (web-ui)

- [ ] §5 Send-back dialog (single and bulk), §6 Assign dialog (AE cards with Best match, ownership
  warning, note, async toast and handoff state chip), §7 My accounts (accept, decline with reason),
  §8 All accounts (stage tabs from the API, search, filters, export).
- [ ] e2e: leader assigns from the queue, AE accepts; AE declines with a reason and the account is
  back in the queue; send back with a reason.
- [ ] Verify everything (root and web-ui suites, build, e2e).
