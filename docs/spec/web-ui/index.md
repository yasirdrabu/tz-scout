# WEB Web UI

Status: Draft v1 · Owner: Yasir · Updated 2026-10-31

The Scout web app: a standalone React, Vite and TypeScript single-page app in `web-ui/`, built from
the October 2026 mockups (`docs/design/Taazaa-Scout-UI-Mockups.zip`, product brief
`docs/design/ux-brief.md`). It replaces every screen the Next.js app serves today, sign-in included,
and talks to the backend only over HTTP. Screen by screen detail is in [screens.md](screens.md).

## Why

Scout's backend (R0 to R1c) exposes everything through `/v1` (moving to `/api/v1`, C1), but the only UI is a handful of
server-rendered admin pages. The people who decide (leaders), the people who sell (AEs), the people
who run sources (operators) and the people who pay (owners) have no screens for their work. The
mockups define those screens. A separate app keeps the backend a plain API that agents, MCP and the
web app all use the same way.

**Success:** the team works in Scout every day on the new app. A leader clears the review queue and
assigns accounts, an AE accepts or declines, an operator imports a list and watches it resolve, and an
owner reads results, all without touching the old pages or the database.

**Anti-goals (a failure even if it works):**
- The app knows something the API does not: business rules, permissions or numbers computed in the
  browser that the API could disagree with.
- Screens that look finished but show sample numbers as if they were real.
- A slow or jumpy queue: the review queue and account page are used hundreds of times a day.
- Drift from the mockups' look or the copy rules.

## Goals

1. Every screen in the mockups, built against the real `/api/v1` API, released in the order the backend
   can support it (tags below).
2. One shell for every role; navigation and actions hidden, not disabled, when the person lacks the
   permission.
3. Sign-in in the app (Microsoft only for now; Google later, api-gaps.md Decision 19), with sessions
   shared with the API host.
4. Fast and calm: cached reads, optimistic edits where safe, skeletons not spinners, no layout shift.
5. Accessible by keyboard and screen reader at WCAG 2.2 AA.

## Non-goals (this version)

- The Scout assistant chat (logic only in the mockup, no layout), billing, sign-up, marketing site,
  mobile layouts, dark mode.
- Partner and vendor sign-in (R4, per the release plan).
- Reusing any code from the Next.js pages in `src/app` or `src/components`.

## Decisions taken (2026-10-30, with the user)

