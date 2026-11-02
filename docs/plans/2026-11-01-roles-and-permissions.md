# Roles and Permissions (Decision 17) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every workspace can edit what each role may do, and a read-only Viewer role exists.

**Architecture:** Role defaults stay in code (`ROLE_PERMISSIONS`). A workspace's changes live in
`tenancy.role_permission`, one row per tenant and role; a role with no row uses the default.
`permissionsFor` takes the workspace's role sets, and every caller loads them. `PUT /api/v1/roles/{role}`
saves one role and drops the instance's cached principals for the workspace. The web-ui matrix becomes
editable.

**Tech Stack:** TypeScript, Drizzle (tenancy schema, RLS), Hono routes, React + TanStack Query, Vitest, MSW.

**Spec:** `docs/spec/tenancy-and-access/roles-and-data-scopes.md` ("Roles", "Editable roles per
workspace", TEN-E3-S5); screens: `docs/spec/web-ui/screens.md` §21a; decision: `docs/spec/web-ui/api-gaps.md`
Decision 17.

## Global Constraints

- Owner always holds every permission; `PUT /api/v1/roles/owner` is 409 `role-locked`.
- Viewer defaults: `accounts:read`, `offers:read`, `analytics:read`, `status:read`; data limit `all`.
- A non-owner, non-platform-admin editor may add or remove only permissions they hold: 403
  `permission-not-yours` (same slug and detail as the existing extras check in `services/members.ts`).
- `PUT /api/v1/roles/{role}` needs `members:manage` and a person (not an API key); `GET` needs `members:read`.
- Toast copy: "Permissions saved. They apply the next time each member loads a page."
- Matrix copy: "Taazaa platform admins can act in every workspace. They aren't a role here."
- Audit action: `tenancy.role.permissions_changed` with `{ role, added, removed }`.
- Modules talk only through `index.ts`; nothing outside tenancy reads `role_permission`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A role saved in workspace A must not change anyone in workspace B (RLS plus `tenant_id` in every query).
2. An editor without `keys:manage` adding `keys:manage` to Operator, then being given Operator by an owner,
   is the owner's choice; but the editor alone must never gain a permission. Test: a leader-with-
   `members:manage` cannot add a permission they lack to any role, including their own.
3. After a save, the same server instance must serve the new set on the next request (cache drop), not up
   to 60 s later. Test with the principal cache TTL at its real value.
4. A role row holding a permission that later leaves `PERMISSIONS` must not crash: unknown strings are
   dropped on read (`isPermission`).
5. `PUT` with an empty list is allowed for every role but Owner (a role can do nothing); duplicates are
   collapsed; unknown permissions are 400 `invalid-permission`.

---

### Task 1: Viewer role and role sets in the domain

**Files:**
- Modify: `src/modules/tenancy/contracts/members.ts` (add `'viewer'` to `ROLES`)
- Modify: `src/modules/tenancy/domain/permissions.ts`
- Modify: `src/modules/tenancy/domain/data-limit.ts` (viewer default `all`)
- Modify: `src/modules/tenancy/index.ts` (export `RoleSets`, `roleSet`)
- Test: `tests/unit/tenancy/permissions.test.ts` (create or extend the existing one)

**Interfaces:**
- Produces: `type RoleSets = Partial<Record<Role, readonly Permission[]>>`;
  `roleSet(role: Role, sets: RoleSets): Permission[]` (owner always `PERMISSIONS`; else `sets[role]`
  filtered by `isPermission`, else `ROLE_PERMISSIONS[role]`);
  `permissionsFor(role: Role, extra: Permission[], platformAdmin: boolean, sets: RoleSets = {}): Permission[]`.

- [ ] Step 1: tests: viewer default is exactly the four permissions; `roleSet('owner', { owner: [] })` is all
  permissions; `roleSet('seller', { seller: ['accounts:read', 'nope' as never] })` is `['accounts:read']`;
  `permissionsFor('seller', ['review:act'], false, { seller: ['accounts:read'] })` is
  `['accounts:read', 'review:act']` in `PERMISSIONS` order; `defaultDataLimit('user', 'viewer')` is `{ kind: 'all' }`.
- [ ] Step 2: run, see them fail. Step 3: implement. Step 4: `npm run typecheck` and the unit tests pass
  (fix any exhaustive `Record<Role, …>` the new role breaks, e.g. in seed or labels).
- [ ] Step 5: commit `feat(tenancy): add the Viewer role and per-workspace role sets`.

### Task 2: `role_permission` table and the role service

**Files:**
- Modify: `src/modules/tenancy/db/schema.ts` (table `rolePermission`)
- Create: `src/modules/tenancy/db/migrations/0005_role_permission.sql` (generate with the repo's drizzle
  command for tenancy, then add the RLS lines in the style of `0004_member_preference.sql`)
- Create: `src/modules/tenancy/services/roles.ts`
- Modify: `src/modules/tenancy/index.ts`
- Test: `tests/integration/tenancy/roles.test.ts`

**Interfaces:**
- Table: `tenancy.role_permission(tenant_id text, role text, permissions text[] not null, updated_by text,
  updated_at timestamptz default now(), primary key (tenant_id, role))`, RLS `tenant_isolation`.
- Produces: `loadRoleSets(ctx: ModuleContext): Promise<RoleSets>`;
  `listRoles(ctx): Promise<RoleView[]>` with `RoleView = { role: Role; permissions: Permission[];
  defaultPermissions: Permission[]; customised: boolean; locked: boolean }` in `ROLES` order;
  `setRolePermissions(ctx, actor: Principal, role: Role, permissions: Permission[]): Promise<RoleView>`.
- `setRolePermissions`: owner → 409 `role-locked` ("The Owner role always has every permission.");
  dedupe; diff against the current set; for a non-owner, non-platform-admin actor every added or removed
  permission must be in the actor's permissions (403 `permission-not-yours`); upsert the row (a list equal
  to the default deletes the row, so `customised` is false again); audit `tenancy.role.permissions_changed`
  `{ role, added, removed }` (skip audit and write when nothing changed); after commit call
  `forgetAccess({ tenantId })` (see how `services/members.ts` and tenant suspend defer work to after commit,
  and do the same).

