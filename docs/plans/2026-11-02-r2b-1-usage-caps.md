# R2b-1: usage caps

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every paid or rate-limited outside service has a usage limit. Scout warns owners at 80% and stops calling the service at 100%. Owners can raise the limit or allow going over it until the period resets. A job refused by a limit waits instead of failing.

**Architecture:** The integrations module owns limits.
- **Tables:** `usage_cap` (one per provider) and `usage_period` (counts per period).
- **Atomic check:** `checkCap` locks the period row.
- **Gateway:** before each call, `gateway.call` reserves the expected units. It refuses with `blocked_by_cap` when the reservation would pass the limit. After the call it settles to the actual units.
- **Warnings:** crossing 80% or 100% publishes `integrations.usage.threshold_reached`, once per level per period.
- **Waiting jobs:** the platform worker treats a `blocked_by_cap` refusal as a wait. The job is put back without using up a run.
- **Web UI:** the Integrations tab gets a warning banner, and the Manage panel gets a Usage limit section.

**Tech Stack:** TypeScript, Hono, Drizzle, Postgres (RLS, one database per workspace), outbox + NATS, vitest, React 19 + TanStack Query, msw, Playwright.

**Spec:** docs/spec/integrations/usage-caps.md (INT-E4), docs/spec/enrichment/credits-costs-and-caps.md (ENR-E3-S2-AC4, atomic check), docs/spec/integrations/adapter-contract-and-providers.md, docs/spec/architecture/event-catalog.md (`integrations.usage.threshold_reached`), docs/spec/web-ui/screens.md §21b. Code map: docs/plans/2026-11-02-r2b-1-usage-caps.map.md (sections 1, 2, 5, 6, 7, 10).

## Rulings (user answers 2026-11-02 marked; the rest are Claude's calls; Task 6 writes them into the specs)

1. **(User) In-app notices only.** A notice is:
   - a banner on Settings, Integrations;
   - the level on the service's Manage panel;
   - the `integrations.usage.threshold_reached` event.

   Email comes later, when Scout sends email.
2. **One limit per provider.** Each provider gets one limit, on its connection, scoped by `provider_key`. The defaults are lazily ensured the first time a tenant's caps are read or checked:

   | Provider | Limit | Unit | Period |
   |---|---|---|---|
   | `apollo` | 2,000 | credits | month |
   | `vibe` | 1,000 | credits | month |
   | `anthropic` | 20,000 | cost_cents | month |
   | `hubspot` | 50,000 | calls | day |

   Providers without a default have no limit.
3. **API-key limits are not in this plan.** Arrival limits stay on sources, as built (`source.daily_arrival_cap`). `api_key.monthly_enrichment_credit_cap` (default 0) is enforced in R2b-2, where keys could start spend. `api_key.daily_arrival_cap` stays unread, and the spec records the divergence.
4. **Periods use the tenant's timezone** (`tenantTimezone`). A day starts at local midnight, and a month starts on the 1st at local midnight. The reset is the start of the next period. Calls today on Integrations also uses the tenant's day.
5. **Units per call.**
   - Unit `calls`: every call counts 1.
   - Unit `credits`: counts the call's `units` when its `unit` is `credits`.
   - Unit `cost_cents`: counts the call's `costCents`. The reservation is `opts.reserveCents`; the AI runner passes `worstCaseCents`.
   - Mock calls count units the same way, so limits work locally. Their `costCents` is 0, as today.
6. **Reserve, then settle.** A reservation is committed in its own transaction before the call. The settle step runs with the call log after the call, success or not: `used += actual`, `reserved -= reservation`. A process that dies in between leaves the reservation until the period ends, which is accepted. Two concurrent reservations that together pass the limit: the second is refused (ENR-E3-S2-AC4).
7. **Levels.** `warn` at `used + reserved ≥ 80%` of the limit. `blocked` when a reservation would pass 100%, or once settled usage reaches 100%. Each level publishes `integrations.usage.threshold_reached` `{providerKey, unit, period, periodStart, level, used, limit, resetsAt}` once per period, using flags on `usage_period`.
8. **Refusal.** A refused call writes a `call_log` row with outcome `blocked_by_cap` and makes no outside call. It throws `ScoutError` with slug `blocked_by_cap`, status 429, `extensions.resets_at`, and a `retry-after` header. The AI runner already falls back to rules on this slug.
9. **Owner actions** need `integrations:manage` and are people only:
   - `PUT /api/v1/integrations/{key}/cap {limit}` sets the limit: a whole number of 1 or more. Audit `integrations.cap.set` with before and after.
   - `POST /api/v1/integrations/{key}/cap:allow-overage` lets the service go over its limit until the current period resets. It sets `overage_period_start` to the current period start; `warn` still shows. Audit `integrations.cap.overage`.
   - Raising the limit or allowing overage takes effect for the next reservation.
