# Handoff: hosting the Client Acquisition System

For Yasir. Owner: Zach Wiant. Updated 2026-10-23.

## What it is

Taazaa's client acquisition app. It finds companies with a real reason to buy now, matches each to the
offer it's most likely to buy, and hands it to a rep in HubSpot with everything we know. HubSpot stays the
record; reps work there. Zach (and later the team) work in this app.

Today it runs on Zach's laptop against live HubSpot: about 100 real accounts, 29 already handed to Ash and
Mike. Next week it gets ~100 more from the ABM research sheets. It needs a proper home so the team can sign
in with their Microsoft accounts and the data stops living on one laptop.

## What's built

| Area | What it does |
|---|---|
| **Buyers** | The working queue. Companies ranked Act now / Good fit / Watch by fit to an offer plus dated buying signals (research, triggers, pain). Filters by bucket, offer, owner, imported list. |
| **Import** | Drag and drop CSV / Excel / Markdown. ABM research sheets are recognised, filed into their practice bucket (AI Transformation, AI Operating Platforms, Data & Engineering, AI Marketing Studio) and imported with signals, decision-makers, hook, pilot and score. Plain lead lists too. De-duplicates against our accounts and checks HubSpot (read-only). |
| **Pulls** | Apollo company/people search on a schedule (main source once Apollo has API credits). Vibe Prospecting pulls run through Claude and load with scripts. |
| **Push to HubSpot** | Assign an owner, push: company (owner set), contacts, a full context note, a first-touch task and three dated follow-up tasks. Takes over stale ownership, never from an open deal or a customer. Pushed accounts move to **Sent** in batches, with one handoff message per rep and follow-through read back from HubSpot. |
| **Offers and wins** | Offer catalogue with readiness scores, win analysis from HubSpot closed-won deals, call prep and review, proposal drafts, a public "Buying Window" report page. |
| **Admin** | Companies, users and roles, integration status. |

All AI features run on rules (labelled as such) until an Anthropic API key is added; nothing breaks
without it.

## How it's built

| Piece | Choice |
|---|---|
| Runtime | Node 22 or newer (developed on 24) |
| App | Next.js 15 (App Router, server actions), TypeScript strict, Tailwind. One process serves UI and server code. |
| Data | PostgreSQL 17 (**UTF-8**), Prisma 6. Every table has `companyId`; all queries go through a scoped client (`src/lib/db.ts`), so the app is multi-company from day one. |
| Background jobs | pg-boss on the same Postgres, started inside the web process (`src/instrumentation.ts`): scheduled pulls, follow-through checks. **Run one instance.** |
| Sign-in | NextAuth v4 with Microsoft Entra ID (`src/lib/auth.ts`). Only people added in Admin, Users can sign in. |
| Integrations | Each external service sits behind an adapter with a mock and a live implementation (`src/integrations/*`), chosen per service by `INTEGRATION_*` env vars. Live today: HubSpot (private app token), Apollo (key, needs credits). |
| AI | Anthropic SDK through `src/ai/` (one task per file, versioned prompts, every call logged to `AiRun`). |
| Tests | Vitest: 200 unit and integration tests (integration runs against a real Postgres). `npm run ci` = typecheck + lint + tests. Production build verified 2026-10-23. |

Design and decisions: `docs/SPEC.md`, `docs/ARCHITECTURE.md`. What changed and why: `docs/CHANGELOG.md`.

## Microsoft sign-in (Entra ID)

1. **App registration** in the Taazaa tenant: single tenant, platform **Web**.
   Redirect URI: `https://<host>/api/auth/callback/azure-ad` (add `http://localhost:4240/api/auth/callback/azure-ad` too if Zach should test locally).
