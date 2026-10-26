# Architecture and conventions

Read `CLAUDE.md` and `docs/SPEC.md` first. This file says where things live and the patterns to copy.

## Layout

```
prisma/schema.prisma        every model; every company-owned table has companyId
prisma/seed.ts              Taazaa + 6 offerings + history; Northwind sample company
scripts/dev.mjs             embedded Postgres (port 5440) + schema push + next dev (port 4240)
src/lib/                    pure modules, unit tested: funnel.ts, scoring.ts, verdict.ts, scorecard.ts,
                            leadChecks.ts, format.ts, defaults.ts; plus db.ts (scoped client), auth.ts,
                            permissions.ts, extract.ts (URL and file text)
src/ai/                     one file per Claude task + prompts/<task>.v1.ts; run.ts logs every call to AiRun
src/integrations/<name>/    adapter interface + mock + live; picked by INTEGRATION_<NAME>=mock|live
src/server/                 domain services (all business logic): offerings, segments, tests, funnel,
                            leads, meetings, scorecard, settings; context.ts (auth + company scope);
                            action.ts (server action result + FormData helpers); audit.ts
src/jobs/                   pg-boss queue + worker (lead validation, batch result collection, touch
                            sending every minute, Monday scorecard, conversion sync)
src/components/ui.tsx       server-safe primitives: PageHeader, Card, CardHeader, Badge, Button,
                            LinkButton, Table/Th/Td, EmptyState, Notice, Stat, Tabs, Field, KeyValue, Bar
src/components/client.tsx   client primitives: ActionForm, ActionButton, SubmitButton, Dialog,
                            AutoRefresh, Disclosure, Spinner
src/app/c/[company]/...     company pages (left nav in layout.tsx)
```

## Rules that matter in code

- **Company scope.** Pages and actions get `ctx = await getCompanyContext(slug)` (pages) or
  `ctx = await authorize(slug, "<action>")` (server actions). Use `ctx.db` for every query. It injects
  `companyId` into reads and stamps writes. Creates must still pass `companyId: ctx.company.id`
  (types require it; the client verifies it). Only admin pages, sign-in and cross-company jobs use
  `unscopedDb`.
- **Load parents through ctx.db** before creating children with a foreign key from user input, so a
  foreign id from another company 404s.
- **Business logic lives in `src/server/*`.** Pages and actions call services; they don't re-implement
  math. Funnel math only via `computeFunnel` in `src/lib/funnel.ts`. Scores only via `scoreSegment`.
  Verdicts only via `verdict`. Colours only via `colourFor`/`buildScorecard`.
- **Server actions** live in an `actions.ts` next to the page, start with `"use server"`, take bound
  args first and `(prev, fd)` last, and wrap work in `act(...)` from `src/server/action.ts` so errors
  come back as `{ ok: false, error }`. See `src/app/c/[company]/offerings/actions.ts`.
- **Forms** use `ActionForm` / `ActionButton` from `src/components/client.tsx` with
  `someAction.bind(null, slug, id)`. Money is typed in dollars and converted with `cents()`; rates are
  typed as percents and converted with `rate()`.
- **Permissions** are in `src/lib/permissions.ts`. Hide controls a role can't use (`ctx.can(...)`) and
  enforce in the action with `authorize`.
- **Page files** export only `default`, `metadata`, and Next config. Put shared constants in a sibling
  file (see `offerings/labels.ts`).
- Next.js 15: `params` and `searchParams` are Promises; `await` them.

## Design and copy

- Neutral warm palette, white cards, plum accent. Tailwind tokens: `canvas`, `surface`, `sunken`,
  `line`, `ink` (`soft`, `muted`, `faint`), `accent`, and status `good` / `near` / `bad` (only for
  meaning: on target, within 15%, off target). Grey (`muted` tone) for "not enough data".
- Dense, calm tables. Numbers right-aligned with `numeric` on `Th`/`Td` (adds tabular figures).
- Plain words. No acronyms in the UI ("cost per click", not "CPC"). No em dashes anywhere in UI copy.
- Format with `src/lib/format.ts` (`money`, `pct`, `num`, `compact`, `date`, `dateTime`, `relative`).

## Local dev

`npm run dev` (or the `acq-system` preview). Dev sign-in lists seeded users; `zach.wiant@taazaa.com` is
admin and owner of Taazaa. `npm run db:seed` reseeds. The native Next compiler is blocked by Windows
Application Control on this laptop, so Next falls back to the WASM compiler: first compile of a page
takes 30 to 80 seconds.
