# Taazaa Scout

Scout takes accounts from agents, vendors and people, scores and matches them to Taazaa's offers, lets
a leader review and assign them, and hands them to the CRM with context. It is multi-tenant from day one:
Taazaa is the first tenant.

This branch holds the R0 foundation: platform plumbing (outbox, relay, NATS, worker, scheduler, dead
jobs), tenancy and sign-in, API keys with `/v1/me`, integrations on mock adapters, the AI task runner and
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
npm run dev                 # http://localhost:4240 (third terminal)
```

With Docker instead of `services:local`: `docker compose -f infra/compose/docker-compose.yml up -d`.

Bootstrap (`DATABASE_SUPERUSER_URL`) must run against the app database (`scout`), not `postgres`, or the module schemas get no grants for the app role.

Import a list into a workspace, as the platform admin (the worker then processes it):

```bash
npm run scout -- import taazaa tests/fixtures/imports/research-a.csv
```

Send an arrival with the development key that seed printed (it is bound to the Local development agent):

```bash
curl -X POST http://localhost:4240/v1/arrivals \
  -H "Authorization: Bearer <key from seed>" -H "Content-Type: application/json" \
  -d @tests/fixtures/imports/miami-dade-arrival.json
```

The answer has a `status_url`. Fetch it with the same key until `status` is `resolved` and it shows an `account_id`.

Check it: `curl -H "Authorization: Bearer <key from seed>" http://localhost:4240/v1/me` returns the tenant.
Sign in with the developer sign-in form (needs `AUTH_DEV_SIGNIN=true`, never in production). In Admin,
System, "Send test event" shows the round trip through the outbox, NATS and the worker.

Generate the secrets with `openssl rand -base64 32` (master key) and `openssl rand -hex 32` (auth secret).
Set `SCOUT_FORCE_MOCK=true` to keep every outside service on its mock.

## Tests and checks

```bash
npm run typecheck
npm run lint
npm test          # unit and integration (needs the local services running)
npm run e2e       # Playwright; starts its own server on 4240 and a throwaway database
```

## Build

```bash
npm run build     # Next.js standalone build plus dist/cli.js
node dist/cli.js <migrate | seed | worker | relay | scheduler | all-background | web>
```

The container image (`infra/docker/`) runs the same CLI; the role is picked by the command.

## Deploy

Design and runbook: `docs/spec/architecture/deployment-and-iac.md`. The single VM stack is
`infra/compose/docker-compose.vm.yml` with Caddy or a Cloudflare Tunnel in front. Hosting is not decided
yet, so nothing is deployed.

Notes for the VM:

- Run every compose command with `--env-file /opt/scout/.env`, not just `up`. The file holds the passwords
  the compose file requires.
- Set `COMPOSE_PROFILES=tunnel` (Cloudflare Tunnel) or `public-ip` (Caddy on a public address) in that file
  so a plain `up -d` starts the edge service.
- `POSTGRES_PASSWORD`, `SCOUT_APP_DB_PASSWORD` and `SCOUT_ADMIN_DB_PASSWORD` end up inside database URLs, so
  they must be URL-safe. Use `openssl rand -hex 32` for each.
- Set `SCOUT_ENV=production`. Next's standalone server forces `NODE_ENV=production`, so Scout's own
  production rules (no dev sign-in, secure cookies, required secrets) follow `SCOUT_ENV` first, then
  `NODE_ENV`. A laptop leaves it empty.
- `AZURE_AD_ALLOWED_TENANT_IDS` lists the Microsoft tenant ids whose people may be matched by email the
  first time they sign in. It defaults to `AZURE_AD_TENANT_ID`. A client's people cannot sign in until
  their tenant id is added.
- `.env.example` lists every variable.

## Code map

`src/platform` (outbox, relay, worker, scheduler, audit), `src/modules/*` (tenancy, integrations, ai),
`src/app` (Next.js screens and `/v1`), `src/entry` (the `scout` CLI and seed). Modules talk through their
public interface; lint enforces the boundaries.

The previous version of this tool (v1) is described in `docs/ARCHITECTURE.md` and the older entries of
`docs/CHANGELOG.md`.
