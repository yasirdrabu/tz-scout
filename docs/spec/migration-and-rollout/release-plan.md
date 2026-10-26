# Release plan

Releases from `docs/spec/README.md`, broken down by module, with what can run in parallel. Each
release is done when its exit criteria pass on the staging VM, typecheck, lint (including module
boundaries) and tests pass, and `docs/CHANGELOG.md` has a note.

## R0 Foundation

| Module | Scope |
|---|---|
| Platform | Repo layout, outbox, relay, NATS streams, consumers with idempotency, retries, dead jobs, scheduler, audit log, health page |
| Tenancy and access | Tenants, users, memberships, roles, Microsoft sign-in, dev sign-in for laptops only, API keys with scopes and data limits |
| Integrations | Connection records, encrypted credentials, test button, call log (mock adapters only) |
| AI tasks | Task runner, prompt files, AI run log |
| Infra | Image with roles; compose for laptop and VM; OpenTofu for the VM on Hetzner or Azure and Cloudflare DNS; CI pipeline |

Exit: a tenant, users and an API key exist; an event goes web → outbox → NATS → worker on a laptop and
on the staging VM; dead jobs show in Admin; restoring a nightly backup works.

R0 exit status (updated 2026-10-26):

- [x] Tenant, users and an API key exist on a laptop; `/v1/me` returns the tenant (2026-10-26).
- [x] Test event round trip outbox → NATS → worker on the laptop through the same function the System page calls (the page click itself is covered by the admin browser test), about 140 ms (2026-10-26).
- [x] A forced dead job shows in the dead jobs list (`listDeadJobs`; the System page itself is covered by the admin browser test) on the laptop (2026-10-26).
- [x] Typecheck, lint, unit and integration tests, and end to end tests pass (2026-10-26).
- [ ] Test event round trip on the staging VM. Pending: hosting is undecided.
- [ ] Backup, then restore check, on staging. Scripts are written; they run for the first time in CI.
- [ ] CI first run (needs a push).
- [ ] Microsoft sign-in on staging as a member and as a non-member. Pending the staging VM.
- [ ] OpenTofu for the VM (skipped until the hosting decision).

## R1 First slice (agent to CRM)

