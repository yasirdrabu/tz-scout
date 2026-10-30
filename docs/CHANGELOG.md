# Changelog

## 2026-10-30: Taazaa Scout R1c CRM sync

An assigned account now lands in HubSpot with its note and tasks, the rep's replies and deals come back and move the account through the funnel, and HubSpot contacts that marketing qualified arrive in the review queue. It runs on a mock HubSpot that lives in Postgres; the live connector is built but has not yet run against a real portal. This release has the `/v1` API only; screens come from the front end.

**What was built**
- **Handoff push**: `routing.assignment.created` queues a handoff (`crm.handoff.push`). It checks ownership, then writes the company, up to 10 people (primary first), one context note and four tasks (a first touch and follow-ups on days 3, 7 and 14), all owned by the seller. Every write is linked as it happens, so a retry updates instead of duplicating. `POST /v1/accounts/{id}:push` pushes again or retries a failed handoff.
- **Ownership preflight**: CRM implements Routing's `OwnershipPreflight` port (it stays a port). It answers new, assign, stop or blocked with the exact messages in the specs.
- **Undo on decline or withdrawal**: tasks Scout wrote are closed with "Declined in Scout: <reason>" or "Withdrawn in Scout", ownership goes back, and a separate short note is added. A decline that arrives while the push is running stops the push (`cancelled`) and the undo runs on what was written.
- **Batches and messages**: one batch for each leader action (`bulkId`), one message per seller listing the completed handoffs.
- **Follow-through, activity and deals**: activity every 15 minutes, deals hourly, owners daily at 05:00 UTC. A new activity is seen once; a deal event is published only when status or amount changed. A reply or meeting moves the stage to Engaged, an open deal to Opportunity, won to Won, lost to Lost, and an activity by the assigned seller accepts the assignment (`crm_activity`).
- **The CRM check before review**: a new account with a domain is looked up in the CRM (`crm.company.checked`); the queue shows whether the company exists, who owns it and its lifecycle, and Accounts keeps `crm_status` from it.
- **HubSpot qualified leads in**: every 15 minutes Intake reads contacts that became qualified and submits each as an arrival from the `hubspot_qualified` source, linked to its HubSpot company and contact. The rule is editable in `PUT /v1/settings/crm`. A contact with no company goes through intake's normal rules.
- **Inbound webhook**: `POST /v1/inbound/hubspot/{connectionId}` checks the v3 signature (the `client_secret` is a second credential) and answers 200 within a second; deal and engagement events trigger a sync, lifecycle events that match the rule publish `crm.lead.qualified`.
- **Field mapping and setup**: default `taazaa_*` mappings per tenant plus `scout_link`; "Set up HubSpot fields" creates the group `scout_buyer_signals` and only the missing properties.
- **API**: `/v1/accounts/{id}/handoffs`, `/v1/handoff-batches`, `/v1/handoff-messages/{id}`, `/v1/settings/crm` and `/v1/crm/{owners, owners:sync, qualified-leads:simulate, …}`.
- **Backfill and seed**: `scout backfill-r1c <tenant-slug>` gives a workspace built before R1c its CRM defaults and schedules, a company check for each account with a domain and none yet, links from the HubSpot ids accounts already carry, and the qualified-lead poll schedule. `scout seed` runs it for its tenants and loads the sample HubSpot data when the connection is in mock mode. Running either twice changes nothing.
- **Exit test**: on the mock, an agent sends an account, it is scored and assigned by a leader and lands in the mock CRM with the note and four tasks owned by the seller; the batch has one message per seller; the seller's reply makes the next activity poll accept the assignment and move the stage to Engaged; a new deal moves it to Opportunity and a won deal to Won; a second account that is assigned and then declined has its tasks closed and its owner returned; a qualified contact polled from the mock reaches the queue as needs_review, linked.