10. **Waiting jobs (INT-E4-S3-AC2).** The worker catches `ScoutError` slug `blocked_by_cap` thrown by any job or consumer. It puts the message back with delay `min(resets_at − now, 15 minutes)`, and the run is not counted toward `maxDeliver`, the same as a closed workspace. So a raised limit resumes the work within 15 minutes, and a reset resumes it on time.
11. **Deferred.** The usage page (INT-E4-S4) moves to R3a (Costs). `integrations.usage.recorded` moves to R3a, where analytics first consumes it. `call_log` already holds every unit and cent.

## Global Constraints

- **Exact copy, Integrations (§21b).**
  - Warn banner: "{name} has used {pct}% of its {daily|monthly} limit."
  - Block banner: "{name} reached its {daily|monthly} limit. Scout stopped calling it until {reset date}."
  - Overage banner: "{name} is allowed over its limit until {reset date}."
  - Banners list one line per provider, blocked first. `{pct}` is rounded down. `{reset date}` reads like "Dec 1" (month) or "Nov 3" (day), in the tenant's timezone.
- **Exact copy, Manage panel "Usage limit" section.**
  - Usage line: "{used} of {limit} {unit} today." or "… this month.", then " Resets {reset date}."
    - Units: "calls" and "credits". For cost_cents, money in the tenant currency: "$12.40 of $200.00 this month. Resets Dec 1."
    - A bar shows used ÷ limit, in amber at warn and red at blocked.
  - Input label "Limit per {day|month}" and button `Save limit`. Toast "Limit saved." Error "Enter a whole number of 1 or more."
  - When blocked: `Allow until {reset date}`, with toast "{name} can go over its limit until {reset date}."
  - No limit: "No limit."
- **Integrations row.** "Calls today" keeps "{n} of {cap}/day" only for a daily calls limit (`calls_today_cap`), and "{n}" otherwise.
- **API error.** 429 `blocked_by_cap`: title "{name} reached its {daily|monthly} limit.", detail "An owner can raise it in Settings, Integrations.", `extensions.resets_at`.
- **Migrations.** Next integrations migration is `0002_usage_caps.sql`; check `meta/_journal.json`. Tables:
  - `usage_cap`: `tenant_id`, `provider_key`, `unit`, `period`, `limit` bigint, `overage_period_start` date null, `updated_by` text null, `updated_at`. PK (`tenant_id`, `provider_key`).
  - `usage_period`: `tenant_id`, `provider_key`, `period_start` date, `used` bigint default 0, `reserved` bigint default 0, `warned` bool, `blocked` bool. PK (`tenant_id`, `provider_key`, `period_start`).
  - Both tables get `ENABLE` + `FORCE ROW LEVEL SECURITY` and the `tenant_isolation` policy (copy from an existing module migration).
- **Events** are `defineEvent(type, 1, zod)` in `src/modules/integrations/contracts/events.ts`, published through the outbox. Publish from the reserve or settle transaction.
- **Web UI** uses `apiFetch`. Invalidate `['integrations', tenant]` by prefix after cap changes.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Two concurrent reservations** that each fit but together pass the limit: one succeeds and one is refused. Test in Task 1 with two parallel transactions.
2. **A month boundary in a non-UTC timezone.** A tenant in `America/New_York` at 2026-12-01 03:00 UTC is still in November; at 05:01 UTC it is a new period with zero used. Test in Task 1 (pure period math, plus one service test).
3. **A call that throws after reserving.** The reservation is released, and `used` adds only what was measured (0 on error). Test in Task 2.
4. **A job refused by a limit.** It isn't dead-lettered after `maxDeliver` refusals, and it runs once the limit is raised. Test in Task 3.
5. **Overage allowed, then the period resets.** The next period blocks again at 100%. Test in Task 1.

