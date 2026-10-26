# Client Acquisition System

Taazaa's AI client acquisition system. Phase 1: internal tool for Taazaa's own pipeline. Later: multi-client product.

Read `docs/SPEC.md` before any work. Build in the order in `docs/BUILD_PLAN.md`, one milestone at a time.

## Stack

- If the Smart Space / AgentWorks shell repo is available, build inside it and reuse its auth, multi-company and admin. Ask before adding a second stack.
- Otherwise default: Next.js (App Router) + TypeScript (strict), Postgres + Prisma, Tailwind, NextAuth (Microsoft 365 sign-in), Anthropic SDK, Zod for validation, Vitest + Playwright for tests.
- Background jobs (lead validation, weekly scorecard, ad sync): a simple job queue (pg-boss on Postgres). No extra infra in Phase 1.

## Rules

- Every table has `companyId`. Every query is scoped by it. No cross-company reads.
- HubSpot is the record for contacts, companies and deals. We store our own objects and keep HubSpot ids that link back. Never duplicate deal state as the source of truth.
- Every external service sits behind an adapter interface in `src/integrations/<name>/` with a `mock` implementation and a `live` implementation. The app must run end to end on mocks, with seed data, before any API access exists. Pick the implementation with env vars.
- All Claude calls go through `src/ai/` with one file per task (segments, statements, lead research, weekly diagnosis). Prompts live in versioned files, outputs are validated with Zod, and every call is logged (input hash, model, tokens, result) to an `AiRun` table.
- Money in integer cents, currency on the company. Rates stored as decimals (0.05, not 5).
- Funnel math lives in one pure module (`src/lib/funnel.ts`) with unit tests. UI never re-implements it.
- No secrets in code. `.env.example` lists every variable.

## Design

- Clean, modern, light SaaS. Neutral palette (warm grays, white cards), one accent color. No navy or blue as the primary. No dark mode.
- Status colors only for meaning: green on target, amber near, red off target.
- Dense but calm tables. Numbers right-aligned, tabular figures.
- Our own design, layout and wording throughout. Do not copy any competitor's screens, labels, scoring names or copy.

## Copy

- Plain words, no jargon acronyms in the UI. Write "cost per qualified lead", not "CPSQL".
- No em dashes in UI copy.

## Definition of done (per milestone)

- Runs locally on mocks with seed data.
- Typecheck, lint and tests pass.
- Acceptance criteria in `docs/SPEC.md` for that module are met.
- Short note added to `docs/CHANGELOG.md`.
