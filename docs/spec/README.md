# Taazaa Scout: product and system spec

Status: Draft v2 · Owner: Yasir · Updated 2026-10-25

This folder replaces `docs/SPEC.md` (v1) as the spec of record. v1 stays as history; everything in it
that still holds has been carried into the module specs below. Read this file first, then
`architecture/`, then the module you are building.

## What Scout is

Taazaa Scout finds companies with a real reason to buy now, matches each one to the offer it is most
likely to buy, and puts it in front of a person who decides what happens next. A sales leader reviews
it, adds what they know, and assigns it to an account executive (AE). Scout then hands the account to
the CRM with everything it knows, runs an account-based playbook against it, and measures what each
source, play and dollar actually produced.

Accounts arrive from many places: HubSpot leads that marketing has qualified, data vendors (Apollo,
Vibe), ABM research sheets, CSV lists, partners, outside vendors, and agents run by our own people
(for example an AE's research agent). Every arrival goes through the same steps. People decide; Scout
only scores, drafts and tracks.

Phase 1 runs Taazaa's own pipeline as the first tenant. Clients (Tobi is the first likely one) become
tenants on the same system. Scout is built standalone, but each module is specified so it can move into
Dayko (or AgentWorks / Smart Space) as a module later, in any language.

## Why

Taazaa needs leads that turn into closed deals predictably, and end-to-end clarity on what each
source, playbook and dollar produces. Today that knowledge is spread across research sheets, HubSpot,
people's heads and one laptop.

**Success at 90 days:** Scout generates accounts the sales team closes, predictably, and anyone with
access can see the full path from source to won deal: what it cost, what worked, what didn't, and
how the flywheel (sources → wins → learnings → better playbooks and trust) is moving.

**Anti-goals (a failure even if it technically works):**
- Reps flooded with low-quality agent or vendor leads in the CRM.
- Activity without real pipeline or real wins.
- A score nobody can explain, or a decision Scout made that a person should have made.

## Goals

1. One account-first model: a company with people, buying roles, facts and signals, each fact
   traceable to the source that said it.
2. Many sources, one intake path: API, MCP, CSV with automatic column mapping, webhooks, scheduled
   pulls. Batches tracked as first-class records.
3. Open, scoped access for agents and partners: REST API (`/v1`, OpenAPI) and an MCP server (hosted
   and local) with agent-friendly tools, API keys and OAuth, data scopes and permissions.
4. Human review and assignment before anything reaches a CRM; decline with a tracked reason.
5. ABM playbooks per practice and offer, customisable per account, with outcomes and learnings.
6. Funnel by source and cost per source, automatic where possible, with manual cost lines.
7. Integration management in the app: keys per tenant, test, call log, usage caps.
8. CRM adapters: HubSpot first; Salesforce, Microsoft Dynamics and Dayko Kindle next.
9. Runs anywhere from one container image: laptop, a single VM, or Kubernetes, all defined as code.

## Non-goals (this version)

- Billing, client self-signup, white-labelling.
- Partner and vendor sign-in to the web app (invites come in a later release; they use API keys and
  MCP until then).
- One-click OAuth connections to integrations (phase 2; pasted keys first).
- No-code custom sources. A new source type is added in code.
- Full event sourcing. Tables hold current state; events are a reliable, replayable record.
- Serverless (Lambda) hosting.
- Creative or video generation, landing page builder (carried from v1).

## Who uses it

| Role | Who | Can do (data scope applies on top) |
|---|---|---|
| Platform admin | Taazaa staff running Scout | Create tenants, support any tenant, see system health |
| Owner | Tenant owner (e.g. Zach for Taazaa) | Everything in their tenant; integrations, keys, settings, approvals |
| Leader | CRO, sales leader | Review, enrich, assign, edit playbooks, see all accounts and analytics |
| Seller | AE or SDR | See and work assigned accounts, accept or decline, log outcomes, review if granted |
| Operator | Marketing or ops | Sources, imports, campaigns, offers, analytics |
| Agent | A machine principal (an agent, vendor or partner integration) | Only what its key or OAuth grant's scopes allow |

"Any human can review, data is scoped": review is a permission, not a role. Scopes are defined in
`tenancy-and-access/roles-and-data-scopes.md`. Role names above are the spec's call; Owner, Operator
and Sales from v1 map to Owner, Operator and Seller, and Leader is new.

## Glossary

| Term | Meaning |
|---|---|
| Tenant | One company using Scout (Taazaa, later Tobi). Every row belongs to exactly one tenant. |
| Practice | A line of business inside a tenant (e.g. AI Transformation). Was "bucket" in v1. |
| Offer | Something a tenant sells, inside a practice. Was "offering" in v1. |
| Account | A company we might sell to. Always the unit of work. A sole proprietor gets a shell account named after the person. |
| Person | Someone at an account, with one or more buying roles. Was "contact" in v1. |
| Buying role | Commercial buyer, technical buyer, business owner, influencer, procurement, champion, blocker, user. |
| Fact | One value about an account or person (employees, revenue, contract value), with its source and date. |
| Signal | A dated event that suggests a reason to buy (research intent, trigger, visible pain). |
| Source | Where an arrival came from, in a hierarchy: person → agent → vendor. Each level has a trust score. |
| Arrival | One account (with optional people, facts, signals) sent in by a source. Stored exactly as received. Replaces v1's "lead" and "form submission". |
| Batch | A group of arrivals sent together, with run date, count, notes and files. |
| Warm intro | An arrival vouched for by a named person; adds points that depend on who. |
| Review status | Where an account sits before assignment. Configurable per tenant; defaults: Unvetted, Needs review, Reviewed, Declined. |
| Assignment | A leader giving an account to a seller, with notes. The seller accepts or declines with a reason. |
| Playbook | A template of plays and steps for a practice or offer. Applied to an account as an account plan. |
| Account plan | A playbook applied to one account, possibly customised. Has steps with owners, dates and status. |
| Outcome | A measurable result on an account: reply, meeting, opportunity, won, lost. Feeds scores and learnings. |
| Learning | A retro note on an account; can propose an edit to its playbook template. |
| Handoff | The push of an assigned account to the CRM. |
| Cost line | One cost against a source, batch, account or period; automatic or manual. |

## Modules

Each module owns its tables in its own Postgres schema and exposes a public interface and events.
Codes are used in story IDs and event names.

| Module | Code | Schema | Owns | Spec |
|---|---|---|---|---|
| Tenancy and access | TEN | `tenancy` | tenants, users, memberships, roles, scopes, API keys, OAuth clients | [tenancy-and-access/](tenancy-and-access/index.md) |
| Sources and intake | SRC | `intake` | sources, trust, arrivals, batches, CSV import, duplicate checks, warm intros | [sources-and-intake/](sources-and-intake/index.md) |
| Accounts | ACC | `accounts` | accounts, people, buying roles, facts, signals, conflicts | [accounts/](accounts/index.md) |
| Enrichment | ENR | `enrichment` | enrichment requests, approvals, provider runs, credits | [enrichment/](enrichment/index.md) |
| Scoring and matching | SCO | `scoring` | scoring rules, scores, tiers, best offer, rescoring | [scoring-and-matching/](scoring-and-matching/index.md) |
| Offers and practices | OFF | `offers` | practices, offers, case studies, readiness, segments, win analysis | [offers-and-practices/](offers-and-practices/index.md) |
| Playbooks | PLB | `playbooks` | templates, account plans, steps, briefs, outcomes, learnings | [playbooks/](playbooks/index.md) |
| Review and routing | REV | `routing` | review statuses, queue, assignments, declines | [review-and-routing/](review-and-routing/index.md) |
| CRM sync | CRM | `crm` | CRM connections' mappings, handoffs, links to CRM records, follow-through | [crm-sync/](crm-sync/index.md) |
| Campaigns | CMP | `campaigns` | message tests, ad funnel model, booking and reminders | [campaigns/](campaigns/index.md) |
| Analytics | ANL | `analytics` | account funnel by source, cost ledger, scorecard, flywheel | [analytics/](analytics/index.md) |
| Integrations | INT | `integrations` | connections, encrypted credentials, call log, usage caps | [integrations/](integrations/index.md) |
| AI tasks | AI | `ai` | prompts, AI runs | [ai-tasks/](ai-tasks/index.md) |
| Public API | API | (none) | `/v1` REST surface, outgoing webhooks | [public-api/](public-api/index.md) |
| MCP server | MCP | (none) | agent tools, hosted and local | [mcp/](mcp/index.md) |
| Platform | PLT | `platform` | outbox, processed events, jobs, audit log | [architecture/](architecture/index.md) |

Also: [migration-and-rollout/](migration-and-rollout/index.md) (moving today's data, release order).

## How the spec is written

- One folder per module, `index.md` first: purpose, what it owns, what it depends on, its epics,
  events, API endpoints and MCP tools, open questions.
- One file per epic, named for the feature (`arrivals-and-batches.md`, not `epic-2.md`).
- IDs: epic `SRC-E2`, story `SRC-E2-S3`, acceptance criterion `SRC-E2-S3-AC1`. IDs never get reused.
- Stories: "As a <role>, I want <thing>, so that <why>." Acceptance criteria are testable statements,
  Given / When / Then where it helps.
- Each epic says its release (R0 to R4, see below).
- Specs describe behaviour and contracts, not Node specifics, so a module can be rebuilt in .NET.
- UI copy rules from `CLAUDE.md` still apply: plain words, no acronyms in the UI, no em dashes.

## Releases

| Release | Theme | Done when |
|---|---|---|
| R0 Foundation | Repo, modules skeleton, tenancy, auth, events and jobs, integrations skeleton, compose and IaC | A tenant, users and an API key exist; an event goes web → outbox → NATS → worker on a laptop and on a VM |
| R1 First slice | Agent to CRM | An agent sends an account through MCP or API (one or a batch), or a CSV is imported; it is de-duplicated, scored, matched, reviewed, assigned and pushed to HubSpot within seconds; the agent can see its status. HubSpot activity and deals are read back so funnel stages are recorded to Won. Apollo saved searches and scheduled pulls run. Today's data migrated. |
| R2 ABM | Account page and playbooks | Layout A account page, playbook templates per practice and offer, account plans, conflicts, enrichment requests with approval, buying committee gaps |
| R3 Clarity | Analytics and trust | Funnel by source, cost ledger, trust scores updating from outcomes, outgoing webhooks, scorecard |
| R4 Breadth | More CRMs and campaigns | Salesforce, Dynamics and Dayko Kindle adapters; message tests, ad funnel and booking ported; partner invites |

## Decisions

| # | Decision | By |
|---|---|---|
| D1 | Name: Taazaa Scout. Rename outward-facing names now (product, API, MCP, events, packages); internal names only where confusing. | Yasir |
| D2 | Account-first: the unit is always a company; people hang off it. | Yasir |
| D3 | All sources take the same path. Warm intros add points that depend on who made the intro. | Yasir |
| D4 | Conflicting facts: keep both with provenance; a person keeps one and archives the other; the losing source gets feedback and a small trust drop. | Yasir |
| D5 | Trust scored at person, agent and vendor level. | Yasir |
| D6 | People decide, Scout scores. Nothing reaches a CRM without a human assignment. | Yasir |
| D7 | Agents can flag enrichment; a human approves spend. | Yasir |
| D8 | API and MCP: async by default, batches supported, keys and OAuth, scoped by tenant, source and permission. MCP hosted and local. | Yasir |
| D9 | Modular monolith, strict boundaries, one database, one schema per module. | Yasir |
| D10 | NATS JetStream for events and work queues from day one, fed by a Postgres outbox. | Yasir |
| D11 | Replay means rescoring from stored facts, not full event sourcing. | Yasir |
| D12 | Containers everywhere, defined as code; no Lambda. Compose for laptop and VM, Helm for Kubernetes, OpenTofu for cloud resources. | Yasir (tools: spec's call) |
| D13 | Arrivals stored exactly as received, kept until a tenant deletes its data. | Spec's call |
| D14 | Stack: Next.js (UI, `/v1`, MCP) plus Node worker and scheduler from one codebase; TypeScript; Drizzle; better-auth. | Spec's call, approved |
| D15 | Account funnel: arrived, reviewed, assigned, engaged, opportunity, won; exits lost and declined. | Spec's call, approved |
| D16 | Costs automatic where possible; people add line items. Usage caps per integration and per key: warn at 80%, block at 100%. | Spec's call, approved |
| D17 | Rebuild in this repo on a branch; today's code is the reference. Migrate today's data. | Spec's call, approved |
| D18 | Credentials encrypted in the database first; one-click OAuth later. | Yasir |
| D19 | CRMs: HubSpot, then Salesforce, Dynamics, Dayko Kindle. | Yasir |
| D20 | Tenants from day one; Taazaa first, Tobi later; strictly separate per tenant. | Yasir |
| D21 | Source trust moves priority by at most ±5 points and never changes fit or intent. New sources start at 0.60. | Spec's call |
| D22 | The CRM handoff starts on assignment. A seller's acceptance is implied by acting on the account in the CRM, or after 2 working days without a decline. A decline or withdrawal undoes the handoff (tasks closed, previous owner restored). | Spec's call |
| D23 | Everything enters through SRC arrivals, including enrichment results and agent `add_person` / `add_signal` (targeted arrivals; people and signals resolve inline). | Spec's call |
| D24 | Warm-intro points are owned by SRC (SRC-E5 is canonical: relationship defaults 15/10/12/8/5/3, per-introducer overrides, unconfirmed counts half, 0 to 20, strongest counts); SCO only reads them. Basic warm intros ship in R1; the confirmation flow and the rules screen in R2. | Spec's call |
| D25 | Accounts carry `practice_ids` (may be empty), owned by ACC, set from `practice_hint`, file-import recognition or a person. Scoring uses approved offers in those practices, or all approved offers when empty. The "practices" data limit matches `practice_ids` or the best offer's practice. | Spec's call |
| D26 | v1 rows whose module ships after R1 are parked unchanged in a read-only `legacy_v1` schema and imported by each later release; seeded demo data is not migrated; the analytics rebuild runs when Analytics ships (R3). | Spec's call |
| D27 | R1 ships the layout-A review view without the conflicts box, the Enrich button, committee gaps or the playbook section; the assign dialog has no playbook picker until R2. | Spec's call |
| D28 | HubSpot: polling is the primary path (qualified leads and activity every 15 minutes, deals hourly). Scout does not register webhook subscriptions; hand-configured webhooks are optional and verified with an optional `webhook_client_secret` credential. | Spec's call |
| D29 | No dependency cycles: TEN defines `SourceValidator` and ACC defines `SourceInfoProvider` (both implemented by SRC); ACC defines `MergeGuard` (implemented by CRM). `add_person` / `add_signal` handlers call SRC directly. | Spec's call |
| D30 | Mock or live is set only by the per-connection mode in the database (plus `SCOUT_FORCE_MOCK`); no `INTEGRATION_*` env vars. Mock CRM state lives in Postgres mock tables in the `crm` schema. | Spec's call |
| D31 | v1's `lead_research` AI task is dropped (the brief's overview covers it). The v1 form webhook alias stays live until every live form uses a per-form token, not until a fixed release. | Spec's call |
| D32 | CRM read-back is in R1: activity polled every 15 minutes and deals hourly, publishing `crm.activity.observed` and `crm.deal.changed`; implied acceptance and stages to Won work from R1. Analytics views stay R3. | Yasir |
| D33 | Apollo saved searches and scheduled pulls are in R1; person-requested enrichment with approval stays R2. | Yasir |