- [ ] Step 1: integration tests (two tenants): save Seller in A, A's `listRoles` shows it `customised`, B's
  doesn't; owner save 409; leader-with-`members:manage` adding `keys:manage` 403, removing a permission they
  hold works; saving the default list makes `customised` false; unchanged save writes no audit row;
  a row holding `'gone:perm'` (raw SQL insert) reads back without it.
- [ ] Step 2: fail. Step 3: implement plus migration. Step 4: pass (`npm run test:integration -- roles`
  or the repo's equivalent). Step 5: commit `feat(tenancy): store role permissions per workspace`.

### Task 3: Effective permissions read the workspace's sets

**Files:**
- Modify: `src/modules/tenancy/services/principal.ts` (`loadAccess`: left join `role_permission` on tenant
  and membership role, select its `permissions`; pass `{ [role]: rolePerms }` to `permissionsFor`)
- Modify: `src/modules/tenancy/services/members.ts` (each `permissionsFor` call, including
  `assertRoleGrantable` and the "who can respond to assignments" filter, passes `await loadRoleSets(ctx)`,
  loaded once per service call)
- Test: `tests/integration/tenancy/roles.test.ts` (extend), `tests/integration/v1/members.test.ts`

- [ ] Step 1: tests: after A removes `accounts:read` from Seller, a seller session's principal (real cache
  TTL, same process) lacks it on the next call; member list shows the new effective set; a seller given
  `assignments:respond` back via the role appears in the assignable directory; giving the Viewer role is
  allowed to a leader-with-`members:manage` only if they hold the viewer set.
- [ ] Step 2-4: fail, implement, pass. Step 5: commit `feat(tenancy): effective permissions use the workspace's roles`.

### Task 4: Roles API

**Files:**
- Modify: `src/http/routes/v1/roles/route.ts` (GET from `listRoles`, snake_case:
  `roles: [{ role, permissions, default_permissions, customised, locked }]`, plus `permissions` as today)
- Create: `src/http/routes/v1/roles/[role]/route.ts` (`PUT`, body `{ permissions: string[] }` zod; unknown
  role 404 `role-not-found`; non-permission strings 400 `invalid-permission`; people only, `members:manage`)
- Modify: `src/http/routes.ts`, `tests/unit/http/routes.test.ts`
- Test: `tests/integration/v1/roles.test.ts`

- [ ] Step 1: tests: GET shape with Viewer column; PUT seller 200 returns the role view; PUT owner 409;
  PUT by an API key 403; PUT without `members:manage` 403; unknown permission 400; unknown role 404; the
  route table test lists `PUT /api/v1/roles/{role}`.
- [ ] Step 2-4. Step 5: commit `feat(api): edit role permissions`.

### Task 5: Editable matrix and the Viewer role in the web-ui

**Files:**
- Modify: `web-ui/src/features/settings/members/api.ts` (types for the new GET; `useSaveRole` mutation,
  `PUT /roles/{role}`, invalidates `rolesQuery` and the members list)
- Modify: `web-ui/src/features/settings/members/RolesMatrix.tsx`
- Modify: `web-ui/src/features/settings/members/words.ts` (Viewer: label "Viewer", about
  "Read-only pipeline and scorecard.")
- Modify: invite role cards and the member drawer role select if they hard-code roles (they should list
  `ROLES` from the roles query)
- Test: `web-ui/src/features/settings/members/roles-matrix.test.tsx`

Behaviour: with `members:manage` each cell is a checkbox labelled "{permission} for {role}"; the Owner
column shows ticks, disabled, with "Owner always has every permission." as the column's description;
cells for permissions the viewer lacks are disabled unless they are an owner or platform admin (from
`/me`). A draft holds edits; `Discard` drops it; `Restore defaults` sets the draft to every role's
`default_permissions`; `Save permissions` (enabled only with changes) PUTs each changed role, then
toasts the copy above. A failed PUT shows the API's `detail` and keeps the draft. Without
`members:manage` the matrix stays read only, as today. "Customised" chip on a column whose role is
`customised`.

- [ ] Step 1: tests: Viewer column renders; toggle a Seller cell, Save → PUT body is Seller's new list and
  the toast shows; Owner checkboxes disabled; Restore defaults then Save PUTs the defaults; Discard
  restores; a 403 shows its detail; read only without `members:manage`.
- [ ] Step 2-4 (`cd web-ui && npm test`, `npm run build`). Step 5: commit `feat(web-ui): edit roles and permissions`.

### Task 6: Docs and local verify

**Files:**
- Modify: `docs/spec/web-ui/api-gaps.md` (§21a rows "Matrix editable, Viewer role" → READY with the
  endpoints; Decision 17 status line), `docs/spec/web-ui/screens.md` §21a tag (drop "Redesign, roles plan")
- [ ] Step 1: full suite: `npm run typecheck && npm run lint && npm test`, `cd web-ui && npm test && npm run build`,
  `npm run e2e`.
- [ ] Step 2: rebuild `scout-verify`, migrate, and in the browser: edit Seller, save, see the toast; sign in
  as the seeded seller and see the change.
- [ ] Step 3: commit `docs: roles and permissions are editable`.
