# Data conventions

## Tenancy

- Every table in every module schema has `tenant_id` (not null), and every query filters by it.
- Services get the tenant from `ModuleContext`, built from the signed-in user's membership or the API
  key / OAuth grant. Never from a request body.
- Postgres row-level security is turned on for every tenant table as a second line of defence: the
  connection sets `app.tenant_id` per transaction and policies compare against it. Platform-admin and
  cross-tenant jobs use a separate role that bypasses RLS and is logged.
- An integration test per module proves a row from tenant A cannot be read or written as tenant B.

## Ids

- Primary keys are ULIDs stored as text with a type prefix, so ids are readable in logs, URLs and
  agent conversations: `t_` tenant, `usr_` user, `key_` API key, `src_` source, `arr_` arrival,
  `bat_` batch, `acc_` account, `per_` person, `fct_` fact, `sig_` signal, `off_` offer, `prc_`
  practice, `plb_` playbook, `pln_` account plan, `stp_` step, `asg_` assignment, `hof_` handoff,
  `cst_` cost line, `evt_` event, `run_` AI run, `con_` integration connection, `enr_` enrichment
  request, `hbt_` handoff batch, `mts_` message test, `stm_` statement, `scn_` funnel scenario,
  `mtg_` meeting, `tch_` meeting touch, `imp_` file import, `map_` saved column mapping, `wi_` warm
  intro, `cfl_` conflict, `srch_` saved search, `sr_` signal rule, `om_` offer match, `scc_` score
  change, `rsd_` review status definition, `rsc_` review status change, `stc_` stage change, `drd_`
  decline reason definition, `fb_` source feedback.
- API JSON uses `snake_case` field names; TypeScript code uses camelCase and converts at the edge.
- Outside systems' ids are stored as `(system, external_id)` pairs, never as our primary key.

## Values

- Money: integer minor units (cents) plus the tenant's currency. Never floats.
- Rates and probabilities: decimals (0.05, not 5).
- Scores: integers 0 to 100 unless a spec says otherwise.
- Time: `timestamptz`, stored UTC; displayed in the tenant's timezone.
- Text: UTF-8 everywhere.
- Enums that tenants can configure (review statuses, buying roles, decline reasons) are rows in a
  settings table with a stable `key`, not database enums.

## Provenance

- Any value that came from outside (a fact, a signal, a person's email) records `source_id`,
  `arrival_id` (when it came in an arrival), `observed_at` and `recorded_at`.
- Arrivals are stored exactly as received, as JSON, and never modified (D13).
- Human edits record who and when; AI-written text records the AI run id.

## Changes and deletion

- Business records are archived (`archived_at`), not deleted, unless a tenant asks to delete data.
- Merges (duplicate accounts or people) keep the losing id as an alias and publish a `merged` event.
- Tenant data deletion is a platform-admin action that removes every row with that `tenant_id` across
  all schemas and purges its NATS subjects; it is logged outside the tenant.

## Migrations

- drizzle-kit generates SQL per module into `src/modules/<m>/db/migrations/`; files are committed and
  reviewed. A single migration runner applies all modules in dependency order at deploy.
- No `db push` in shared environments.
