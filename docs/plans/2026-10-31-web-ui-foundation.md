# Web UI foundation Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `web-ui/`, the standalone React + Vite + TypeScript app, with the design tokens, the
UI primitives the shell needs, the API client, sign-in, and the permission-driven shell, running
against today's backend through the Vite dev proxy. No feature screens yet: each sidebar item opens a
placeholder that names the screen and its spec section.

**Architecture:** Own npm package at the repo root (W1). TanStack Router (code-based route tree,
typed params and search), TanStack Query, CSS Modules over `tokens.css`, Radix primitives for
dialog, popover and dropdown. One `fetch` client adds `credentials: 'include'`, `x-scout-tenant`,
`x-correlation-id` and `Idempotency-Key` and maps problem+json to `ApiError`. The shell reads
`GET /v1/me` and shows navigation by permission (C4).

**Tech Stack:** React 19, Vite 6, TypeScript 5 strict, @tanstack/react-router 1, @tanstack/react-query
5, @radix-ui primitives, lucide-react, geist (self-hosted fonts), Vitest 3, @testing-library/react,
MSW 2, ESLint 9 with typescript-eslint, react-hooks and jsx-a11y.

**Spec:** `docs/spec/web-ui/index.md` (Look, Copy, Shell, Architecture of the app, C1 to C14,
W1 to W8), `docs/spec/web-ui/screens.md` §1 Sign-in, `docs/spec/web-ui/api-gaps.md` (tenancy
section: `/me` shape, dev sign-in, no-tenant admin route).

## Global Constraints

- Lives in `web-ui/` with its own `package.json`, `tsconfig.json`, `vite.config.ts`, ESLint config and
  tests. Nothing under `web-ui/` imports from `src/`, and nothing under `src/` imports from `web-ui/`.
- Root configs must ignore `web-ui/`: add it to `exclude` in the root `tsconfig.json` and to `ignores`
  in the root `eslint.config.mjs`. No other root file changes.
- TypeScript `strict`, `noUncheckedIndexedAccess`. No `any`.
- Look exactly per index.md "Look": plum scale, warm ink scale, page `#F6F5F2`, sidebar `#FBFAF8`,
  borders `#E6E3DD`, status colours, Geist and Geist Mono from the `geist` package (no font CDN),
  tabular figures, sidebar 240 px, header 60 px, min width 1180 px, light only, reduced motion
  respected.
- Copy rules: plain words, no em dashes, buttons say what happens.
- Dev: `npm run dev` serves on port 5173 with a proxy of `/v1`, `/api` and `/healthz` to
  `http://localhost:4240` (the current Next backend). The API base path is one constant
  (`API_BASE = '/v1'`) so the move to `/api/v1` (C1) is a one-line change.
- The backend's CSRF check compares Origin with `APP_PUBLIC_URL`; document in `web-ui/README.md`
  that local dev needs the proxy to rewrite `Origin` to the backend origin (configure
  `changeOrigin: true` and set the `origin` header in the proxy), and do it in `vite.config.ts`.
- Do not modify the backend. Gaps found go in the report, not in code.

## Review Focus

1. A 401 from `/v1/me` sends the person to `/signin?return=<path>` and back after sign-in.
2. A person with no permission for a nav item never sees it (hidden, not disabled).
3. Switching workspace changes the `/t/:tenant` segment and clears the query cache.
4. Problem+json errors show the API's `detail` and an error ref from the correlation id.
5. Keyboard: every nav item, menu and dialog is reachable and has a visible focus ring.

---

### Task 1: Package and tooling

**Files:** `web-ui/package.json`, `web-ui/tsconfig.json`, `web-ui/tsconfig.node.json`,
`web-ui/vite.config.ts`, `web-ui/index.html`, `web-ui/eslint.config.js`, `web-ui/.gitignore`,
`web-ui/README.md`, `web-ui/src/main.tsx`, `web-ui/src/vite-env.d.ts`; modify root `tsconfig.json`
(exclude) and root `eslint.config.mjs` (ignores).

- [ ] Scripts: `dev`, `build` (`tsc -b && vite build`), `preview`, `typecheck`, `lint`, `test`
  (`vitest run`), `test:watch`.
- [ ] Pin every dependency to an exact version already published at least two weeks ago.
- [ ] Vitest config inside `vite.config.ts`: jsdom, setup file `src/test/setup.ts` (jest-dom, MSW
  server lifecycle).
- [ ] Verify: `npm install`, `npm run typecheck`, `npm run lint`, `npm test` (a smoke test), and
  `npm run build` all pass in `web-ui/`; root `npm run typecheck` and `npm run lint` still pass.
- [ ] Commit `feat(web-ui): package, tooling and root ignores`.

### Task 2: Tokens and primitives