| Module | Scope |
|---|---|
| Sources and intake | Source registry (person, agent, vendor), arrivals one at a time and in batches, CSV import with automatic column mapping, duplicate check, basic warm intros (declare, default points, unconfirmed counts half; confirmation flow and rules screen in R2), HubSpot qualified leads in (SRC-E6 with CRM-E6), v1 form webhook alias (CMP-E4) |
| Accounts | Accounts, people with buying roles, facts with provenance, signals |
| Scoring and matching | Fit, intent, warm-intro points, priority, tiers, best offer, explain score, rescore |
| Offers and practices | Practices, offers, case studies (migrated; editing carried from v1) |
| Review and routing | Review queue with configurable statuses, assign (no playbook picker in R1), accept, decline with reason |
| CRM sync | Adapter contract, HubSpot connector, ownership preflight, handoff push and undo on decline, batches and messages, follow-through on Sent, links, `fetchQualifiedLead`, and read-back (D32): activity poll every 15 minutes and deal poll hourly publishing `crm.activity.observed` and `crm.deal.changed` (CRM-E5) |
| Review and routing (stages) | Implied acceptance from CRM activity; stages engaged, opportunity, won and lost recorded from R1, so funnel history exists before Analytics ships in R3 |
| Enrichment | Apollo saved searches and scheduled pulls with credit estimates and caps, results recorded through SRC arrivals (ENR-E2, E3 caps, E4; D33). Migrated v1 pulls start paused until the new Apollo key is entered. Person-requested enrichment with approval stays R2; Vibe stays file import |
| Playbooks (minimum) | `HandoffPackageProvider` assembling the note content, opener and follow-up sequence for the push; the account page **review view** in layout A (header, score strip, why now, account facts, people, Approve and assign) without the conflicts box and the Enrich button (spec's call, D27). Plans, the full page and the playbook section follow in R2 |
| Public API and MCP | `/v1` for arrivals, batches, status; hosted and local MCP with the intake and status tools |
| Migration | MIG-E1 (R1 modules migrated; later-release rows parked in `legacy_v1`, seed data skipped, D26), then cutover (below) |

Exit: an agent sends an account through MCP, or a batch through `/v1`, or a CSV is imported; it is
de-duplicated, scored and matched; a leader reviews and assigns it; it lands in HubSpot within seconds
with note and tasks; the agent sees its status. A reply or meeting the rep logs in HubSpot moves the
account to Engaged within 15 minutes, and a new deal moves it to Opportunity within an hour. A
scheduled Apollo pull runs and its accounts reach the review queue. v1 data migrated and verified. The
team works in Scout.

## R2 ABM

Full account page (layout A: conflicts box, Enrich button, playbook section, stage-dependent order),
playbook picker in the assign dialog, playbook templates per practice and offer, account plans and
steps as CRM tasks, conflicts between sources, enrichment requests with approval, buying committee gaps,
warm-intro confirmation and rules screen, field mapping editor (CRM-E7-S3), per-form web form endpoints
(SRC-E6, CMP-E4), import of call reviews and proposals from `legacy_v1`.

Exit: a leader reviews an account on the new page, resolves a conflict, approves an enrichment, applies
a playbook, assigns it, and the rep sees the plan's steps as HubSpot tasks.

## R3 Clarity

Analytics (funnel by source, cost ledger, source performance, flywheel, account scorecard rows,
replay over the stage and CRM events recorded since R1), trust scores updating from outcomes and
conflicts, outgoing webhooks.

Exit: the CRO sees cost per won client and win rate by source for the last quarter, and numbers match a
hand check on 10 accounts.

## R4 Breadth

Salesforce, Dynamics and Dayko Kindle connectors; Campaigns (message tests, ad funnel, ad spend,
booking and reminders) ported; scorecard ad and meeting rows; partner invites to the web app.

## What runs in parallel

| Track | Can start | Notes |
|---|---|---|
| Infra (image, compose, OpenTofu, CI) | R0 day one | No dependency on modules |
| Platform + Tenancy | R0 day one | Everything else needs them |
| Accounts + Offers schemas and contracts | R0 week 2 | Contracts first so Intake and Scoring can build against them |
| Intake, Scoring, Routing | R1, in parallel against contracts | Integrate when Accounts lands |
| CRM sync | R1, against the mock CRM | Live HubSpot tested last |
| Public API + MCP | R1, once Intake services exist | |
| Migration | R1, as soon as Accounts, Intake and CRM tables exist | Run against a v1 snapshot every week |

## Rename to Taazaa Scout (D1)

Outward-facing names change in R0: product name in the UI and page titles ("Taazaa Scout", "Scout"
after first mention), package name `taazaa-scout`, image `scout`, API host `scout.taazaa.ai`, MCP
server name `scout`, local MCP package `@taazaa/scout-mcp`, event subjects `scout.*`, API key prefixes
`scout_live_` and `scout_test_`, HubSpot property group "Scout buyer signals" (existing `taazaa_*`
properties kept and mapped). Inside the code, v1 names change only where they are confusing ("bucket"
→ practice, "offering" → offer, "lead" → arrival, "contact" → person, message test "batch" → message
test).

## Cutover from laptop to VM (MIG-E2)

1. Provision staging and production VMs with OpenTofu; DNS `scout.taazaa.ai` on Cloudflare.
2. Entra ID app registration for `https://scout.taazaa.ai` (single tenant, `openid profile email
   User.Read`), secret into the VM's secret store with an expiry reminder.
3. **Rotate keys** (HANDOFF security notes): a new HubSpot private app token (with owners read added)
   and a new Apollo key, entered in Integrations. The old token and key are revoked after cutover.
   They were pasted in a chat and must not be reused.
4. Weekly dry runs of the migration against a v1 snapshot during R1.
5. Cutover day: announce a freeze; set v1 read only (stop its web process); take a final `pg_dump`;
   run `scout migrate-v1`; verify hard checks; enter rotated keys; turn dev sign-in off
   (`AUTH_DEV_SIGNIN=false`); smoke test: sign in with Microsoft, open review queue and Sent, run
   "Check follow-through" (read only), push one test account to a HubSpot sandbox company.
6. Add users (Ash, Mike, Andy as Sellers; Zach as Owner and Leader). Point any forms at the new
   webhook; the v1 path alias stays on.
7. Keep v1's database dump and the laptop database read only for 14 days, then archive it.

This replaces the Azure App Service plan in `docs/HANDOFF.md`.

## Stories

### MIG-E2-S1 Cutover
As Zach, I want to move from the laptop to Scout in one planned step, so that the team keeps working.
- MIG-E2-S1-AC1 The steps above are a checklist in this file, each ticked with who and when.
- MIG-E2-S1-AC2 After cutover, the old HubSpot token and Apollo key are revoked and a test call with them
  fails.
- MIG-E2-S1-AC3 Dev sign-in is off in staging and production (`/signin` shows only Microsoft).
