# Deployment and infrastructure as code (decision D12)

Goal: the same image and the same definitions run on a laptop, on one cheap VM, or on Kubernetes,
with no hand-made servers.

## Image

- One OCI image `ghcr.io/taazaa/scout:<git-sha>` (or the tenant's registry), built on Linux in CI.
- Entry command selects the role: `web`, `worker`, `scheduler`, `relay`, `migrate`,
  `all-background`.
- Config only from environment variables; `.env.example` lists every one.
- The `web` role is one Node HTTP server (Hono, spec web-ui W4) on `PORT` (4240), bound to
  `SCOUT_BIND_HOST` (default `0.0.0.0`). It serves everything on one origin (W2): the built web-ui app
  at `/` from `WEB_UI_DIST` (the image sets `/app/web-ui/dist`), with `index.html` (`no-cache`) for
  every other GET or HEAD outside the API and hashed `/assets/*` cached for a year; the API at
  `/api/v1`; sign-in at `/api/auth`; health at `/healthz` and `/readyz`. Unknown `/api/*` paths get the
  API's problem+json 404.
- On SIGTERM or SIGINT the web role stops accepting connections, lets in-flight requests finish (up
  to 10 seconds), closes its database pools and NATS connection and exits 0.
- The CI smoke test runs the image's `web` role and checks `/`, a deep link, a hashed asset,
  `/healthz`, `/readyz` and `GET /api/v1/me` (401 problem+json).

## Laptop

`infra/compose/docker-compose.yml`: Postgres 17, NATS 2.x with JetStream, `migrate` (runs once),
`web`, `worker`, `scheduler`, `relay`, Mailpit for email. `docker compose up` gives a running Scout on
`http://localhost:4240` with seed data and every integration on mock.

## Single VM (where R1 runs)

- `infra/compose/docker-compose.vm.yml`: the same services plus Caddy for HTTPS on
  `scout.taazaa.ai`, with Postgres either on the VM (nightly `pg_dump` to object storage, 14 days
  kept) or a managed database via `DATABASE_URL`.
- Provisioned by OpenTofu: `infra/tofu/vm-<provider>` creates the VM, firewall (443 and SSH from
  allowed IPs only), object storage bucket for backups, and a cloud-init that installs Docker and
  starts the compose stack. Providers written first: Hetzner and Azure; AWS Lightsail after.
- DNS by `infra/tofu/dns-cloudflare` (Cloudflare holds `taazaa.ai`).
- Expected cost: $10 to $40 a month plus managed Postgres if chosen.

## Postgres connections (D35)

Each process holds, at most:

| Pool | `shared` | `per_workspace` |
| --- | --- | --- |
| Control plane, app role (`DATABASE_POOL_MAX`) | 20 | 20 |
| Control plane, admin role (postgres.js default) | 10 | 10 |
| Workspace pools | 30 (one app pool of `DATABASE_POOL_MAX`, one admin of 10) | `SCOUT_WORKSPACE_POOL_CAP`, 60 (a workspace takes `SCOUT_WORKSPACE_POOL_MAX` + 1 = 4, so 15 open at once) |
| Relay lock and `LISTEN` (relay role only) | 1 | 1 |
| Relay's workspace connections (relay role only, `SCOUT_RELAY_POOL_CAP`) | 0 | 60 (per workspace database, one to read its outbox and one to `LISTEN`, for up to 30) |
| **Total, web or worker** | **60** | **90** |
| **Total, relay** | **61** | **151** |

A workspace pool is closed only when nothing runs on it (every transaction and query on it is
counted) and it was not handed out in the last second; when every pool is busy the cap is passed for
a while, logged, rather than break a transaction. Pools close after 10 minutes idle. `migrate` adds
one connection at a time per database it works on (4 at once).

The relay listens on every active workspace database and reads its outbox, so it has its own budget,
two connections per workspace database, apart from the request and worker pools: set
`SCOUT_RELAY_POOL_CAP` to the number of active workspaces or more. Past the cap it polls those
databases (about once a second) and opens and closes their connections as it goes round.

Postgres' default `max_connections` is 100, so the four background and web roles of the compose stack
need either a larger `max_connections` or smaller limits for the roles that do little workspace work.
A workable single-VM setting for `per_workspace` with up to 30 workspaces: web and worker as above
(180); the scheduler with `DATABASE_POOL_MAX=5`, `SCOUT_WORKSPACE_POOL_CAP=20` (35); the relay with
`DATABASE_POOL_MAX=5`, `SCOUT_WORKSPACE_POOL_CAP=4` and `SCOUT_RELAY_POOL_CAP=30` (80). That is 295
in all, so `max_connections = 350` leaves room for `migrate`, backups and an operator session.
Managed Postgres limits connections by tier: size the tier, or the caps, to the sum. A pooler in
transaction mode (PgBouncer) suits web and worker, not the relay, which needs a session for its
advisory lock and `LISTEN`.

## A database per workspace (D35)

`SCOUT_WORKSPACE_DATABASES=per_workspace` is the default: the database `DATABASE_URL` names is the
control plane (users, sign-in, the workspace list), and each workspace has its own database,
`scout_t_<tenant id>`, made when the workspace is created (from the template database
`SCOUT_WORKSPACE_TEMPLATE_DATABASE`, default `scout_t_template`). `scout migrate` migrates the control
plane, then every workspace database 4 at a time (`--tenant <slug>` for one), then refreshes the
template; a workspace that fails is marked `failed` and the command exits 1.

Moving an existing install (every workspace in one database):

1. Deploy the release and run `scout migrate`. The install keeps working as it was: every workspace's
   registry row points at the one database, which is now also the control plane.
2. Run `scout tenant split --all` (or `scout tenant split <slug>` one at a time). Each workspace
   answers 503 with Retry-After while it moves, for about a minute and the time its rows take to copy;
   its messages and schedules wait. A split that stops part way finishes when run again.
3. Check the Tenants screen (every workspace in `scout_t_…`).

Backups: the nightly job (`infra/backup`) dumps only `scout` today. Per-workspace backups come with
D35 plan 3; until they do, do not split an install whose data needs the nightly backup, or add each
`scout_t_…` database to the backup by hand.

`SCOUT_WORKSPACE_DATABASES=shared` keeps everything in one database. It exists for the move: an
install that has not split yet, and the CLI tests that start from one.

## Hosting options (decision open, owner: Yasir)

Where staging and production run is not decided yet. Every option uses the same image and compose
file; only the OpenTofu module and the way traffic reaches the box differ.

| Option | Monthly cost | Getting traffic in | Backups | Notes |
|---|---|---|---|---|
| **A. VMware VM in Taazaa's data center** | Near zero (existing capacity) | Cloudflare Tunnel (`cloudflared` container) to `scout.taazaa.ai`: no inbound ports, no public IP needed | `pg_dump` nightly to Cloudflare R2 or an existing backup system | OpenTofu `vsphere` provider + cloud-init template. Uptime depends on the data center. Fastest start if a VM is available. |
| B. Hetzner Cloud VM | $10 to $30 | Public IP + Caddy, or Cloudflare Tunnel | Hetzner snapshots + `pg_dump` to object storage | Cheapest cloud; EU or US regions |
| C. Azure VM (B2s) + optional Azure Postgres Flexible | $40 to $120 | Public IP + Caddy, or Tunnel | Azure Backup / managed Postgres backups | Fits the Microsoft tenant, Entra and Key Vault |
| D. AWS Lightsail | $12 to $40 | Public IP + Caddy, or Tunnel | Lightsail snapshots | Simple, predictable pricing |
| E. Kubernetes (AKS, EKS or Dayko's cluster) | $150+ | Ingress | Managed Postgres | Only when load or the move into Dayko needs it |

Recommendation: start with **A** for staging and production if the data center VM is available
(Cloudflare Tunnel removes the need for a public IP and firewall changes), keep **B** or **C** as the
fallback. R0's first OpenTofu module follows the choice; `infra/tofu/vm-vsphere` is added to the list
of provider modules.

Needed from Taazaa whichever option is chosen: the VM or cloud account, Cloudflare access for
`taazaa.ai` DNS (and a Tunnel token for option A), a container registry (GitHub organisation for
GHCR), and the Microsoft Entra app registration.

## Kubernetes (later, or inside Dayko)

- Helm chart `infra/helm/scout`: Deployments for web (HPA on CPU), worker (HPA on JetStream pending
  messages via KEDA), scheduler and relay (1 replica each); a Job for `migrate` on each release;
  Ingress; NATS from the official chart or an existing cluster; Postgres external.
- `infra/tofu/k8s-azure` creates AKS, managed Postgres and Key Vault for the first managed cluster.

## Secrets

- App secrets (database URL, auth secret, encryption key for stored credentials) come from the
  environment: `.env` on a laptop, an `.env` file owned by root on a VM (written by cloud-init from
  the provider's secret store), Kubernetes Secrets (via External Secrets) in a cluster.
- Tenant integration credentials live encrypted in the database (D18), encrypted with a data key
  wrapped by `SCOUT_MASTER_KEY`. Rotating the master key re-wraps data keys without re-entering
  credentials.

## Delivery pipeline

On every push: typecheck, lint (including boundary rules), unit tests, integration tests against
Postgres and NATS services, build image. On main: push image, deploy to staging VM. Production deploy
is a manual approval that runs `migrate` then rolls `web`, `worker`, `scheduler`, `relay`.

## Observability

- JSON logs with tenant id, correlation id and trace id on every line.
- OpenTelemetry traces through HTTP, outbox, NATS and adapter calls (trace context in NATS headers).
- Health endpoints: `/healthz` (process up), `/readyz` (database and NATS reachable).
- Admin → System shows relay lag, consumer lag per stream, dead jobs, and integration errors.