**Files:** `web-ui/src/styles/tokens.css`, `reset.css`, `global.css`; `web-ui/src/ui/` Button,
IconButton, Chip, Pill (status dot + label), Card, Badge (count), Avatar (initials), EmptyState,
Skeleton, Spinner-free Loading line, ErrorState (title, text, `Try again`, error ref), Toast
(provider + `useToast`, bottom-center, dark, 3.5 s, one at a time), Dialog, Popover, Menu (Radix);
each with a `.module.css` and a test.

- [ ] Tokens as CSS variables named by role (`--accent`, `--accent-50`..`--accent-800`, `--ink-900`..,
  `--canvas`, `--surface`, `--sunken`, `--sidebar`, `--line`, `--good`, `--near`, `--bad` with soft
  variants, `--radius-*`, `--shadow-card`, `--shadow-pop`, `--ring`).
- [ ] Button variants primary (plum), secondary, ghost, dark; sizes md and sm; disabled; focus ring.
- [ ] Tests: each primitive renders, has an accessible name, and Toast shows one message at a time.
- [ ] Commit `feat(web-ui): design tokens and primitives`.

### Task 3: API client, formatting and auth

**Files:** `web-ui/src/api/client.ts`, `errors.ts`, `me.ts` (query + types for today's `/v1/me`
response), `auth.ts` (sign-in start, sign-out, dev users), `web-ui/src/lib/format.ts` (money from
integer cents, percents from decimals, dates in a given timezone, relative "2 days ago"), tests with
MSW.

- [ ] `apiFetch(path, { tenant, method, body, signal })`: `credentials: 'include'`, JSON, headers
  `x-scout-tenant`, `x-correlation-id` (new id per request), `Idempotency-Key` on POST; problem+json
  → `ApiError { status, title, detail, code, ref }`; 401 → `UnauthorizedError`.
- [ ] Today's backend: `/v1/me` returns `tenant`, `kind`, `id`, `scopes`, `dataLimit`, `sourceId`,
  `environment` in snake_case. Type exactly what it returns; anything the shell needs that it lacks
  (person name, workspaces list, badges) is read defensively and listed in the report as a gap
  (api-gaps.md tenancy).
- [ ] Sign-in: `POST /api/auth/sign-in/social` `{ provider: 'microsoft', callbackURL }` and follow the
  returned URL; dev sign-in through `/api/dev/sign-in` when available. Sign-out
  `POST /api/auth/sign-out`.
- [ ] Tests: headers set, problem+json mapped, 401 typed, format functions with tenant currency and
  timezone.
- [ ] Commit `feat(web-ui): API client, auth and formatting`.

### Task 4: Router, shell and sign-in

**Files:** `web-ui/src/router.tsx`, `web-ui/src/app/` (Shell, Sidebar, Header, WorkspaceSwitcher,
ProfileMenu, nav config, RequireSession), `web-ui/src/routes/` (signin, tenant layout, placeholders,
admin layout, not found), tests.

- [ ] Routes: `/signin?return=`, `/t/$tenant/` (landing redirect), `/t/$tenant/queue`, `my`,
  `accounts`, `accounts/$id`, `overview`, `sources`, `batches`, `offers`, `playbooks`, `funnel`,
  `costs`, `settings/$tab`, `profile`; `/admin/tenants`, `/admin/health`, `/admin/ai-runs`; `/` →
  last workspace or `/signin`. Placeholders show the screen title, its screens.md section and its
  release tag from the spec.
- [ ] Nav config is data: group, label, path, permission (index.md Shell table). Sidebar renders
  only items whose permission is in `me.scopes` (platform admin items need the platform-admin flag;
  until `/me` carries it, hide them and note the gap).
- [ ] Landing: first visible of Review queue, My accounts, All accounts.
- [ ] Workspace switcher lists workspaces when `/me` provides them, else shows the current one only;
  switching navigates and clears the query cache.
- [ ] Header: search input (placeholder "Search accounts, people and batches", `/` focuses it; no
  results yet), CRM sync indicator hidden until an endpoint exists.
- [ ] Sign-in screen per screens.md §1: `Continue with Microsoft`, dev list when available, error
  messages for the sign-in error codes; return path honoured.
- [ ] Tests: hidden nav items, landing redirect, 401 to sign-in with return path, workspace switch
  clears cache, sign-in error copy.
- [ ] Commit `feat(web-ui): router, shell and sign-in`.

### Task 5: Verify

- [ ] In `web-ui/`: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` all pass.
- [ ] Root: `npm run typecheck` and `npm run lint` still pass.
- [ ] Smoke: with the backend on 4240 (`npm run dev` at the root) and `npm run dev` in `web-ui/`,
  sign in with dev sign-in and see the shell for a seeded workspace. If the backend is not running,
  say so in the report; do not start anything that touches the user's dev database beyond reading.