**New events, jobs and fields**
- Events: `crm.company.checked`, `crm.handoff.cancelled` (internal), `crm.lead.qualified` (internal).
- Fields: `companyLifecycle` and `observedAt` on `crm.company.checked`, `crm.handoff.completed` and `crm.deal.changed`; `bulkId` on `routing.assignment.created`; `reasonLabel` on `routing.assignment.declined`; `externalIds` on the accounts created, updated and person events; `actorOwnerExternalId` on CRM activities; `cursorAt` on a qualified lead.
- Jobs: `crm.company.check`, `crm.handoff.push`, `crm.handoff.undo`, `crm.person.push`, `crm.activity.poll`, `crm.deals.poll`, `crm.owners.sync`, `crm.sync` and `intake.qualified_leads.poll`.
- Tables: the `crm` schema (`link`, `handoff`, `handoff_batch`, `handoff_message`, `owner`, `field_mapping`, `property_setup`, `follow_through`, `deal`, `activity`, `task_link`, `company_check`, `setting`, `webhook_receipt` and the mock tables `mock_company`, `mock_person`, `mock_note`, `mock_task`, `mock_deal`, `mock_owner`, `mock_property`, `mock_activity`, `mock_failure`). On the handoff: `is_repush`, `seller_user_id`, `assigned_by`, `assignment_note`, `cancel_requested_at`, `undone` and `undo_attempts`; the status `cancelled`. `company_check.domain` and `crm_lifecycle`. `setting.deals_polled_until`. `accounts.account.crm_status_at`. `intake.arrival.external_ids` and `intake.crm_lead_poll`.
- Id prefixes: `hof_`, `hbt_`, `lnk_`, `hmg_`, `cow_`, `fmp_`, `dea_`, `cac_`, `whr_`, `blk_`.

**Decisions to know about**
- The mock CRM commits each record on its own, like a real CRM that does not roll back. Mock ids are `mock-co-<n>`, `mock-ct-<n>`, `mock-nt-<n>`, `mock-tk-<n>`, `mock-dl-<n>` and `mock-ow-<n>`, numbered per tenant.
- Links are written per CRM write in their own transaction, so a push that fails and rolls back still leaves its links and a retry finds them.
- `crm.handoff.push` is delivered up to 7 times: 6 push attempts, and a 7th delivery that only marks the handoff `failed` if the job died, so a handoff never stays `running`. Retryable errors are timeouts, 429, 5xx, network errors and transient database errors; a response Scout cannot read, or any other error, fails the handoff and Retry is one click. An account with no website fails with "This account has no website, so HubSpot cannot match it."
- A re-push is a new handoff row (`is_repush`); only the first handoff of an assignment is unique, so `routing.assignment.created` arriving twice still makes one.
- The push counts its attempt before it takes the account lock; the lock only has to come before the first CRM write. Push, undo, person push and sync take the lock `crm:<tenant>:<account>`.
- A decline that finds the push running sets `cancel_requested_at` in its own transaction. The push checks it, and any sibling handoff of the same assignment, before each write. A completed handoff that is undone stays `completed` with `undone` set, and `crm.handoff.cancelled` takes it out of "in CRM" in Routing. Requesting an undo marks every non-queued handoff of the assignment, so a re-push after a decline is refused with "Assign it before pushing."
- "Withdrawn by <name>" names whoever withdrew, falling back to the assigner. Returning ownership skips a replaced seller whose undo was requested.
- Routing applies handoff events only for the account's latest assignment, so stale events for replaced or merged-in assignments are ignored; a cancel for the just-declined latest assignment still lands. A reply or meeting from any actor moves the stage to Engaged, even while an assignment is pending, because the spec sets no actor condition for the stage.
- The deal poll keeps its cursor in `crm.setting.deals_polled_until` (5 minutes of overlap, 24 hours of look-back the first time), because the largest synced time would not advance in quiet periods.
- The qualified-lead poll pages on `cursorAt`, overlaps 5 minutes, and holds its cursor only for errors known to be transient (429, 5xx, network, transient database errors); anything else is logged and skipped so one bad lead cannot stall the poll. A full page of leads at the same instant that does not advance triggers one more read; more than 200 leads at an identical instant remains a known edge. For a custom rule the arrival key is `hubspot:<contactId>:<property>`, because there is no qualification date.
- Intake accepts reserved `.example` domains everywhere, which the mock fixtures need; reserved domains never resolve, so junk `.example` accounts are possible from any source.
- Activity external ids stay the raw HubSpot ids (engagements share one id sequence per portal).
- "Set up HubSpot fields" does not recreate `taazaa_other_offers` or `taazaa_signal_source`; existing v1 properties are left where they are.
- Integrations gained `connectionSettings(ctx, provider)` so CRM can read `portal_id`.
- One dynamic route, `/v1/crm/[resource]`, serves `owners`, `owners:sync` and the other CRM actions, because Next.js folders cannot match `owners:sync` and `:` is not allowed in Windows folder names.
- The Playbooks handoff package is not built yet. With no provider registered, the note holds the Accounts sections only and the tasks use the plain defaults; Playbooks is the next plan.
- The live HubSpot connector has not run against a real portal. The gated contract run (`SCOUT_LIVE_HUBSPOT_TOKEN`) is needed before cutover.

