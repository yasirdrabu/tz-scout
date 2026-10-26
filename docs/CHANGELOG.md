# Changelog

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
