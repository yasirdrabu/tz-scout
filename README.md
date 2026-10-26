# Client Acquisition System

Taazaa's internal tool for taking an offering from "who should we sell to" to "what did a won client
cost". Phase 1 runs on Taazaa's own pipeline; later it becomes a multi-client product.

Spec: `docs/SPEC.md`. Build plan: `docs/BUILD_PLAN.md`. Code map and conventions: `docs/ARCHITECTURE.md`.
What changed per milestone: `docs/CHANGELOG.md`.

## Run it

```bash
npm install
npm run dev
```

`npm run dev` starts a local Postgres (embedded, port 5440, data in `.pgdata/`), syncs the schema,
seeds on first run, and serves the app on http://localhost:4240. No Docker, no admin rights.

Sign in with the dev sign-in and pick a seeded user:

| User | Role |
|---|---|
| zach.wiant@taazaa.com | Admin, Owner of Taazaa |
| operator@taazaa.test | Operator |
| sdr@taazaa.test, ae@taazaa.test | Sales (round robin lead owners) |
| owner@northwind.test | Owner of Northwind Sample Co (proves company isolation) |

Reseed any time: `npm run dev -- --seed` or `npm run db:seed` (with Postgres running: `npm run db`).

## What's real and what's sample data

Everything runs end to end on **mock adapters** with seeded data: HubSpot, Meta, LinkedIn, Google Ads,
company data, booking, email and SMS, and Claude. Each one sits behind an interface in
`src/integrations/<name>/` and switches to live with `INTEGRATION_<NAME>=live` plus credentials (see
`.env.example`). Claude goes live with `INTEGRATION_ANTHROPIC=live` and `ANTHROPIC_API_KEY`; every
call, mock or live, is logged to the `AiRun` table and visible in Admin.

The seed is Taazaa's six productized offerings (from the Sep 10 marketing handoff) with their locked
or working prices, the six verified case studies, and ten weeks of synthetic pipeline history. Margins,
conversion rates and targets are placeholders until the Phase 0 manual round replaces them.

## Turning on real buyers (Apollo)

1. In `.env`, set `APOLLO_API_KEY` to your Apollo API key (a master key, so people search works) and
   `INTEGRATION_PROSPECTS="live"`.
2. Optional: `APOLLO_MAX_CREDITS_PER_RUN` (default 150) caps what one pull may spend. A pull of 25
   companies uses about 52 credits (search, enrichment, job postings, news). People search is free;
   revealing an email costs a credit and only happens when someone clicks it or starts outreach.
3. Restart `npm run dev`, open **Pulls**, use "Clear sample companies", then run a pull.

For real briefs, also set `INTEGRATION_ANTHROPIC="live"` and `ANTHROPIC_API_KEY`.

## Real data only (since 2026-10-15)

The dev database now holds only real records: Taazaa, Zach, the six offerings, six case studies,
and companies pulled from Apollo. All integrations are set to live; anything without credentials
says "not connected" instead of inventing numbers. The sample data was removed after a full copy
was kept as the Postgres database `acq_backup_20261015_sample`. `npm run db:seed:sample` WIPES the
database and reloads sample data; only use it on a separate demo copy. The browser specs
`smoke`, `flows` and `buyers` expect sample data; `real-empty` checks every page on real data.

## Pulling buyers from Vibe Prospecting (while Apollo is out of credits)

Vibe runs through the Vibe connector in Claude (Vu's account, Vibe credits), not from the app yet.

1. In Claude, build the pull with free previews (`fetch-entities`, `enrich-business`,
   `fetch-businesses-events`), get a cost estimate, and export only after an explicit OK.
2. Load the export with `get-dataset` (`load_into: "context"`, free for exported data) and save the
   result as `data/vibe/<date>-<offering-slug>.json`. The offering slug links the pull to an offer.
3. Check the mapping without writing: `node --env-file=.env --import tsx scripts/import-vibe.mts taazaa --dry data/vibe/<file>.json`
4. Import, with the credits Vibe charged: `node --env-file=.env --import tsx scripts/import-vibe.mts taazaa data/vibe/<file>.json:75`
   Without an Anthropic key, prefix `INTEGRATION_ANTHROPIC=mock` so briefs are assembled from rules
   (the app labels them that way).

People (emails) at those accounts: fetch prospects in Claude filtered to the accounts' Vibe business
ids, enrich with emails, quote the cost, export on an OK, save the `get-dataset` page as JSON, then
`node --env-file=.env --import tsx scripts/import-vibe-contacts.mts taazaa data/vibe/<file>.json`
(add `--dry` to preview). The best title for each account's best offer becomes the primary contact.

The import keeps events from the last 12 months, keeps mergers only when the company is a named
party, skips crime stories in the legal feed, maps NAICS codes to our industry words, and rules out
software vendors and units of larger parents (with an "Include anyway" override in the app).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Postgres + schema + Next.js dev server on 4240 |
| `npm run db` | Postgres only (for tests or scripts) |
| `npm run db:seed` | Reseed (wipes and rebuilds the dev database) |
| `npm test` | Unit tests plus integration tests against `acq_test` |
| `npm run typecheck`, `npm run lint` | Static checks |
| `npm run ci` | Typecheck, lint, test |
| `npm run e2e` | Browser smoke test (dev server must be running; uses installed Edge) |

## Going live, in order

1. **Microsoft 365 sign-in**: Entra ID app registration, then set `AZURE_AD_*` and `AUTH_DEV_SIGNIN=false`.
2. **Claude**: `INTEGRATION_ANTHROPIC=live`, `ANTHROPIC_API_KEY`. Default model `claude-opus-5-5`.
3. **HubSpot** (milestone 8): private app token; lead status, notes, meetings, deals.
4. **Meta** (milestone 9): access token and ad account; test launches, results, offline conversions.
5. **LinkedIn and Google Ads** (milestone 10): when API access is approved.
6. **Hosting**: any Node host plus managed Postgres. `npm run build && npm start`; set `DATABASE_URL`.

## Note for this laptop

Windows Application Control blocks Next.js's native compiler here, so Next falls back to its WASM
compiler. The first load of each page after a restart takes 30 to 80 seconds; after that it's quick.
A production build (`npm run build`) avoids this for demos.