**Final review fixes**
- The activity poll is a fan-out: it stamps `follow_through.sync_queued_at` on up to 200 due accounts and queues one `crm.sync` each (timeout 120 seconds), with no account lock and no CRM call of its own. An account whose sync keeps failing goes to the back.
- Consumers of different event types are not ordered. A decline or withdrawal handled before the assignment's `created` stores a `cancelled` handoff, so nothing is pushed; a reassign's `created` first requests the undo of the replaced assignment.
- The ownership preflight answers 503 ("HubSpot didn't answer. Try again in a minute.") when HubSpot does not answer, so one account of a bulk fails alone; a bulk uses stored checks under 24 hours old.
- Handoff batches show only the handoffs inside the reader's data limit; a batch with any hidden handoff has no name and withheld message texts (`restricted`).
- The deal poll reads at most 1,000 deals a run and, after a full page, continues from the last deal's modified time. Webhooks about unseen deals queue at most one deal poll per 5 minutes (`setting.deals_poll_requested_at`).
- The lifecycle lead rule counts a contact already past the stage.
- Push and person-push retries wait 30 seconds, 2, 10 and 30 minutes, then an hour.
- A give-up undo publishes `crm.handoff.cancelled` for the handoffs it cancels.
- The inbound webhook refuses a malformed or disabled connection with a logged 401.

## 2026-10-27: Taazaa Scout R1b scoring and review

Every account is now scored and explained, lands in a review queue, and can be approved, assigned, accepted or declined by a person, and the agent that sent it can read where it stands. This release has the `/v1` API only; screens come later.

**What was built**
- **Scoring**: fit and intent per approved offer, priority, tiers, best offer, warm-intro and trust adjustments, a plain-words explanation, score history, a weights profile (`GET/PUT /v1/scoring/profile`, reset), signal rules per offer, rescoring of the whole workspace or a practice or source (`POST /v1/rescore`, 202 with a job id) and a nightly ageing rescore.
- **Review and routing**: review statuses and decline reasons, the review queue with its filters and counts, leader insights, status changes (send back, decline, reopen), assignments with an ownership preflight, accept, decline and withdraw, hourly auto-acceptance after the workspace's working days, and stage tracking (arrived, reviewed, assigned, declined).
- **Status for agents**: `GET /v1/accounts/{id}/status` takes an account or an arrival id and returns the stage, review status, tier, owner name, declined reason and note, send-back note and a one-sentence summary.
- **Source feedback and counts by stage**: a source is told when its arrival was declined, sent back, declined by a seller or lost a conflict, once for each source in the chain; batches show counts by stage.
- **Backfill**: `scout backfill-r1b <tenant-slug>` gives a workspace built before R1b its scoring and routing defaults, a review row for every account without one, and a rescore. `scout seed` runs it for its tenants. Running either twice changes nothing.
- **Exit test**: an agent sends an account, it is scored and explained, it shows in the queue as Unvetted with its priority, a leader approves and assigns, the seller accepts, the agent reads the status as assigned with the owner's name, and the stage history shows arrived, reviewed, assigned.

