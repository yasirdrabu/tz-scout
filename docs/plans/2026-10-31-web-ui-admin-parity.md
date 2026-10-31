# Web UI admin parity Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The new app replaces the old Next.js admin app. Every screen the old pages serve
(sign-in, Tenants, System health, Members, Integrations, AI, Audit, Profile) works in `web-ui/`
against `/v1` endpoints, and the old pages, their server actions and `src/components` are deleted.

**Architecture:** Backend first, module by module: each server action and direct service call the
old pages use gets a `/v1` endpoint in the module that owns it, plus the `/me` and no-tenant session
changes the shell needs. Then the `web-ui` screens, built from `docs/spec/web-ui/screens.md`. Then
the old pages go. The HTTP layer stays on Next.js in this plan (its move is a separate plan); the
paths stay `/v1` and move with that plan.

**Tech Stack:** backend as today (Next route handlers via `v1Route`, modules, Drizzle, Vitest
integration tests on throwaway databases); `web-ui` as built by the foundation plan.

**Spec:** `docs/spec/web-ui/index.md`, `screens.md` §1, §21a, §21b, §21c, §21g, §22 (R1 part), §23,
§24, §25, and `docs/spec/web-ui/api-gaps.md` (sections tenancy, integrations, ai-tasks, platform:
the tables and "Proposed changes"; "Decisions taken" 14, 17, 18, 19, 20, 23, 24 are binding).

## Global Constraints

- Module boundaries as `docs/spec/architecture/module-boundaries.md`: routes call a module's
  `index.ts` only; new logic lives in the owning module's `services/` (pure rules in `domain/`).
- Every new endpoint goes through `v1Route` (or the new session route below) with an explicit
  permission, problem+json errors, snake_case JSON, and an integration test covering success, the
  permission refusal and one validation error.
- Never touch the user's `.env` or dev `scout` database; tests use their own throwaway databases as
  the suite already does.
- Copy in the app follows screens.md exactly; no em dashes.
- Scope boundary: login history, the API key access log (Decision 20), the editable roles matrix and
  Viewer (Decision 17) and the per-tenant infrastructure (Decision 23) are NOT in this plan; their
  screens show the spec's empty or read-only states. They get their own plans.
- Commit after each task with a conventional message ending in the Co-Authored-By line.

## Review Focus

1. A platform admin with no membership can load `/admin/*` (no tenant), and nobody else can.
2. Cookie-authenticated writes without `x-scout-tenant` (admin routes) still pass the CSRF check,
   and a cross-site write is still refused.
3. Every old server action has an endpoint with the same permission check it had.
4. Nothing in `src/` imports the deleted pages or components; the e2e suite is updated, not skipped.
5. An owner cannot be suspended or removed, and nobody can change their own role (screens.md §21a).

---

### Task 1: Session for the shell (tenancy, http)

- [ ] `GET /v1/me` adds: `user { id, name, email, platform_admin }`, `workspaces [{ slug, name,
  member_count, role }]`, `tenant { ..., currency, timezone }`, and for a platform admin the full
  permission set they effectively hold in the current tenant.
- [ ] A no-tenant session route wrapper (`sessionRoute`) for endpoints that need a signed-in person
  but no workspace; `GET /v1/me` works through it when there is no tenant (returns `tenant: null`,
  `workspaces`, `user`). Platform-admin routes use an `adminRoute` built on it.
- [ ] CSRF: cookie writes on admin routes are checked by origin without requiring
  `x-scout-tenant`.
- [ ] `PUT /v1/me/workspace { slug }` writes `user.last_tenant_id`.
- [ ] `GET /v1/me/counts`: `review_queue` (with `review:act`), `new_assignments` (with
  `assignments:respond`).
- [ ] `GET /v1/auth/config` (public): enabled sign-in methods, `dev_sign_in` flag; `GET
  /v1/dev/users` when dev sign-in is on. Sign-in failures redirect to `{APP_PUBLIC_URL}/signin?error=
  <code>` with a validated return path.
- [ ] Operators get `review:act` by default (W6).
- [ ] Tests for each.

### Task 2: Members, API keys, audit, profile (tenancy)

- [ ] Members: `GET /v1/members` (with name, email, role, status, last active, sign-in method,
  practice access), `POST /v1/members` (invite: emails, role, practice access; R1 invite per
  Decision 18), `PATCH /v1/members/{id}` (role, practice access; owner and self rules),
  `POST /v1/members/{id}:suspend`, `:reactivate`, `:sign-out-everywhere`, `DELETE
  /v1/members/{id}` (open accounts return to the queue as the current remove does). Add the
  `suspended` member status through sign-in and principal checks.