---

### Task 1: Limit storage, periods and `checkCap`

**Files:**
- Create: `src/modules/integrations/domain/caps.ts` (pure), `src/modules/integrations/services/caps.ts`, migration `0002_usage_caps.sql` (+ meta)
- Modify: `src/modules/integrations/db/schema.ts`, `contracts/events.ts`, `index.ts`
- Test: `tests/unit/integrations/caps.test.ts`, `tests/integration/integrations/caps.test.ts`

**Interfaces:**
- Produces (domain):
  - `periodBounds(period: 'day'|'month', now: Date, timeZone: string): {start: string /* YYYY-MM-DD local */, resetsAt: Date}`;
  - `levelOf(used, reserved, limit, overage: boolean): 'ok'|'warn'|'blocked'`;
  - `DEFAULT_CAPS`.
- Produces (services, exported from `@/modules/integrations`):
  - `listCaps(ctx): Promise<CapView[]>`, where `CapView = {providerKey, unit, period, limit, used, reserved, level, resetsAt, overage: boolean}`;
  - `reserve(ctx, providerKey, amount): Promise<{reservationId: string|null /* null = no cap */, level}>`. Throws the Ruling 8 ScoutError when blocked; publishes threshold events.
  - `settle(ctx|tx, reservation, actual): Promise<void>`;
  - `checkCap(ctx, providerKey, amount): Promise<{status: 'ok'|'warn'|'blocked', used, limit, resetsAt}>`. This is the read-only check for callers such as ENR estimates.
  - `setCapLimit(ctx, providerKey, limit)` and `allowOverage(ctx, providerKey)`, both audited.
  - Event `usageThresholdReached`.
- [ ] **Step 1: Failing unit tests.**
  - `periodBounds` for day and month in UTC, `America/New_York` (Review Focus 2) and `Asia/Kolkata`.
  - `levelOf`: 79% is ok, 80% is warn, a reservation over the limit is blocked, overage stops blocking.
- [ ] **Step 2: Failing integration tests.**
  - Lazily ensured defaults are listed.
  - Reserve and settle update used.
  - Concurrent reservations: one is refused (Review Focus 1).
  - The warn event is published once per period.
  - Block publishes once.
  - `setCapLimit` validates and is audited.
  - Overage resets with the next period (Review Focus 5).
- [ ] **Step 3: Implement.** Lock the `usage_period` row: insert on conflict do nothing, then `select … for update`. **Step 4: Run** `npx vitest run tests/unit/integrations tests/integration/integrations`. **Step 5: Commit** `feat(integrations): usage limits with atomic reservations`.

### Task 2: Gateway enforcement, AI reservation, Calls today