**Decisions to know about**
- A withdrawn assignment returns the stage to reviewed, like a decline. A seller may decline an assignment they have already accepted, not only a pending one; that also returns the stage to reviewed.
- A new score cause, `ageing`, marks the nightly rescore, so score history does not blame a new signal for a score that only moved with time.
- Past owners (for the `own_accounts` data limit) are the sellers of assignments that were accepted and later ended. A declined or replaced pending assignment is not ownership.
- "New from <source>" on an assigned account ends with the assignment.
- "Arrived since" means the account's first arrival; a later arrival from another source shows through "New from".
- A source gets one piece of feedback for each distinct source in the chain, for each cause. Arrival detail shows its feedback to anyone who may see the arrival; the feed is limited to the caller's own source.
- A seller's decline reaches the sending source as feedback with the reason and note, but `get_account_status` does not show it: the status call tells the agent about leader decisions only. The two channels differ on purpose.
- `GET /v1/accounts/{id}/score` returns the `explain_score` object and adds `offer_id`, `summary` and the full explanation.
- An agent that asks about its own arrival before it resolves gets stage arrived and "Received. Matching it to an account."; a rejected one gets "Not accepted: ...".
- Only the person who assigned an account or an owner can withdraw the assignment, though anyone who may assign can still end it by assigning the account to someone else.
- Rescore progress (SCO-E5-S4-AC1) waits for R2 with the weights screen.

## 2026-10-27: Taazaa Scout R1a accounts and intake

Every account now enters Scout through one path and lands as an account with people, facts, signals and its sources recorded. This release has the `/v1` API only; screens come later.

**What was built**
- **Offers and practices**: practices, offers and case studies, with the approval steps (draft, approved, archived).
- **Accounts**: accounts, people with buying roles, facts that remember who said what, signals, duplicate matching, merge, exclusion rules and lists, and data limits that hide accounts a key may not see.
- **Sources and intake**: a registry of person, agent and vendor sources with daily caps, single arrivals, batches, and CSV, Excel and Markdown imports with automatic column mapping. Every arrival is stored exactly as received, then de-duplicated. Arrivals that need a website, a company or a duplicate decision wait for a person and expire after 30 days.
- **Warm intros**: declared intros carry default points; an unconfirmed intro counts half, rounded down.
- **Seed data and the CLI**: `scout seed` now adds a person source for each user, a Local development agent and a development key bound to it. `scout import <tenant-slug> <file>` imports a list as the platform admin.
- **One-path test**: the same company sent as a single arrival, a batch item, a CSV row and an inline arrival is one account with four sources.

**Decisions to know about**
- File imports by a person are not capped by the daily arrival cap; the 10,000-row limit bounds them.
- Every source starts at trust 0.60 until R3.
- Uploaded files are stored in Postgres so the nightly backups cover them.
- An inline arrival on a ruled-out account returns `201` with the stored ids and a rejected status.

## 2026-10-26: Taazaa Scout R0 foundation

The base the rest of Scout builds on. Everything runs on a laptop on mock services; nothing is deployed yet.

**What was built**
- **Platform plumbing**: events saved with the change that caused them, a relay that sends them to NATS, a worker with retries and dead jobs you can retry or discard, a scheduler, an audit log, and health pages.
- **Tenancy and sign-in**: tenants, people, memberships, and roles with permissions and data limits. Microsoft sign-in, plus a developer sign-in for laptops only.
- **API keys and `/v1/me`**: keys with scopes and data limits, shown once and revocable. `/v1/me` returns the tenant and what the key may do.
- **Integrations core on mocks**: connection records, encrypted credentials, a test button and a call log. Test keys always use the mock services.
- **AI runner with rules fallback**: prompts in versioned files, outputs checked, every run logged. If the model is off or fails, rules answer instead.
- **Admin screens**: workspaces, system (test event, dead jobs, schedules), integrations, AI runs, audit and members.
- **The `scout` command**: migrate, seed, worker, relay, scheduler, all-background and web.
- **Container image and compose** for a laptop and for one VM, **backup and restore-check scripts** (not yet run; first run in CI), and **CI** workflows (build, test, staging deploy).

**Security hardening found in review**
- Microsoft sign-in for other organisations is locked to an allowed list of tenant ids, and platform admins match only from the home tenant, so a stranger cannot claim someone's email.
- API keys cannot be given more than the person creating them has, key lookup no longer reveals by timing whether a key prefix exists, and cookie-based writes need the same origin.
- Credentials are bound to their connection when sealed, and secrets are scrubbed from error text and logs.
- Test keys can never reach a live service.

