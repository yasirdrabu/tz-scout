# Stack and layout

## Stack (decision D14)

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict), Node 22 LTS or newer | Specs stay language-neutral so a module can be rebuilt in .NET |
| HTTP (web role) | Hono on Node (`@hono/node-server`) | `/api/v1` route handlers, `/api/auth`, health checks and the built web app on one origin; `/mcp` later (web-ui W4 replaced Next.js) |
| Web app | React, Vite, TypeScript in `web-ui/` (its own npm package) | Built to static files the web role serves at `/` (web-ui W1, W2) |
| Worker, scheduler | Plain Node entry points in the same repo | `node dist/worker.js`, `node dist/scheduler.js` |
| Database | PostgreSQL 17, UTF-8 | One database, one schema per module |
| Data access | Drizzle ORM + drizzle-kit migrations | `pgSchema()` per module; SQL migration files committed and reviewed |
| Messaging | NATS JetStream (nats.js client) | Events and work queues; see events-and-async.md |
| Auth | better-auth | Microsoft Entra ID sign-in for people; API keys and OAuth 2.1 (for MCP clients) for agents |
| Validation | Zod | Every boundary: API input, events, AI output, adapter responses |
| API docs | OpenAPI 3.1 generated from Zod schemas | Served at `/api/v1/openapi.json`, rendered at `/developers` |
| MCP | Official MCP TypeScript SDK | Streamable HTTP at `/mcp`; local stdio package `@taazaa/scout-mcp` |
| AI | Anthropic SDK through the AI tasks module | Versioned prompts, Zod-checked output, every call logged |
| UI | CSS modules and the existing token set (warm neutrals, plum accent) | Design rules in [design-and-copy.md](design-and-copy.md) and [web-ui/](../web-ui/index.md) |
| Tests | Vitest (unit, integration against real Postgres and NATS), Playwright (e2e) | Testcontainers or compose services in CI |
| Logs, traces | pino JSON logs, OpenTelemetry traces | Trace id carried through events |

Carried from v1 and still binding: every external service behind an adapter with `mock` and `live`
implementations; the app runs end to end on mocks with seed data; money in integer cents; rates as
decimals; pure math modules with unit tests.

## Repo layout

> Layout decision (R0, updated for web-ui W4): one npm package for the backend, so one dependency
> tree. The HTTP layer lives in `src/http`: `server.ts` (the Hono app and server), `routes.ts` (the
> route table) and the handlers in `src/http/routes`, one folder per path segment (`[id]` is a
> parameter, `[...all]` a wildcard; the table test fails when a handler is not mounted). The other
> process roles are in `src/entry` (`cli.ts`, `worker.ts`, `scheduler.ts`, `relay.ts`), and the web app
> is its own package in `web-ui/`. `packages/mcp-local` arrives in R1. The tree below shows the original
> intent; read `apps/web` as `src/http` (and `web-ui/` for pages), `apps/*` otherwise as `src/entry`.

```
apps/
  web/                     HTTP server: /api/v1 route handlers, /mcp, auth routes
  worker/                  worker entry: registers every module's consumers
  scheduler/               scheduler entry: publishes timed jobs
packages/
  mcp-local/               @taazaa/scout-mcp, stdio MCP server that calls /api/v1 with an API key
src/modules/<module>/
  index.ts                 the module's public interface (the ONLY import other modules may use)
  contracts/               Zod schemas for its commands, queries, events, API shapes
  domain/                  pure logic (scoring math, rules), unit tested
  db/schema.ts             Drizzle tables in pgSchema('<schema>')
  db/migrations/           this module's SQL migrations
  services/                use cases; take a ModuleContext (tenant, actor, db, outbox)
  consumers/               NATS consumers for events and jobs this module handles
  http/                    /api/v1 route definitions for this module (mounted by apps/web)
  mcp/                     MCP tools this module contributes
  adapters/<name>/         mock + live implementations of outside services it owns
  ui/                      React components and pages for this module
src/platform/              outbox, relay, nats, jobs, audit, context, errors, ids, money, logging
infra/
  compose/                 docker-compose.yml (laptop), docker-compose.vm.yml (single VM)
  helm/scout/              Helm chart (web, worker, scheduler, relay; NATS as a dependency)
  tofu/                    OpenTofu modules: vm-hetzner, vm-aws-lightsail, vm-azure, k8s-azure, dns-cloudflare
docs/spec/                 this spec
```

## Processes

One container image, started in one of four roles by its command:

| Role | Command | Scales | Does |
|---|---|---|---|
| web | `scout web` | horizontally, stateless | the web app, `/api/v1`, `/api/auth`, `/mcp`, inbound webhooks, health checks |
| worker | `scout worker` | horizontally, by queue depth | all NATS consumers |
| scheduler | `scout scheduler` | exactly one | publishes timed jobs (pulls, scorecard, follow-through checks) |
| relay | `scout relay` | exactly one active (leader lock in Postgres) | moves outbox rows to NATS |

On a single VM, worker, scheduler and relay may run in one container (`scout all-background`) to save
memory. Web, worker and scheduler never share a process in production.