2. **Client secret**: create one; note its expiry (put a reminder in, the app can't sign anyone in once it lapses).
3. **API permissions**: Microsoft Graph, delegated: `openid`, `profile`, `email`, `User.Read` (the defaults). Grant admin consent. Nothing else is needed.
4. Gives three settings: `AZURE_AD_TENANT_ID`, `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`.
5. **Who gets in**: the app checks the signed-in email (or UPN) against its own user list. Anyone not added in
   Admin, Users is turned away, even with a valid Taazaa account. Zach is an admin and adds people with a role:
   Owner, Operator or Sales. (Restricting by Entra group is not built; not needed for a handful of users.)
6. With the three settings present, the "Sign in with Microsoft" button appears. Set `AUTH_DEV_SIGNIN=false`
   so the developer sign-in (pick a user, no password) is gone. **It must be off before the app is reachable.**

## Azure resources

- **App Service**, Linux, Node 22 LTS (or 24). B1 or B2 is plenty. **Always On**, **one instance** (jobs run in-process).
  Startup command: `npx next start -p $PORT`.
- **Azure Database for PostgreSQL, Flexible Server**, PostgreSQL 17, Burstable B1ms. Create the database as
  UTF-8. Allow the App Service (VNet or Azure services) and, for the one-time data copy, Zach's laptop IP.
- **Key Vault** for the secrets, referenced from App Service settings.
- Optional: Application Insights for errors and uptime.
- Rough cost: $50 to $100 a month.

## Settings

| Variable | Value |
|---|---|
| `DATABASE_URL` | Azure Postgres connection string, with `?sslmode=require` |
| `NEXTAUTH_URL`, `APP_PUBLIC_URL` | `https://<host>` |
| `NEXTAUTH_SECRET` | long random string (Key Vault) |
| `AUTH_DEV_SIGNIN` | `false` |
| `AZURE_AD_TENANT_ID`, `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET` | from the app registration (secret in Key Vault) |
| `INTEGRATION_HUBSPOT` = `live`, `HUBSPOT_PRIVATE_APP_TOKEN`, `HUBSPOT_PORTAL_ID` = `2257150` | token from Vu, **a new one** (see security) |
| `INTEGRATION_PROSPECTS` = `live`, `APOLLO_API_KEY`, `APOLLO_MAX_CREDITS_PER_RUN` = `200` | key from Vu, **a new one** |
| `INTEGRATION_ANTHROPIC` | `mock` for now; `live` plus `ANTHROPIC_API_KEY` when Zach has a key |
| `WEBHOOK_SECRET` | random string |
| Every other `INTEGRATION_*` | `mock` (ads, company data, booking and messaging aren't in use) |

`.env.example` in the repo lists every variable.

## Steps, in order

| # | Step | Who |
|---|---|---|
| 1 | Code: Zach sends `acq-system-code-2026-10-23.zip` (260 files) to start. Create a repo (Azure DevOps or GitHub) and give Zach push access; Claude makes the first commit from the laptop so history starts there. `.env`, `.pgdata/` and `data/` (prospect exports with names and emails) are excluded on purpose and never sent. `.github/workflows/ci.yml` (Postgres 17 service, typecheck, lint, tests) is included. | Zach, then Yasir |
| 2 | Entra app registration (above). | Yasir / IT |
| 3 | Create App Service, Postgres, Key Vault; put the settings in. | Yasir |
| 4 | Pipeline: on a **Linux** build agent, `npm ci` (runs `prisma generate`), `npm run ci`, `npm run build`, deploy. Prisma's engine is platform-specific, so don't build on Windows and ship to Linux. | Yasir |
| 5 | Copy the data from the laptop: `node scripts/copy-to.mjs "<DATABASE_URL>"`. Creates the schema, copies every table in dependency order in one transaction, verifies counts (tested locally: 38 tables, 2,119 rows). Target must be empty. | Zach with Claude, once Postgres accepts the laptop's IP |
| 6 | Turn dev sign-in off, sign in with Microsoft, open Buyers, Sent and Import; on Sent run "Check follow-through" (read-only HubSpot). | Yasir and Zach |
| 7 | Add users in Admin, Users (Ash, Mike, Andy as Sales). | Zach |

Schema changes are applied with `prisma db push` today (no migration files yet). Before the team relies on
it, baseline with `prisma migrate` so later changes are reviewed and repeatable.

## Security notes

- **Rotate the HubSpot token and the Apollo key** when they go into Key Vault: both were pasted in a chat.
- The database holds prospect business contacts (names, titles, work emails) and our HubSpot ids. Keep it
  inside the Taazaa tenant; only invited users can sign in.
- HubSpot writes are limited to companies, contacts, notes and tasks on accounts someone explicitly pushes.
  Everything else (follow-through, wins, ownership checks) is read-only.
- Dev sign-in off in any hosted environment.

## How data gets in

- **Import page**: drag in research sheets and lead lists (above).
- **Apollo** pulls in the app (main source, once the account has API credits).
- **Vibe Prospecting** through Claude, loaded with `scripts/import-vibe.mts` and
  `scripts/import-vibe-contacts.mts` (run against the Azure `DATABASE_URL` after hosting).
- **Buckets** come over with the data; `scripts/setup-buckets.mts <company-slug>` is only for a fresh database.

## Open items (not blocking hosting)

- HubSpot "owners" read scope for the team roster sync. Vu.
- Apollo API credits. Vu.
- Anthropic API key, when the team uses the AI features directly. Zach.
- Zach to approve the two draft offers (AI Data Readiness Assessment, 30-Day GTM Audit and Pilot) and create
  the new "Taazaa practice" HubSpot field (Settings, Set up HubSpot fields).