**Whole-branch review fixes (2026-10-26)**
- "Run now" on the System page works for module jobs such as the credentials cleanup.
- Idempotency keys are now isolated per tenant, and a test checks that every table with a tenant id forces row level security unless it is on a short platform-wide list.
- Changes made by a platform admin under support access are marked in the audit log and show a "Support access" badge on the Audit page.
- Calls on sample data no longer change a connection's status or failure count.
- Worker, relay and scheduler logs scrub secrets and drop database query values.
- The laptop compose stack listens on 127.0.0.1 only and has a development-only master key.
- Only platform code, tenancy services, sign-in, the cleanup job and entry points may import the row level security bypass; lint enforces it.
- The Profile and Members pages show permissions in plain words.
- Browser tests allow for slow first compiles and warm the main pages first.

**Checked on the laptop (2026-10-26)**: seed and `/v1/me` return the Taazaa tenant; a test event completes the round trip outbox → NATS → worker in about 140 ms, run through the same function the System page calls (the page click itself is covered by the admin browser test); a forced failing job lands in dead jobs; typecheck and lint are clean, and 80 unit, 199 integration and 9 end to end tests pass.

**Still pending**
- Hosting decision, then the OpenTofu setup for the VM (skipped for now).
- First run of the CI workflows (needs a push), including the backup and restore job.
- Staging steps: backup and restore on staging, Microsoft sign-in with a member and a non-member, the test event on staging.
- Building and starting the container image and compose stacks on a machine with Docker (not possible on this laptop).

## 2026-10-23: Drag-and-drop import, ABM research sheets, practice buckets

- **Drag and drop** on Buyers, Import: drop one or many files. Research sheets (one company per row with a dated signal, decision-makers, pilot, hook and the researcher's score) are recognised by their columns and imported straight away; plain lead lists go straight in when they have a website or work-email column, otherwise you're asked to confirm the columns. Parser in `src/lib/research.ts` reads all four research layouts, including "master" files that stack two.
- **What's kept from research**: the signal (dated, with its source link) becomes a trigger; decision-makers become contacts with titles (published emails matched to the right person); hook, likely problem, proposed pilot and price, value hypothesis, incumbent, caveats and contact route live on the account (Research card) and go into the HubSpot note and task on push. Name-only contacts are matched in HubSpot by name at the same company before creating, so no duplicates.
- **Buckets**: AI Transformation, AI Operating Platforms, Data & Engineering for AI Readiness, AI Marketing Studio (`scripts/setup-buckets.mts`). A sheet is filed by its agent column or file name. Accounts are matched only to their bucket's offers; the researcher's tier is a floor (A with a signal in six months = Act now, A older or B = Good fit, C = Watch). Bucket filter on Buyers, bucket column on Offerings, `taazaa_bucket` HubSpot field (created when someone runs Set up HubSpot fields). Two DRAFT offers for the buckets without one: AI Data Readiness Assessment, 30-Day GTM Audit and Pilot.
- **Held rows**: companies with no website are held on the import page with a box per company; type the website and they come in like the rest.

## 2026-10-23: Lead-sheet import, one handoff message per push

- **Import** (Buyers, Import): drop a CSV, Excel (.xlsx) or Markdown list. Columns are guessed from the headers and confirmed before anything is created. Rows are tied to a company by website or work email (personal addresses are skipped, with the row number and reason). Companies we already have get the new people added and the list tagged; sent ones stay in Sent. New companies are checked against HubSpot (read only), optionally enriched with Apollo, then scored and matched. `?list=` on Buyers shows one list; the account page shows which lists it came from. Parsing and grouping in `src/lib/leadSheet.ts`, import in `src/server/leadImport.ts`.
- **Handoff messages**: every push (bulk or single) writes one message per rep: their accounts, the offer and first buyer for each, the HubSpot links, and the ask (first touch within two working days, mark tasks done). Shown per batch on Sent with a copy button, in place of HubSpot's alert per task. Text in `src/lib/handoff.ts`.
- HubSpot leads are covered by the push tasks; Apollo pulls stay the main source; no in-app Vibe pull planned (docs/HANDOFF.md updated).

## 2026-10-22: Sent

- Pushed accounts leave the Buyers queue and live in **Sent**, grouped into handoff batches ("Oct 16 · 14 to Mike, 15 to Ashkan"). New pulls never put a sent company back in the queue. "Back to queue" undoes it.
- Follow-through per account, read from HubSpot (read only): tasks done and overdue, and emails, calls, meetings and deals since the handoff (counted above a baseline taken at push time, so the previous owner's history doesn't count).
- Fixes: a pull that stops partway (out of credits) now scores everything it saved; tab counts add up instead of overwriting.

## 2026-10-16: Pushing takes the account over

Zach: old HubSpot owners aren't working these. Assigning and pushing now reassigns the company (and the
contacts we push) to the rep, whoever owned it, and the note records who had it. Exception: a company
with an open deal or an existing customer is never reassigned; "push anyway" adds the context and keeps
their owner. Rule in `src/lib/ownership.ts` (tested); setting `takeOverOwnership` (on by default).