**Files:**
- Modify: `src/modules/integrations/gateway.ts` (`CallOpts.reserveCents?`, reserve before the adapter call, settle in the call-log transaction, `blocked_by_cap` log row), `src/modules/ai-tasks/runner.ts` (pass `reserveCents: worstCaseCents(...)`), `src/modules/integrations/services/overview.ts` (`callsTodayCap` from a daily calls limit; calls today in the tenant's day; add `cap: CapView | null` to each integration view)
- Test: `tests/integration/integrations/gateway-caps.test.ts`, update `gateway.test.ts` and the overview tests

- [ ] **Step 1: Failing tests.**
  - A call over the limit makes no adapter call, logs `blocked_by_cap`, and throws 429 with `resets_at`.
  - A call that throws releases its reservation (Review Focus 3).
  - Unit matching follows Ruling 5. A credits limit ignores a call whose unit isn't credits; a calls limit counts every call.
  - The AI task falls back to rules when anthropic is blocked.
  - Overview: `calls_today_cap` is 50000 for hubspot, and Calls today counts from the tenant's local midnight.
- [ ] **Step 2: Implement.** **Step 3: Run** `npx vitest run tests/integration/integrations tests/integration/ai-tasks tests/integration/crm`. **Step 4: Commit** `feat(integrations): the gateway stops calls at the limit`.

### Task 3: Jobs wait on a limit

**Files:**
- Modify: `src/platform/runtime/worker.ts`
- Test: `tests/integration/platform/` (the worker tests that cover Busy and closed workspaces; add one for `blocked_by_cap`)

- [ ] **Step 1: Failing test.**
  - A job whose handler throws `blocked_by_cap` 10 times is never dead-lettered, and its run count stays 0.
  - The nak delay is `min(resets_at − now, 15 min)`.
  - After the handler stops refusing, the job runs once (Review Focus 4).
- [ ] **Step 2: Implement.** Undo the counted run for that delivery, the way the workspace-closed path never counts one. **Step 3: Run** the platform worker tests. **Step 4: Commit** `feat(platform): jobs refused by a usage limit wait`.

### Task 4: HTTP

**Files:**
- Create: `src/http/routes/v1/integrations/[key]/cap/route.ts` (PUT, and POST `:allow-overage`)
- Modify: the integrations list/read routes to include `cap`, and `src/http/routes.ts`
- Test: `tests/integration/v1/integrations.test.ts` (or a new `integration-caps.test.ts`)

**Interfaces:**
- `GET /api/v1/integrations` rows gain `cap {unit, period, limit, used, level, resets_at, overage}` or null.
- `PUT /api/v1/integrations/{key}/cap` `{limit}` returns the new `cap`.
- `POST /api/v1/integrations/{key}/cap:allow-overage` returns the `cap`.
- Both need `integrations:manage` and are people only.
- [ ] **Step 1: Failing tests.**
  - Owner PUT is 200 and audited.
  - Limit 0 or 2.5 gives 400 "Enter a whole number of 1 or more."
  - Seller is 403.
  - Agent key is 403.
  - Allow-overage clears the blocked level.
  - An unknown key is 404.
- [ ] **Step 2: Implement.** **Step 3: Run** `npx vitest run tests/integration/v1`. **Step 4: Commit** `feat(http): integration usage limits`.

### Task 5: Web UI

**Files:**
- Modify: `web-ui/src/features/settings/integrations/{api.ts, words.ts, IntegrationsTab.tsx, ManagePanel.tsx}` plus their tests
- Create: `UsageLimit.tsx` in the same folder

- [ ] **Step 1: Failing tests.**
  - The banner shows warn, blocked and overage lines with the exact copy, blocked first.
  - There is no banner when everything is ok.
  - The Manage panel shows the usage line, including the money form for anthropic.
  - Editing the limit saves and shows the toast.
  - An invalid limit shows the error and sends nothing.
  - When blocked, `Allow until {date}` posts and shows its toast.
  - "No limit." shows for a provider without a limit.
- [ ] **Step 2: Implement.** **Step 3: Run** `cd web-ui && npx vitest run src/features/settings/integrations`, then the full web-ui suite. **Step 4: Commit** `feat(web-ui): usage limits on Integrations`.

### Task 6: Specs, end-to-end, full suites

**Files:**
- Modify:
  - `docs/spec/integrations/usage-caps.md` (Rulings 1-11; R2b-1 shipped; the usage page moves to R3a);
  - `docs/spec/integrations/index.md`, if it lists tables;
  - `docs/spec/enrichment/credits-costs-and-caps.md` (`checkCap` shape);
  - `docs/spec/architecture/event-catalog.md`;
  - `docs/spec/web-ui/screens.md` §21b (Usage limit section and banners);
  - `docs/spec/web-ui/api-gaps.md` (rows for the cap routes; "Calls today (n of cap/day)" READY).
- Create: `tests/e2e/usage-caps.spec.ts`

- [ ] **Step 1: E2E.** As the owner, open Settings, Integrations, then Manage HubSpot. The panel shows "… of 50,000 calls today. Resets …". Set the limit to 1. Trigger one HubSpot call (Test connection, which goes through the gateway). Then the banner shows "HubSpot reached its daily limit." Use `Allow until` and the banner changes to the overage line. Afterwards, set the limit back to 50000.
- [ ] **Step 2: Full suites.** `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run test:int`, `cd web-ui && npm test`, `npm run e2e`. All must be green; the known per-workspace `afterAll` timeout must be confirmed on main.
- [ ] **Step 3: Commit** `docs(spec): R2b-1 usage caps` and `test(e2e): usage limits`.