- [ ] Roles read-only: `GET /v1/roles` (each role with its permissions) for the matrix tab.
- [ ] API keys (Decision 14): `GET/POST /v1/api-keys`, `DELETE /v1/api-keys/{id}` under
  `keys:manage`; `GET/POST /v1/sources/{id}/keys` under `sources:manage`. The key is returned once.
- [ ] Audit: `GET /v1/audit` with search, area and who filters, cursor paging, person names
  resolved, IP recorded on new entries.
- [ ] Profile: `GET /v1/me/sessions`, `POST /v1/me:sign-out-everywhere`.
- [ ] Tests for each.

### Task 3: Integrations (integrations)

- [ ] `GET /v1/integrations` (one row per service: mode, status, last call, calls today with cap,
  average ms, credential label and last4), `PUT /v1/integrations/{key}/credential`,
  `POST /v1/integrations/{key}:test`, `PUT /v1/integrations/{key}/mode` (live needs a saved
  credential), `POST /v1/integrations/{key}:disconnect` (new service: clears the credential and
  returns to sample mode), `GET /v1/integrations/{key}/calls?errors_only=` (last 50), under
  `integrations:manage`.
- [ ] Tests for each.

### Task 4: Admin (tenancy, platform, ai-tasks)

- [ ] Tenants (R1 part of §22): `GET /v1/admin/tenants` (status, member count, seats if any,
  created), `POST /v1/admin/tenants` (name, slug rule, owner email, start with defaults or copy),
  `POST /v1/admin/tenants/{id}:suspend` and `:resume` (new service; suspended tenants refuse
  sign-in and API calls), platform admins list `GET/POST/DELETE /v1/admin/platform-admins`.
- [ ] System health: `GET /v1/admin/health` (relay lag, pending per queue with oldest, dead jobs,
  schedules), `POST /v1/admin/jobs/{id}:retry`, `:discard`, `POST /v1/admin/schedules/{name}:pause`,
  `:resume`, `:run-now`, `POST /v1/admin/test-event` (round trip ms).
- [ ] AI runs (Decision 24): `GET /v1/admin/ai-runs` cross-tenant with search, status (Succeeded,
  Failed, Stopped by limit), task and tenant filters, tokens, cost, time; tenant `GET /v1/ai-runs`
  for owners.
- [ ] All under `adminRoute`. Tests for each, including a non-admin refusal.

### Task 5: web-ui Settings and Profile screens

- [ ] Settings layout with the tab bar (tabs by permission) and screens §21a Members (members tab,
  member drawer, invite dialog, read-only roles tab, login history tab as its empty state), §21b
  Integrations (list, manage panel, test, mode confirm, last 50 calls, disconnect), §21c API keys
  (list, create two-step with key shown once, revoke confirm, access log drawer as empty state),
  §21g Audit log, §25 Profile. Uses `/me` fields from Task 1 (name in profile button, workspaces in
  the switcher, badges from `/me/counts`, currency and timezone into `lib/format`).
- [ ] Component tests with MSW for every action and state (ready, empty, loading, error).

### Task 6: web-ui Admin screens

- [ ] `/admin` shell for platform admins with no tenant; §22 Tenants (list, summary tiles that the
  API serves, new tenant panel, suspend and resume, platform admins list; infrastructure sections
  hidden), §23 AI runs, §24 System health (15 s refresh while visible).
- [ ] Component tests with MSW.

### Task 7: Retire the old pages

- [ ] Delete `src/app/admin`, `src/app/t`, `src/app/signin`, `src/app/page.tsx` UI (replace with a
  redirect to the app origin or a 404), `src/components`, `src/server/page-context.ts` and
  `src/server/action.ts` if nothing else uses them, and their styles and Tailwind config if unused.
- [ ] Update e2e (`tests/e2e/*.spec.ts`) to drive the new app (Playwright starts the backend and the
  `web-ui` dev server), or move UI flows into `web-ui/tests/e2e`; no skipped tests.
- [ ] Docs: `docs/spec/web-ui/index.md` C12 status line, README run instructions, CHANGELOG.
- [ ] Verify: root `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run e2e`;
  `web-ui` typecheck, lint, test, build.