## 2026-10-15: Follow-up, offer readiness, calls, proposals, wins, Buying Window report

From the Flash Hub gap analysis (`Campaigns/client-acquisition/workbooks/flash-hub-gap-analysis.md`),
the no-ad-spend items. Paid ads stay on the list for later.

- **Follow-up sequence** (`src/ai/outreachSequence.ts`): 4 emails (day 0, 3, 7, 14) per account,
  signed by the owner, never quoting research data. Shown on the account; each follow-up becomes a
  dated HubSpot task on push, updated in place; listed in the note.
- **Offer readiness** (`src/lib/offerReadiness.ts`, `src/server/offerReadiness.ts`): 100 points,
  offer strength (judged) plus market pull (measured from our accounts and wins), bands at 75 and 60,
  fixes, overrides that survive a rescore. On Offerings (column, score-all) and each offer.
- **Call prep and review** (`src/ai/callPrep.ts`, `src/ai/callReview.ts`, `src/server/calls.ts`):
  discovery plan per account; paste a transcript or Fathom recap to score it on a 7-item checklist,
  with pains in their words, next steps, coaching and a follow-up email; add it to HubSpot as a note.
- **Proposals** (`src/ai/proposal.ts`, `src/server/proposals.ts`): drafted from the account, offer and
  reviewed calls; editable page; copy as text; add to HubSpot. Never quotes our internal research.
- **Wins** (`/wins`, `src/server/wins.ts`): reads closed-won deals from HubSpot (read only), exact stats
  plus patterns, maps wins to offers (feeds readiness), suggested signal rules with one-click add.
  First run: 200 most recent wins, $22.8M, median $48K, median 29 days to close.
- **Buying Window report** (`/report/<company>/<offer>`): clean, printable page of the companies
  showing signals for an offer, people held back. The front-door offer.
- **Database is now UTF-8.** It had been created as WIN1252 (the Windows default), which can't store
  characters like arrows or most non-Latin names; a won deal tripped it. Migrated with
  `scripts/migrate-utf8.mjs` (every table compared value for value), old copy kept as `acq_win1252`;
  `scripts/pg.mjs` now creates UTF-8 databases.

## 2026-10-15: The full story in the HubSpot note, and no overwrites

- The note now carries everything the app shows: tier and what it means, why now, the signals in
  short, how to approach (starred buyer with email, angle, opener, who wrote the brief), the offer
  (what it is, price, sales cycle, usual buyers, proof, case studies), why it fits (each fit part),
  every scored signal with date, source link, why it matters and how to read it, every research
  topic, other signals, what would make it stronger, other offers that fit, all buyers with email
  quality, the company description and full tech stack, and the data date. Capped under HubSpot's
  note limit.
- Nothing a rep writes is lost: the note is fingerprinted when written; if it's been edited in
  HubSpot, a re-push adds a new note instead of overwriting. Existing company and contact values are
  never blanked, owners set by people are kept, and a completed task gets a fresh one.
- "Open in HubSpot" link on pushed accounts (`HUBSPOT_PORTAL_ID`).

## 2026-10-15: Buyers with emails at the act-now accounts

