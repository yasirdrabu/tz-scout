# Taazaa Scout

Scout takes accounts from agents, vendors and people, scores and matches them to Taazaa's offers, lets
a leader review and assign them, and hands them to the CRM with context. It is multi-tenant from day one:
Taazaa is the first tenant.

This branch holds the R0 foundation: platform plumbing (outbox, relay, NATS, worker, scheduler, dead
jobs), tenancy and sign-in, API keys with `/api/v1/me`, integrations on mock adapters, the AI task runner and
admin screens. Specs are in `docs/spec/` (start at `docs/spec/README.md`); release scope is in
`docs/spec/migration-and-rollout/release-plan.md`; changes are in `docs/CHANGELOG.md`.

## Run it on a laptop

Needs Node 22 or later.

```bash
npm install
cp .env.example .env        # then fill SCOUT_MASTER_KEY and AUTH_SECRET (see below)
npm run services:local      # Postgres 17 and NATS, no Docker. Leave it running.
npm run scout -- migrate
npm run scout -- seed       # prints a development API key for the taazaa tenant
npm run scout -- all-background   # worker, relay and scheduler (second terminal)
npm run dev                 # the backend on http://localhost:4240, reloads on change (third terminal)
cd web-ui && npm install && npm run dev   # the app: http://localhost:5173 (fourth terminal)
```

The screens live in `web-ui/` (React and Vite, its own npm package; see `web-ui/README.md`). Its dev
server proxies `/api` and the health checks to the backend. Open the app on 5173: the backend on 4240
serves only the last built copy of the app (`npm run build`), if any.

With Docker instead of `services:local`: `docker compose -f infra/compose/docker-compose.yml up -d`.

Bootstrap (`DATABASE_SUPERUSER_URL`) must run against the app database (`scout`), not `postgres`, or the module schemas get no grants for the app role.

Import a list into a workspace, as the platform admin (the worker then processes it):

```bash
npm run scout -- import taazaa tests/fixtures/imports/research-a.csv
```

Bring a workspace built before R1b up to date (scoring and routing defaults and schedules, a review row and queue entry for every account that has none, and a rescore of every account). Seed does this for its own tenants; it is safe to run again:

```bash
npm run scout -- backfill-r1b taazaa
```

Bring a workspace built before R1c up to date (CRM defaults and schedules, a company check for every account with a domain and none yet, links from the HubSpot ids accounts already carry, and the qualified-lead poll schedule). Seed does this for its own tenants and loads sample HubSpot data while the HubSpot connection is in mock mode; it is safe to run again:

```bash
npm run scout -- backfill-r1c taazaa
```

Send an arrival with the development key that seed printed (it is bound to the Local development agent):

```bash
curl -X POST http://localhost:4240/api/v1/arrivals \
  -H "Authorization: Bearer <key from seed>" -H "Content-Type: application/json" \
  -d @tests/fixtures/imports/miami-dade-arrival.json
```

The answer has a `status_url`. Fetch it with the same key until `status` is `resolved` and it shows an `account_id`. With the worker running, read the explained score at `GET /api/v1/accounts/{account_id}/score` and where it stands at `GET /api/v1/accounts/{account_id}/status` (it reads "Waiting for review." until a person approves and assigns it).

Check it: `curl -H "Authorization: Bearer <key from seed>" http://localhost:4240/api/v1/me` returns the tenant.
Open http://localhost:5173 and sign in with developer sign-in (needs `AUTH_DEV_SIGNIN=true` on the backend,
never in production). In Admin, System health, "Send test event" shows the round trip through the outbox,
NATS and the worker.

Generate the secrets with `openssl rand -base64 32` (master key) and `openssl rand -hex 32` (auth secret).
Set `SCOUT_FORCE_MOCK=true` to keep every outside service on its mock.
Behind a load balancer or reverse proxy, set `SCOUT_TRUSTED_PROXY_HOPS` to the number of proxies that
append to `X-Forwarded-For` (usually 1). With the default 0 the header is ignored, because a client can
forge it, and audit entries and API key "last used" record no IP.

## Tests and checks

```bash
npm run typecheck
npm run lint
npm test          # unit and integration (needs the local services running)
npm run e2e       # Playwright; starts the backend on 4240, the web-ui dev server on 5273 and a throwaway database
cd web-ui && npm run typecheck && npm run lint && npm test && npm run build   # the app's own checks
```

## Build

```bash
npm run build     # the web-ui app into web-ui/dist (install its packages first with `npm --prefix web-ui ci`), then dist/cli.js
node dist/cli.js <migrate | seed | backfill-r1b | backfill-r1c | worker | relay | scheduler | all-background | web>
```

`npm run dev` runs `scout web` from source with `tsx watch` and reads `.env`; `npm start` runs the built
`dist/cli.js web`. The container image (`infra/docker/`) runs the same CLI; the role is picked by the command.

## Deploy

Design and runbook: `docs/spec/architecture/deployment-and-iac.md`. The single VM stack is
`infra/compose/docker-compose.vm.yml` with Caddy or a Cloudflare Tunnel in front. Hosting is not decided
yet, so nothing is deployed.

The image serves the web-ui app and the API from one origin (spec W2): the app at `/`, the API at `/api/v1`,
sign-in at `/api/auth`, health at `/healthz` and `/readyz`. The app's hashed files under `/assets` cache
for a year; every other GET (deep links under `/t/...`, `/admin/...`, `/signin`) gets the app's
`index.html` with `no-cache`; unknown `/api` paths get the API's problem+json 404. `scout web` is one Node
HTTP server (Hono) that does all of it; it reads the app from `WEB_UI_DIST` (default `web-ui/dist`; the
image sets it) and stops gracefully on SIGTERM, finishing in-flight requests for up to 10 seconds.

Local development does not use this: run the app from its Vite dev server (`cd web-ui && npm run dev`,
port 5173, proxying to the backend on 4240) and sign in with developer sign-in. `npm run build` uses
the packages already installed in `web-ui/`, so it is safe while the dev server runs.

Notes for the VM:

- Run every compose command with `--env-file /opt/scout/.env`, not just `up`. The file holds the passwords
  the compose file requires.
- Set `COMPOSE_PROFILES=tunnel` (Cloudflare Tunnel) or `public-ip` (Caddy on a public address) in that file
  so a plain `up -d` starts the edge service.
- `POSTGRES_PASSWORD`, `SCOUT_APP_DB_PASSWORD` and `SCOUT_ADMIN_DB_PASSWORD` end up inside database URLs, so
  they must be URL-safe. Use `openssl rand -hex 32` for each.
- Set `SCOUT_ENV=production`. The image sets `NODE_ENV=production`, so Scout's own
  production rules (no dev sign-in, secure cookies, required secrets) follow `SCOUT_ENV` first, then
  `NODE_ENV`. A laptop leaves it empty.
- `AZURE_AD_ALLOWED_TENANT_IDS` lists the Microsoft tenant ids whose people may be matched by email the
  first time they sign in. It defaults to `AZURE_AD_TENANT_ID`. A client's people cannot sign in until
  their tenant id is added.
- `.env.example` lists every variable.

## Code map

`src/platform` (outbox, relay, worker, scheduler, audit), `src/modules/*` (tenancy, integrations, ai),
`src/http` (the Hono server, its route table and the route handlers: `/api/v1`, `/api/auth`, health), `web-ui/` (the app's screens), `src/entry` (the `scout` CLI and seed). Modules talk through their
public interface; lint enforces the boundaries.

The previous version of this tool (v1) is described in `docs/ARCHITECTURE.md` and the older entries of
`docs/CHANGELOG.md`.