| # | Decision |
|---|---|
| W1 | The app lives in `web-ui/` at the repo root as its own package: own `package.json`, Vite, tsconfig, lint and tests. |
| W2 | It is built as static files and served from the same origin as the API: the app at `https://scout.taazaa.ai/`, the API at `https://scout.taazaa.ai/api/v1`, sign-in at `/api/auth`. A reverse proxy (or the API server itself) serves the static files and sends `/api/*` to the API. No CORS, no cross-site cookies. |
| W7 | The workspace is in the path: `scout.taazaa.ai/t/<tenant-slug>/...`. No subdomain per tenant. |
| W8 | One platform-admin level (today's `platformAdmin` flag), signing in with Microsoft like everyone else. No separate super admin, no passwords. |
| W3 | It owns every screen, sign-in included. The Next.js pages and `src/components` are retired. |
| W4 | Next.js is removed from the backend too: the HTTP layer moves to a plain Node server (separate plan, see "Backend changes"). |
| W5 | The spec covers every mockup screen, each tagged by release. |
| W6 | Operators see the Review queue (the mockup's role matrix wins over its sidebar): `review:act` is added to the operator role's default permissions (`tenancy` `ROLE_PERMISSIONS`, then the roles matrix once it is editable). |

## Calls made in this spec (check these)

| # | Call | Why |
|---|---|---|
| C1 | The API moves from `/v1` to `/api/v1` with no alias for the old path: nothing outside Scout calls it yet (the live cutover has not happened). API keys, the MCP server, the HubSpot webhook URL and the developer docs move with it. Local dev runs Vite with a proxy for `/api`, so it is same-origin there too. Deep links under `/t/...` and `/admin/...` fall back to `index.html`. | Follows W2. Moving before go-live costs nothing; after go-live it would need an alias. |
| C2 | Stack: React 19, Vite, TypeScript strict, TanStack Router, TanStack Query, React Hook Form with zod, Radix primitives, CSS Modules over design tokens, Vitest with Testing Library and MSW, Playwright. | Typed routes and search params, a cache that fits a read-heavy app, accessible primitives without a visual library to fight. |
| C3 | API types are generated from the backend's OpenAPI document into `web-ui/src/api/schema.ts`; no hand-written response types. | One source of truth for the contract. OpenAPI is an R1d item; until it lands the gap pass decides per module. |
| C4 | Navigation and actions are driven by the permissions in `GET /api/v1/me`, never by role names. | Roles are tenant-configurable in the mockup; permissions are the stable contract. |
| C5 | Send-back and decline reasons always come from the tenant's settings, and a reason is required on every send-back path, bulk included. A note is required only for reasons marked "Note required". | The mockups disagree (account page chips vs Settings list; bulk and peek take none). Today the backend checks a note for send back and a reason only for declines; the routing change of api-gaps.md Decision 1 makes it check the reason, and the note only where the reason needs one. |
| C6 | Stage names and order come from the API everywhere (tracker, All accounts tabs, funnel). They become editable in Settings > Pipeline stages when the pipeline stages plan lands (api-gaps.md Decision 6); until then that tab is hidden. | The mockups use three different stage lists. |
| C7 | Sample names that disagree between the two mockup files (playbook names, send-back reasons) are sample data only; the real lists come from the API. | |
| C8 | No number on a screen is computed in the browser beyond formatting. Where the mockup computes (rescoring preview, funnel totals, return on spend), the API returns it. | Anti-goal 1. |
| C9 | Where the backend has no data yet for a section (for example cost per win before R3), the section shows its empty state with the reason, never sample data. | Anti-goal 2. |
| C10 | URL shape: `/t/:tenant/...` for workspace screens, `/admin/...` for platform admin, `/signin`. Filters, tabs, sort and the peek drawer's account live in the URL's search params. | Shareable links, back button works, reload keeps your place. |
| C11 | Claude builds `web-ui/` as well as the backend changes (the user's direction of 2026-10-30). | Replaces the earlier "backend only" rule. |
| C12 | Switch-over: the web-ui foundation starts now against today's Next-hosted `/v1` through the Vite dev proxy. The old Next pages keep running until the new app covers their screens (sign-in, Tenants, System health, Members, Integrations, Profile); they are deleted in the plan that lands the last of those. **Status (2026-10-31):** done; the admin parity plan (`docs/plans/2026-10-31-web-ui-admin-parity.md`) retired the old pages, their server actions and `src/components`, and Next now serves only `/v1`, `/api`, `/healthz` and `/readyz`. The HTTP layer move to Hono runs as its own plan in parallel and must land before the first production deploy of the app on its own host. | No screen goes missing in between, and front-end work is not blocked on the server move. |
| C13 | "In review by {name}" is a review status a reviewer sets, shown with who set it. It is not a lock: anyone with `review:act` can still act, and the last write wins with the change log showing both. | Simplest thing that matches the mockup; a claim or lock can come later if two reviewers keep colliding. |
| C14 | Freshness by polling, no push channel: refetch on window focus everywhere; the queue and My accounts every 30 s; import Resolve every 2 s while running (tenant creation is instant in R1; provisioning polling comes with the per-tenant infrastructure project); System health every 15 s. A refetch never moves rows under the pointer: new or changed rows show a "{n} updates" bar to apply them, and an account someone else decided while you had it open shows "Assigned by Dana a moment ago" in place of the actions. | Meets the "no jumpy queue" anti-goal without new backend infrastructure. |

## Decisions from the API gap pass

The API gap pass ([api-gaps.md](api-gaps.md)) checked every screen against the backend. The user's
answers (2026-10-31) are in its "Decisions taken" section and are binding; its "Spec corrections"
are applied in this file and in screens.md. Questions the decisions leave open are at the end of
api-gaps.md under "Open questions".

## Release tags

Each screen in [screens.md](screens.md) carries one tag. The API gap pass ([api-gaps.md](api-gaps.md))
records the gaps per module.

| Tag | Meaning |
|---|---|
| **R1** | Backend module exists (R0 to R1c). Expect small API gaps only. |
| **R1d** | Needs an R1d backend item (OpenAPI, Apollo and Vibe pulls, caps, MCP). |
| **R2** | Needs R2 backend (full account page: conflicts, enrichment requests, playbooks, committee gaps, warm-intro rules). |
| **R3** | Needs R3 backend (analytics, cost ledger, trust from outcomes). |
| **Redesign** | Needs one of the backend redesign plans the gap decisions create (pipeline stages, scoring model, roles and permissions; see "Backend changes"). The screen or section is hidden until its plan lands. |
| **Platform** | Per-tenant infrastructure (own database, storage and key, backups, migrations, support access), its own platform project (api-gaps.md Decision 23). |

A screen tagged later than R1 can ship earlier with the sections the API supports and its empty
states for the rest (C9), when the gap pass says that is useful.

## Look

The mockups use the Dayko design system with Scout's overrides. The app copies the overrides as its
tokens; it does not depend on the Dayko bundle.

- Accent plum `#7B2D6B` (scale 50 `#F6EDF3`, 100 `#EDD8E7`, 200 `#DDB4D2`, 300 `#C78CBA`,
  400 `#A35A93`, 500 `#7B2D6B`, 600 `#6B2560`, 700 `#5B1F52`, 800 `#47183F`). Focus ring
  `0 0 0 3px rgba(123,45,107,.22)`.
- Warm ink: 900 `#1F1C19`, 800 `#332F2B`, 700 `#423D38`, 600 `#5A534C`, 500 `#7A736B`,
  400 `#A39C93`, 300 `#CFCAC2`, 200 `#E6E3DD` (borders), 150 `#EEECE7`, 100 `#F2F0EC`.
  Page `#F6F5F2`, sunken `#FAF9F7`, sidebar `#FBFAF8`, cards `#FFFFFF`.
- Status, for meaning only: green `#18794E` on `#E5F1EA`, amber `#A15C07` on `#FAEFDF`, red
  `#B42318` on `#FBE9E7`, gray for "not enough data".
- Geist for text, Geist Mono for ids and error refs, tabular figures everywhere, numbers
  right-aligned. Self-hosted font files (the `geist` package), no font CDN.
- Radii: inputs and buttons 8 to 10 px, cards 14 px, pills 999 px. Hairline borders, soft shadows
  (cards `0 1px 3px rgba(0,0,0,.06)`, popovers `0 12px 32px rgba(0,0,0,.14)`).
- Icons: Lucide (stroke style the mockups draw by hand). The sparkle marks Scout's recommendation and
  anything Claude wrote.
- Light only. Desktop first: 1440 wide, and the queue and account page work at 1280. Minimum
  supported width 1180, below which the page scrolls sideways (as in the mockup).
- Motion: 150 to 200 ms fades and slides; none when `prefers-reduced-motion` is set.

## Copy

The rules in `architecture/design-and-copy.md` apply, plus:
- Toasts say what happened, in the mockups' words, and never claim more than the API has done
  ("Assigned to Ash Patel. Sending Miami-Dade County DTPW to HubSpot.": the send runs after the
  assign returns).
- Every empty, loading and error state has its own copy (the mockups give it for the queue and the
  account page; screens.md gives it for the rest).
- Errors show a reference (`Error ref q-7f31c2`) taken from the API's correlation id, so support can
  find the request.
- Acronyms the mockups still use are replaced: "Not our ICP" becomes "Not our kind of customer";
  RFP stays (it is the buyer's own word, used on procurement notices).

## Shell

- Left sidebar 240 px: workspace switcher at the top, grouped navigation, profile and Settings at the
  bottom. Header 60 px: global search, CRM sync indicator.
- Groups and items, each shown only with its permission (C4):

| Group | Item | Shown with |
|---|---|---|
| Work | Overview | `analytics:read` |
| Work | Review queue (badge: accounts waiting) | `review:act` |
| Work | My accounts (badge: new assignments) | `assignments:respond` |
| Work | All accounts | `accounts:read` |
| Sources | Sources | `sources:manage` and `arrivals:read` |
| Sources | Batches and imports | `arrivals:read` or `imports:run` |
| Plan | Offers and practices | `offers:read` |
| Plan | Playbooks | `playbooks:read` |
| Results | Funnel by source, Costs | `analytics:read` (Costs budgets: `costs:write`) |
| Admin | Tenants, System health, AI runs | platform admin (`platform_admin` in `/me`) |
| Footer | Settings | any of `members:read`, `integrations:manage`, `keys:manage`, `settings:manage`, `scoring:manage`, `audit:read` |

  Every name is the backend's (`src/modules/tenancy/domain/permissions.ts`); none is proposed.
  `/me` returns them as `scopes`. `analytics:read` is held by every role, so sellers see Overview
  within their data limit. There is no `costs:read` or `review:configure`: Costs reads with
  `analytics:read`, and Review statuses and Pipeline stages edit with `settings:manage`.
- Landing: the first visible of Review queue, My accounts, All accounts, in the last used workspace
  (the switcher records it with `PUT /api/v1/me/workspace`; nothing writes it today).
- Workspace switcher: the person's tenants with member counts; switching changes the `/t/:tenant`
  segment, records the choice and clears the query cache. Footnote "Each workspace keeps its own accounts, sources and
  HubSpot connection."
- Global search: accounts, people and batches, results grouped, keyboard navigable (`/` focuses it).
- Toasts bottom-center, dark, 3.5 s, one at a time, with an Undo where the API supports undo.

## Architecture of the app

```
web-ui/
  index.html, vite.config.ts, tsconfig.json, package.json
  public/            fonts, favicon
  src/
    main.tsx         router, query client, providers
    app/             shell: sidebar, header, workspace switcher, toasts, error boundary
    routes/          TanStack Router file routes (/signin, /t/$tenant/..., /admin/...)
    features/        one folder per backend module: review, accounts, sources, intake,
                     offers, playbooks, analytics, settings, tenancy, admin
      <feature>/     api.ts (queries and mutations), components/, screens/, *.test.tsx
    ui/              design-system primitives: Button, Chip, Pill, Card, Table, FilterPopover,
                     Drawer, Dialog, Tabs, ScoreBar, StageTracker, EmptyState, Skeleton, Toast
    api/             fetch client, generated schema.ts, error mapping, auth
    lib/             format (money, dates, percents in the tenant's currency and timezone)
    styles/          tokens.css, reset.css
  tests/e2e/         Playwright flows against a mock API and, gated, a real backend
```

- **Features mirror backend modules**, so an API gap maps to one folder and one module.
- **Data:** TanStack Query keys per resource; mutations invalidate the queries they change; the
  review queue and account page use optimistic updates for status edits and notes.
- **API client:** one `fetch` wrapper: `credentials: 'include'`, `x-scout-tenant` from the route (same origin, so cookies are first-party),
  `x-correlation-id` per request, `Idempotency-Key` on every POST, problem+json errors mapped to a
  typed `ApiError` with the copy to show.
- **Auth:** sign-in redirects to the API's auth endpoints and back; the session cookie is on the API
  host; `GET /api/v1/me` on load decides the shell. A 401 sends the person to `/signin` with a return path.
- **Formatting:** one `lib/format` module, as the design rules require. Screens never format numbers
  by hand.
- **Quality bar:** TypeScript strict, ESLint with jsx-a11y, Prettier; unit and component tests with
  Vitest, Testing Library and MSW; Playwright for the five main flows in the brief; bundle split by
  route; Lighthouse accessibility 100 on the queue and account page.

## Backend changes this needs

Recorded here so the backend plans pick them up; the gap pass lists them per module.

1. **HTTP layer off Next.js** (W4): a plain Node server (Hono, my call) hosting `/api/v1`, auth and the
   inbound webhooks. Route handlers already take a `Request` and return a `Response`, so most carry
   over as they are. Its own plan, before the web-ui plans that need new endpoints.
2. **Paths and static files** (W2, C1): `/v1` becomes `/api/v1`, auth stays at `/api/auth`, dev
   sign-in stays at `/api/dev/sign-in` (outside both, so the proxy and the Hono server must carry it),
   the health checks stay at `/healthz` and `/readyz`; the server (or the proxy in front of it) serves the
   built app with an `index.html` fallback. Cookies stay first-party; cookie-authenticated writes keep
   the same-origin (CSRF) check.
3. **Sign-in from the app:** Microsoft sign-in returns to the app's return path and sign-in errors
   return to `/signin` with a code. Microsoft only for now; Google sign-in and allowed domains per
   workspace come later (api-gaps.md Decision 19).
4. **Every server action in the old pages becomes an `/api/v1` endpoint** (tenants, system health,
   members, integrations), since the app can only call HTTP. `GET /api/v1/me` must also answer for a
   platform admin with no tenant, so the `/admin` shell can load.
5. **OpenAPI document** (R1d item) served by the API for type generation.

New backend plans from the gap decisions (api-gaps.md "Decisions taken"), each its own plan:

6. **Configurable pipeline stages** (Decision 6): stages in a table instead of a fixed enum; add,
   rename, reorder, delete, a HubSpot stage and a target per stage. A routing, CRM and analytics
   redesign. Until it lands the API serves the fixed stages read only (`GET /api/v1/stages`) and the
   editor is hidden.
7. **Scoring model to four weights** (Decision 21): Fit, Buying intent, Revenue potential and Source
   trust weighted to 100, one cutoff per tier (Act now, Good fit, Watch) and Nurture below, with a
   full rescore. Source trust stays the R1 constant until R3.
8. **Editable roles and permission matrix with Viewer** (Decision 17): `tenancy.role_permission`,
   `GET /api/v1/roles`, `PUT /api/v1/roles/{role}`, `permissionsFor` reads the table, the principal
   cache is dropped on save; owner column locked.
9. **Per-tenant infrastructure** (Decision 23): own database, file storage and encryption key per
   tenant, region, backups and point-in-time restore, per-tenant migrations, provisioning and
   deletion states, seats, quotas, export, owner-granted support access. A platform project that
   replaces the one-database-with-row-level-security model; it starts with an architecture change in
   `docs/spec/architecture/`.
10. **Sign-in and API key call logs** (Decision 20): `tenancy.sign_in_event` from the auth hooks
    (successes and failures, 12-month retention) and `tenancy.api_key_call` for key calls, trimmed to
    the last 1,000 per key.

The other decisions (send-back reasons, review status editor, notes, manual tier, best offer, best
match, source owner, list sources, remove source, API keys, offer lifecycle and fields, invites and
suspended members, AI runs, playbooks per tier, cost budgets) are changes inside the module plans
that need them; api-gaps.md lists them per module.

## Order of work

1. This spec, reviewed. Done.
2. API gap pass, module by module ([api-gaps.md](api-gaps.md)). Done; decisions taken 2026-10-31.
3. Backend HTTP layer move and `/api/v1` (backend changes 1, 2 and 4, with the cross-cutting items of
   api-gaps.md: no-tenant session route, CSRF rule, `/me` shape, sign-in return paths). In parallel,
   the web-ui foundation (shell, sign-in, design system, API client) against today's `/v1` through
   the Vite proxy (C12). The move blocks the first production deploy and every plan that adds
   endpoints.
4. Review queue, peek drawer, Send back, Assign and My accounts, with their routing, accounts and
   scoring changes (send-back reasons, notes, manual tier, best offer, best match).
5. Playbooks (minimum): the `HandoffPackageProvider` that writes Scout's recommendation and the
   brief. It blocks the account page (Decision 7).
6. Account page (review view, then assigned view).
7. Sources, Batches and Import (list sources, source owner, remove source, source keys); then Offers;
   then Settings (Members with suspended status, Review statuses editor, API keys, Integrations,
   Audit log) with the sign-in and API key call logs plan (change 10), which blocks Login history and
   the key access log; then Admin (Tenants list, create, suspend and resume; AI runs; System health).
   The last of these deletes the old Next pages (C12).
8. The four redesigns, after the R1 screens so none of them holds R1 up:
   - **Roles and permissions** (change 8) first: the smallest, and it blocks only the editable
     matrix and the Viewer role; until then the matrix is read only.
   - **Scoring model** (change 7): blocks Scoring weights and the five-score strip, and must land
     before the R2 playbooks plan, since playbooks are picked per tier and the tier set changes
     (Nurture).
   - **Pipeline stages** (change 6): blocks the stages editor, and must land before the R3 analytics
     plans (Overview, Funnel, scorecard targets) and the HubSpot stage mapping, which all build on
     stage keys.
   - **Per-tenant infrastructure** (change 9): its architecture change can be written at any time;
     the build is its own track and blocks only the hidden Tenants sections and support access. It
     touches every module's database access and migrations, so it should not run at the same time
     as the pipeline stages redesign.
9. R2 screens (conflicts, enrichment, playbooks), then R3 (analytics, costs, trust).
