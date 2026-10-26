# Stack and layout

## Stack (decision D14)

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict), Node 22 LTS or newer | Specs stay language-neutral so a module can be rebuilt in .NET |
| Web, API, MCP | Next.js (App Router) | UI pages, `/v1/*` route handlers, `/mcp` endpoint in one app |
| Worker, scheduler | Plain Node entry points in the same repo | `node dist/worker.js`, `node dist/scheduler.js` |
| Database | PostgreSQL 17, UTF-8 | One database, one schema per module |
| Data access | Drizzle ORM + drizzle-kit migrations | `pgSchema()` per module; SQL migration files committed and reviewed |
| Messaging | NATS JetStream (nats.js client) | Events and work queues; see events-and-async.md |
| Auth | better-auth | Microsoft Entra ID sign-in for people; API keys and OAuth 2.1 (for MCP clients) for agents |
| Validation | Zod | Every boundary: API input, events, AI output, adapter responses |
| API docs | OpenAPI 3.1 generated from Zod schemas | Served at `/v1/openapi.json`, rendered at `/developers` |
| MCP | Official MCP TypeScript SDK | Streamable HTTP at `/mcp`; local stdio package `@taazaa/scout-mcp` |
| AI | Anthropic SDK through the AI tasks module | Versioned prompts, Zod-checked output, every call logged |
| UI | Tailwind, the existing token set (warm neutrals, plum accent) | Design rules in [design-and-copy.md](design-and-copy.md) |
| Tests | Vitest (unit, integration against real Postgres and NATS), Playwright (e2e) | Testcontainers or compose services in CI |
| Logs, traces | pino JSON logs, OpenTelemetry traces | Trace id carried through events |

Carried from v1 and still binding: every external service behind an adapter with `mock` and `live`
implementations; the app runs end to end on mocks with seed data; money in integer cents; rates as
decimals; pure math modules with unit tests.

## Repo layout

> Layout decision (R0): one npm package. The Next.js app lives in `src/app` and the other process roles
> in `src/entry` (`cli.ts`, `worker.ts`, `scheduler.ts`, `relay.ts`), instead of `apps/web`,
> `apps/worker` and `apps/scheduler`. Next.js does not compile code outside its project folder without
> experimental flags, and one package keeps one dependency tree. `packages/mcp-local` arrives in R1.
> The tree below shows the original intent; read `apps/*` as `src/app` and `src/entry`.

```
apps/
  web/                     Next.js app: pages, /v1 route handlers, /mcp, auth routes
  worker/                  worker entry: registers every module's consumers
  scheduler/               scheduler entry: publishes timed jobs
packages/
  mcp-local/               @taazaa/scout-mcp, stdio MCP server that calls /v1 with an API key
src/modules/<module>/
  index.ts                 the module's public interface (the ONLY import other modules may use)
  contracts/               Zod schemas for its commands, queries, events, API shapes
  domain/                  pure logic (scoring math, rules), unit tested
  db/schema.ts             Drizzle tables in pgSchema('<schema>')
  db/migrations/           this module's SQL migrations
  services/                use cases; take a ModuleContext (tenant, actor, db, outbox)
  consumers/               NATS consumers for events and jobs this module handles
  http/                    /v1 route definitions for this module (mounted by apps/web)
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
| web | `scout web` | horizontally, stateless | UI, `/v1`, `/mcp`, inbound webhooks |
| worker | `scout worker` | horizontally, by queue depth | all NATS consumers |
| scheduler | `scout scheduler` | exactly one | publishes timed jobs (pulls, scorecard, follow-through checks) |
| relay | `scout relay` | exactly one active (leader lock in Postgres) | moves outbox rows to NATS |

On a single VM, worker, scheduler and relay may run in one container (`scout all-background`) to save
memory. Web, worker and scheduler never share a process in production.