- 60 decision-makers (up to 2 per company plus Vibe's extended search) across 26 of the 30 act-now
  accounts; 58 with email, 41 verified, the rest marked "can't be verified" (catch-all domains).
  Imported with `scripts/import-vibe-contacts.mts`. 11 Taazaa fields created in HubSpot.
- One rule picks who to approach first (`pickPrimary`): a title the offer targets, then seniority,
  then a verified email. Openers go to that person, lead with a new leader, deal, expansion or the
  legacy stack, and never with a front-line job posting.
- Briefs run on rules (`INTEGRATION_ANTHROPIC="mock"`, labelled in the app) until a Claude key is set.

## 2026-10-15: Assign to the team, push to HubSpot with full context

Decision: Zach assigns from here; reps work accounts in HubSpot (the record). Reps don't log in yet.

- **Team roster** (`Seller`): HubSpot owners. Ash (Ashkan Eskandari), Mike Hammerslag, Andy Hickey and
  Zach are on the team; the full roster (active and former owners) lets the app name whoever already
  owns a company. Settings, Team adds or removes people; "Sync owners from HubSpot" needs the owners
  read permission on the private app (not granted yet; roster loaded through the HubSpot connector).
- **Assign** one account (account page) or many (checkboxes and a bulk bar on Buyers). Owner filter
  on the list shows each rep's book.
- **HubSpot check** (read-only): every account looked up by domain. 31 of 64 were already in
  HubSpot, mostly at lead stage, many owned by Rahul, Vijay or Naveen. Shown on the list and the
  account page.
- **Live push** (`src/integrations/hubspot/live.ts`, `src/server/crm.ts`): creates or updates the
  company with the owner; a note with every signal (date, source link, why it matters), the offer
  match and runners-up, the brief and the buyers found; each contact with email, phone and mobile,
  associated and owned; a task for the owner with the opener. Re-pushing updates the same note and
  task. Never takes a company from an active owner unless "push anyway" (which keeps their
  ownership); companies owned by people who've left are reassigned.
- **HubSpot fields** (11 company properties in a "Taazaa buyer signals" group: best offer, tier,
  scores, why now, top signals, research topics) so reps can filter. Created only from Settings on
  purpose; until then pushes send the note, contacts and task.

## 2026-10-15: First real buyers, from Vibe Prospecting

- **Real pull.** 60 companies across four offers (AI Opportunity Map, AgentReady, Modernization
  Blueprint, FDE Sprint), chosen for research intent first, then trigger events. 270 Vibe credits.
  Imported with `scripts/import-vibe.mts` from `data/vibe/`. Result: 30 act now, 21 good fit, 1 watch, 8 ruled
  out (five software vendors, three units of larger parents).
- **Converter** (`src/integrations/prospects/vibeExport.ts`, tested): reads Vibe's export columns;
  keeps 12 months of events; M&A only when the company is a party; no crime stories as lawsuits;
  breaches described by what happened; three most recent news items per type.
- **Industry from NAICS** (`industryFor`): Vibe's "Health Care and Social Assistance" now reads as
  Healthcare services, so hospitals match the offers that target them.
- **Research scoring.** A research score of 60 earns half the rule's points, 80 or more earns all of
  them; related topics don't stack. Act now means a research spike, or research plus another signal.
- **Honest labels.** Briefs written without Claude say "Assembled from rules". Research signals show
  "this week" rather than the import time. Openers never quote research intent, lawsuits or breaches
  to the buyer (rule added to the brief prompt, now account-brief.v1.1). Vibe pulls can't be re-run
  against Apollo by mistake.

## 2026-10-14: Buyers (pull, signals, match to offer)

Zach's direction: the core of the system is finding named buyers and matching each to the offer
they're most likely to buy, before ads. Buyers is now the front page.

- **Pull.** Saved pulls built from an offering (and optionally a segment): industries, size, revenue,
  location, keywords, companies hiring for given titles, companies using given technology, buyer
  titles. Run on demand or daily or weekly. Apollo adapter (`src/integrations/prospects/apollo.ts`)
  uses company search, enrichment, job postings, news and people search; emails are revealed only on
  request. Every pull shows its credit estimate and respects `APOLLO_MAX_CREDITS_PER_RUN`. Mock
  source on sample companies until a key is added; adapter tested against stubbed Apollo responses.
- **Signals.** Hiring, tech stack, headcount growth, funding, leadership changes and news, dated and
  stored per account. Each offering has editable buying signal rules (defaults for all six offers).
- **Match.** `src/lib/matching.ts`, unit tested: fit (industry, size, revenue, region, buyer on
  file; a plain miss caps fit) plus signals (rule points, half-life 45 days; tech and growth don't
  fade), blended 55/45 by default. Every account is scored against every approved offer; the best
  wins. Tiers: act now, good fit no trigger yet, watch, not a fit.
- **Brief and act.** Claude writes why now, the angle, an opener and who to contact for the best
  matches. Assign an owner, push to HubSpot (company plus a task with the brief), or start outreach:
  an outbound lead gets the opener and a booking link through the same show-up sequence as inbound.
  Outbound leads are kept out of inbound form-fill numbers on the scorecard and funnel.
- Navigation regrouped: Find buyers (Buyers, Pulls, Signals), Offer, Campaigns, Pipeline.
- Seed: FDE Sprint and Modernization Blueprint approved so their buyers show up in matching
  (un-approve in the app if their prices aren't locked).

## 2026-10-13: Milestones 0 to 7 on mocks

Built standalone (not inside the AgentWorks shell: it has no company tenancy or Microsoft 365
sign-in and runs a different stack). Everything runs on mock adapters with seeded data.

- **0 Scaffold.** Next.js 15, TypeScript strict, Prisma on embedded Postgres (no Docker), Tailwind,
  NextAuth (dev sign-in now, Microsoft 365 when the Entra variables are set), pg-boss jobs. Company
  scoped database client that refuses cross-company reads and writes (integration tested). Eight
  adapters with mock and live implementations picked by env vars. Claude task layer with versioned
  prompts, Zod-validated structured output and an AiRun log. CI workflow, unit and integration tests.
  Seed: Taazaa with the six productized offerings and six verified case studies; Northwind Sample Co.
- **1 Offer intake.** Create, edit, approve, archive. Claude drafts fields from a URL, PDF, Word or
  PowerPoint file; nothing is used elsewhere until an owner approves. Case studies are their own
  records linked to many offerings. Editing the buyer definition of an approved offering sends it
  back to draft.
- **2 Funnel model.** `src/lib/funnel.ts` with hand-calculated tests. Eight stages with sliders,
  defaults from history (ads, validation, HubSpot meetings and deals) or company defaults, summary
  of cost per won client, profit, return, budget needed and clients from budget. Scenarios saved per
  offering, side by side comparison of up to three, presentation mode.
- **3 Segment scoring.** Claude proposes 8 to 12 segments; LinkedIn audience, Google cost per click
  and matching case studies from mocks; weighted score out of 100 in two halves; reasons per factor;
  overrides that survive regeneration; instant re-rank when weights change; active cap per offering.
- **4 Message tests.** Claude writes 12 to 15 statements in the buyer's words; batches go draft,
  approved (owner), running, complete; mock results arrive over a compressed test window; verdict
  rule unit tested with a 1,000 impression minimum; keep, drop, rewrite, retest; winners library
  with ad copy, headline and discovery question exports.
- **5 Lead validation.** Webhook and simulated form fills; background job runs seven checks plus a
  research note in seconds; all pass validated, any fail not qualified, any unknown to review;
  round robin owner; HubSpot writes (mock, logged to the audit log); overrides with reasons and
  history.
- **6 Show-up agent.** Booking link on validation, confirmation, 24 hour and 1 hour reminders (text
  where consented), pre-call note with an industry-matched case study, three-touch rebook on
  no-show; timing per company in Settings; public booking page for the mock booking link; show-up
  rates by week.
- **7 Weekly scorecard.** Weekly counts built from adapters and records, colour rules unit tested
  (green, amber within 15%, red, grey below minimum sample), rolling four-week average from summed
  counts, Monday diagnosis job naming the biggest bottleneck with owned fixes that carry over until
  done, offline conversion sync.

Known placeholders: margins, funnel defaults and weekly targets are assumptions until Phase 0 data
replaces them. Live HubSpot (8), Meta (9), LinkedIn and Google (10) and hardening (11) are next.
