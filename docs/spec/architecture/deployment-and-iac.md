# Deployment and infrastructure as code (decision D12)

Goal: the same image and the same definitions run on a laptop, on one cheap VM, or on Kubernetes,
with no hand-made servers.

## Image

- One OCI image `ghcr.io/taazaa/scout:<git-sha>` (or the tenant's registry), built on Linux in CI.
- Entry command selects the role: `web`, `worker`, `scheduler`, `relay`, `migrate`,
  `all-background`.
- Config only from environment variables; `.env.example` lists every one.

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
